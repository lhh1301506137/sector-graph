# server/routes/sector_routes.py
# 鏉垮潡绠＄悊 + 鏁版嵁鍒锋柊璺敱

import asyncio
import os
import random
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

import httpx

from server.database import get_db
from server.models import Sector, DailyData, Config
from server.core.http_client import HttpClientProfile, build_http_profile, get_json, retry_async

router = APIRouter()

# ============================================================
# 鏂版氮API閰嶇疆
# ============================================================

SINA_API_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk"
SINA_HEADERS = {
    "Host": "vip.stock.finance.sina.com.cn",
    "Referer": "https://finance.sina.com.cn",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
}

DATA_SOURCE_NAME = "sina"
SOURCE_DISPLAY_NAMES = {
    "sina": "\u65b0\u6d6a\u8d22\u7ecf",
    "akshare": "AKShare",
    "eastmoney": "\u4e1c\u65b9\u8d22\u5bcc",
    "tushare": "TuShare",
}
SOURCE_CANDIDATES = ["sina", "akshare", "eastmoney", "tushare"]
SOURCE_RECOMMEND_ORDER = ["sina", "eastmoney", "akshare", "tushare"]

TUSHARE_PRO_URL = "http://api.waditu.com"

EASTMONEY_INDUSTRY_URL = "https://17.push2.eastmoney.com/api/qt/clist/get"
EASTMONEY_CONCEPT_URL = "https://79.push2.eastmoney.com/api/qt/clist/get"
EASTMONEY_HEADERS = {
    "Referer": "https://quote.eastmoney.com/center/boardlist.html",
    "User-Agent": SINA_HEADERS["User-Agent"],
}
EASTMONEY_INDUSTRY_FIELDS = (
    "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,"
    "f23,f24,f25,f26,f22,f33,f11,f62,f128,f136,f115,f152,f124,f107,f104,f105,"
    "f140,f141,f207,f208,f209,f222"
)
EASTMONEY_CONCEPT_FIELDS = (
    "f2,f3,f4,f8,f12,f14,f15,f16,f17,f18,f20,f21,f24,f25,f22,f33,f11,"
    "f62,f128,f124,f107,f104,f105,f136"
)


class TushareApiError(RuntimeError):
    def __init__(self, api_name: str, code: int, message: str):
        super().__init__(f"tushare api={api_name} code={code} msg={message}")
        self.api_name = api_name
        self.code = int(code)
        self.message = message


def _upsert_config(db: Session, category: str, key: str, value: str) -> None:
    item = db.query(Config).filter(
        Config.category == category,
        Config.key == key,
    ).first()
    if item:
        item.value = value
    else:
        db.add(Config(category=category, key=key, value=value))


def _get_config(db: Session, category: str, key: str, default: str = "") -> str:
    item = db.query(Config).filter(
        Config.category == category,
        Config.key == key,
    ).first()
    if not item or item.value is None or str(item.value).strip() == "":
        return default
    return str(item.value)


def _config_bool(v: str) -> bool:
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _to_float(raw, default: float = 0.0) -> float:
    try:
        if raw is None:
            return default
        if isinstance(raw, str):
            txt = raw.strip().replace("%", "").replace(",", "")
            if txt == "":
                return default
            return float(txt)
        return float(raw)
    except Exception:
        return default


def _to_int(raw, default: int = 0) -> int:
    try:
        if raw is None:
            return default
        if isinstance(raw, str):
            txt = raw.strip()
            if txt == "":
                return default
            return int(txt)
        return int(raw)
    except Exception:
        return default


def _split_quality_reasons(raw_reason: str) -> list[str]:
    if not raw_reason:
        return []
    return [part.strip() for part in str(raw_reason).split(";") if part.strip()]


def _append_quality_reason(reasons: list[str], reason: str) -> None:
    if not reason:
        return
    if reason not in reasons:
        reasons.append(reason)


def _is_missing_value(value) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def _load_quality_rule_config(db: Session) -> dict:
    required_fields_raw = _get_config(
        db,
        "algo",
        "quality_required_fields",
        "name,category_type,daily_change,net_amount,turnover,lead_stock_change",
    )
    required_fields = [field.strip() for field in str(required_fields_raw).split(",") if field.strip()]

    return {
        "required_fields": required_fields,
        "daily_change_abs_max": max(1.0, _to_float(_get_config(db, "algo", "quality_daily_change_abs_max", "20"), 20.0)),
        "lead_stock_change_abs_max": max(1.0, _to_float(_get_config(db, "algo", "quality_lead_stock_change_abs_max", "25"), 25.0)),
        "turnover_abs_max": max(1.0, _to_float(_get_config(db, "algo", "quality_turnover_abs_max", "30"), 30.0)),
        "net_amount_abs_max": max(1.0, _to_float(_get_config(db, "algo", "quality_net_amount_abs_max", "500"), 500.0)),
        "stale_minutes": max(1, _to_int(_get_config(db, "algo", "quality_stale_minutes", "240"), 240)),
    }


def _apply_row_quality_rules(item: dict, quality_rule_config: dict) -> None:
    reasons = _split_quality_reasons(item.get("quality_reason", ""))
    if str(item.get("quality_status", "ok")).strip().lower() == "failed":
        # Keep existing parser-level failures even if quality_reason is empty.
        _append_quality_reason(reasons, "parse_failed")

    for field in quality_rule_config.get("required_fields", []):
        if _is_missing_value(item.get(field)):
            _append_quality_reason(reasons, f"missing_{field}")

    numeric_limits = (
        ("daily_change", quality_rule_config.get("daily_change_abs_max"), "anomaly_daily_change_abs"),
        ("lead_stock_change", quality_rule_config.get("lead_stock_change_abs_max"), "anomaly_lead_stock_change_abs"),
        ("turnover", quality_rule_config.get("turnover_abs_max"), "anomaly_turnover_abs"),
        ("net_amount", quality_rule_config.get("net_amount_abs_max"), "anomaly_net_amount_abs"),
    )
    for field, threshold, reason_prefix in numeric_limits:
        if threshold is None:
            continue
        value = _to_float(item.get(field), default=None)
        if value is None:
            continue
        if abs(value) > float(threshold):
            _append_quality_reason(reasons, f"{reason_prefix}_gt_{threshold}")

    item["quality_status"] = "failed" if reasons else "ok"
    item["quality_reason"] = "; ".join(reasons)


def _load_data_http_profile(db: Session) -> HttpClientProfile:
    return build_http_profile(
        {
            "request_timeout_sec": _get_config(db, "data", "request_timeout_sec", "15"),
            "request_retry_count": _get_config(db, "data", "request_retry_count", "2"),
            "request_retry_backoff_sec": _get_config(db, "data", "request_retry_backoff_sec", "0.6"),
            "http_proxy_enabled": _get_config(db, "data", "http_proxy_enabled", "0"),
            "http_proxy": _get_config(db, "data", "http_proxy", ""),
            "http_proxy_strategy": _get_config(db, "data", "http_proxy_strategy", "auto"),
            "http_user_agent": _get_config(db, "data", "http_user_agent", ""),
        },
        default_user_agent=SINA_HEADERS["User-Agent"],
    )


def _iter_proxy_candidates(profile: HttpClientProfile) -> list[Optional[str]]:
    strategy = str(getattr(profile, "proxy_strategy", "auto") or "auto").lower()
    if strategy == "force_proxy":
        return [profile.proxy_url]
    if strategy == "force_direct":
        return [None]
    return [None, profile.proxy_url] if profile.proxy_url else [None]


# ============================================================
# 浠庢柊娴狝PI鑾峰彇鏉垮潡鏁版嵁
# ============================================================

async def fetch_sina_sectors(
    fenlei: str = "1",
    num: int = 200,
    http_profile: Optional[HttpClientProfile] = None,
) -> list:
    """
    浠庢柊娴狝PI鑾峰彇鏉垮潡鏁版嵁
    fenlei: 1=琛屼笟鏉垮潡, 0=姒傚康鏉垮潡
    """
    params = {
        "page": 1,
        "num": num,
        "sort": "netamount",
        "asc": 0,
        "fenlei": fenlei,
    }
    return await get_json(
        SINA_API_URL,
        params=params,
        headers=SINA_HEADERS,
        profile=http_profile,
    )


def parse_sina_item(item: dict, category_type: str) -> dict:
    """解析新浪返回的单条板块数据。"""
    quality_errors = []

    def to_float(raw, field: str, scale: float = 1.0) -> float:
        try:
            if raw is None or raw == "":
                quality_errors.append(f"missing_{field}")
                return 0.0
            return float(raw) * scale
        except Exception:
            quality_errors.append(f"invalid_{field}")
            return 0.0

    return {
        "name": item.get("name", ""),
        "api_id": item.get("category", ""),
        "category_type": category_type,
        "daily_change": to_float(item.get("avg_changeratio", 0), "avg_changeratio", 100.0),
        "net_amount": to_float(item.get("netamount", 0), "netamount", 1.0 / 100_000_000),
        # Sina moneyflow turnover is usually returned as percent * 100 (e.g. 120.335 -> 1.20335%).
        "turnover": to_float(item.get("turnover", 0), "turnover", 0.01),
        "lead_stock": item.get("ts_name", ""),
        "lead_stock_change": to_float(item.get("ts_changeratio", 0), "ts_changeratio", 100.0),
        "quality_status": "failed" if quality_errors else "ok",
        "quality_reason": "; ".join(quality_errors),
    }


def _pick_first(row: dict, keys: list, default=None):
    for k in keys:
        if k in row and row.get(k) not in (None, ""):
            return row.get(k)
    return default


def parse_akshare_item(row: dict, category_type: str) -> dict:
    quality_errors = []

    name = _pick_first(
        row,
        [
            "\u677f\u5757\u540d\u79f0",
            "\u677f\u5757",
            "\u540d\u79f0",
            "\u884c\u4e1a\u540d\u79f0",
            "\u6982\u5ff5\u540d\u79f0",
        ],
        "",
    )
    if not name:
        quality_errors.append("name_empty")

    api_id = str(_pick_first(row, ["\u677f\u5757\u4ee3\u7801", "\u4ee3\u7801", "label"], ""))
    daily_change = _to_float(
        _pick_first(row, ["\u6da8\u8dcc\u5e45", "\u6da8\u5e45", "\u6da8\u8dcc\u5e45(%)"], None),
        default=None,
    )
    if daily_change is None:
        quality_errors.append("daily_change_empty")
        daily_change = 0.0

    turnover = _to_float(
        _pick_first(row, ["\u6362\u624b\u7387", "\u6362\u624b", "\u6362\u624b\u7387(%)"], 0.0),
        default=0.0,
    )
    lead_stock = str(
        _pick_first(
            row,
            ["\u9886\u6da8\u80a1\u7968", "\u9886\u6da8\u80a1", "\u9f99\u5934\u80a1", "\u80a1\u7968\u540d\u79f0"],
            "",
        )
        or ""
    )
    lead_stock_change = _to_float(
        _pick_first(
            row,
            [
                "\u9886\u6da8\u80a1\u7968-\u6da8\u8dcc\u5e45",
                "\u9886\u6da8\u80a1\u6da8\u8dcc\u5e45",
                "\u9886\u6da8\u80a1\u7968\u6da8\u8dcc\u5e45",
                "\u4e2a\u80a1-\u6da8\u8dcc\u5e45",
            ],
            0.0,
        ),
        default=0.0,
    )
    net_amount_raw = _pick_first(
        row,
        [
            "\u4e3b\u529b\u51c0\u6d41\u5165-\u51c0\u989d",
            "\u4e3b\u529b\u51c0\u6d41\u5165\u51c0\u989d",
            "\u4e3b\u529b\u51c0\u6d41\u5165",
            "\u51c0\u6d41\u5165",
            "\u603b\u6210\u4ea4\u989d",
        ],
        0.0,
    )
    net_amount = _to_float(net_amount_raw, default=0.0)
    if abs(net_amount) > 10000:
        net_amount = net_amount / 100_000_000

    return {
        "name": str(name),
        "api_id": api_id,
        "category_type": category_type,
        "daily_change": daily_change,
        "net_amount": net_amount,
        "turnover": turnover,
        "lead_stock": lead_stock,
        "lead_stock_change": lead_stock_change,
        "quality_status": "failed" if quality_errors else "ok",
        "quality_reason": "; ".join(quality_errors),
    }


def parse_eastmoney_item(row: dict, category_type: str) -> dict:
    quality_errors = []
    name = str(row.get("f14") or "").strip()
    if not name:
        quality_errors.append("name_empty")

    api_id = str(row.get("f12") or "").strip()
    daily_change = _to_float(row.get("f3"), 0.0)
    turnover = _to_float(row.get("f8"), 0.0)
    lead_stock = str(row.get("f128") or "").strip()
    lead_stock_change = _to_float(row.get("f136"), 0.0)

    # 东财返回的 f62 通常为主力净流入(元)，这里统一转换成亿元
    net_amount = _to_float(row.get("f62"), 0.0)
    if abs(net_amount) > 10000:
        net_amount = net_amount / 100_000_000

    return {
        "name": name,
        "api_id": api_id,
        "category_type": category_type,
        "daily_change": daily_change,
        "net_amount": net_amount,
        "turnover": turnover,
        "lead_stock": lead_stock,
        "lead_stock_change": lead_stock_change,
        "quality_status": "failed" if quality_errors else "ok",
        "quality_reason": "; ".join(quality_errors),
    }


def _extract_eastmoney_rows(payload: dict) -> list:
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    diff = data.get("diff")
    if isinstance(diff, list):
        return diff
    if isinstance(diff, dict):
        return list(diff.values())
    return []


async def _fetch_eastmoney_board_rows(
    url: str,
    params: dict,
    http_profile: Optional[HttpClientProfile],
) -> list:
    payload = await get_json(
        url,
        params=params,
        headers=EASTMONEY_HEADERS,
        profile=http_profile,
    )
    return _extract_eastmoney_rows(payload)


def _fetch_eastmoney_via_akshare_sync(num: int = 200, proxy_url: Optional[str] = None) -> list:
    try:
        with _temporary_proxy_env(proxy_url):
            import akshare as ak  # type: ignore
            _patch_akshare_request(proxy_url)
    except Exception as e:
        raise RuntimeError(f"akshare unavailable: {e}")

    result = []
    with _temporary_proxy_env(proxy_url):
        industry_df = ak.stock_board_industry_name_em()
        concept_df = ak.stock_board_concept_name_em()

    if industry_df is not None:
        for row in industry_df.to_dict("records")[:num]:
            item = parse_akshare_item(row, "\u884c\u4e1a")
            item["quality_reason"] = (
                (item.get("quality_reason", "") + "; " if item.get("quality_reason") else "")
                + "eastmoney_fallback_via_akshare"
            )
            result.append(item)
    if concept_df is not None:
        for row in concept_df.to_dict("records")[:num]:
            item = parse_akshare_item(row, "\u6982\u5ff5")
            item["quality_reason"] = (
                (item.get("quality_reason", "") + "; " if item.get("quality_reason") else "")
                + "eastmoney_fallback_via_akshare"
            )
            result.append(item)
    return result


async def fetch_eastmoney_sectors(
    num: int = 200,
    http_profile: Optional[HttpClientProfile] = None,
) -> list:
    profile = http_profile or HttpClientProfile()

    industry_params = {
        "pn": "1",
        "pz": str(num),
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:90 t:2 f:!50",
        "fields": EASTMONEY_INDUSTRY_FIELDS,
    }
    concept_params = {
        "pn": "1",
        "pz": str(num),
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f12",
        "fs": "m:90 t:3 f:!50",
        "fields": EASTMONEY_CONCEPT_FIELDS,
    }

    try:
        industry_rows, concept_rows = await asyncio.gather(
            _fetch_eastmoney_board_rows(EASTMONEY_INDUSTRY_URL, industry_params, profile),
            _fetch_eastmoney_board_rows(EASTMONEY_CONCEPT_URL, concept_params, profile),
        )
        merged = []
        for row in industry_rows:
            merged.append(parse_eastmoney_item(row, "\u884c\u4e1a"))
        for row in concept_rows:
            merged.append(parse_eastmoney_item(row, "\u6982\u5ff5"))
        if merged:
            return merged
    except Exception:
        # 保留回退能力，保证 eastmoney 源在网络差异环境下可用
        pass

    last_err: Optional[Exception] = None

    # Fallback 1: use Sina board spot via akshare to keep service alive in restrictive networks.
    for proxy_url in _iter_proxy_candidates(profile):
        try:
            items = await retry_async(
                lambda: asyncio.to_thread(_fetch_akshare_sectors_sina_spot_sync, num, proxy_url),
                retry_count=profile.retry_count,
                retry_backoff_sec=profile.retry_backoff_sec,
                retryable=(Exception,),
            )
            for item in items:
                item["quality_reason"] = (
                    (item.get("quality_reason", "") + "; " if item.get("quality_reason") else "")
                    + "eastmoney_fallback_via_akshare_sina_spot"
                )
            if items:
                return items
        except Exception as e:
            last_err = e

    # Fallback 2: keep Eastmoney schema via akshare EM functions.
    for proxy_url in _iter_proxy_candidates(profile):
        try:
            return await retry_async(
                lambda: asyncio.to_thread(_fetch_eastmoney_via_akshare_sync, num, proxy_url),
                retry_count=profile.retry_count,
                retry_backoff_sec=profile.retry_backoff_sec,
                retryable=(Exception,),
            )
        except Exception as e:
            last_err = e

    if last_err:
        raise last_err
    raise RuntimeError("eastmoney fetch failed")


@contextmanager
def _temporary_proxy_env(proxy_url: Optional[str]):
    proxy_keys = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
    no_proxy_keys = ("NO_PROXY", "no_proxy")
    managed_keys = proxy_keys + no_proxy_keys
    old_values = {k: os.environ.get(k) for k in managed_keys}
    try:
        if proxy_url:
            for key in proxy_keys:
                os.environ[key] = proxy_url
            # 显式代理模式下不设置 NO_PROXY，避免误绕过代理。
            for key in no_proxy_keys:
                os.environ.pop(key, None)
        else:
            # 无显式代理配置时，强制直连，避免继承系统代理导致抓取失败。
            for key in proxy_keys:
                os.environ.pop(key, None)
            for key in no_proxy_keys:
                os.environ[key] = "*"
        yield
    finally:
        for key, value in old_values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _fetch_akshare_sectors_sync(num: int = 200, proxy_url: Optional[str] = None) -> list:
    try:
        with _temporary_proxy_env(proxy_url):
            import akshare as ak  # type: ignore
            _patch_akshare_request(proxy_url)
    except Exception as e:
        raise RuntimeError(f"akshare unavailable: {e}")

    result = []
    with _temporary_proxy_env(proxy_url):
        industry_df = ak.stock_board_industry_name_em()
        concept_df = ak.stock_board_concept_name_em()

    if industry_df is not None:
        for row in industry_df.to_dict("records")[:num]:
            result.append(parse_akshare_item(row, "\u884c\u4e1a"))
    if concept_df is not None:
        for row in concept_df.to_dict("records")[:num]:
            result.append(parse_akshare_item(row, "\u6982\u5ff5"))
    return result


def _fetch_akshare_sectors_sina_spot_sync(num: int = 200, proxy_url: Optional[str] = None) -> list:
    """
    Fetch board list through akshare's Sina-sector endpoints.
    This path is often more stable than Eastmoney board endpoints under mixed proxy networks.
    """
    try:
        with _temporary_proxy_env(proxy_url):
            import akshare as ak  # type: ignore
    except Exception as e:
        raise RuntimeError(f"akshare unavailable: {e}")

    result = []
    with _temporary_proxy_env(proxy_url):
        industry_df = ak.stock_sector_spot(indicator="\u65b0\u6d6a\u884c\u4e1a")
        concept_df = ak.stock_sector_spot(indicator="\u6982\u5ff5")

    if industry_df is not None:
        for row in industry_df.to_dict("records")[:num]:
            item = parse_akshare_item(row, "\u884c\u4e1a")
            item["quality_reason"] = (
                (item.get("quality_reason", "") + "; " if item.get("quality_reason") else "")
                + "akshare_sina_sector_spot"
            )
            result.append(item)
    if concept_df is not None:
        for row in concept_df.to_dict("records")[:num]:
            item = parse_akshare_item(row, "\u6982\u5ff5")
            item["quality_reason"] = (
                (item.get("quality_reason", "") + "; " if item.get("quality_reason") else "")
                + "akshare_sina_sector_spot"
            )
            result.append(item)
    return result


def _patch_akshare_request(proxy_url: Optional[str]) -> None:
    """
    覆盖 akshare 默认的 request_with_retry，避免默认 trust_env=True 继承系统代理。
    在无显式代理配置时强制直连；有显式代理时按配置走。
    """
    import requests
    from requests.adapters import HTTPAdapter

    import akshare.utils.request as ak_request  # type: ignore
    import akshare.utils.func as ak_func  # type: ignore

    def _request_with_retry(
        url: str,
        params: dict = None,
        timeout: int = 15,
        max_retries: int = 3,
        base_delay: float = 1.0,
        random_delay_range=(0.5, 1.5),
    ):
        last_exception = None
        for attempt in range(max_retries):
            try:
                with requests.Session() as session:
                    session.trust_env = False
                    if proxy_url:
                        session.proxies = {"http": proxy_url, "https": proxy_url}
                    adapter = HTTPAdapter(pool_connections=1, pool_maxsize=1)
                    session.mount("http://", adapter)
                    session.mount("https://", adapter)
                    response = session.get(url, params=params, timeout=timeout)
                    response.raise_for_status()
                    return response
            except (requests.RequestException, ValueError) as e:
                last_exception = e
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt) + random.uniform(*random_delay_range)
                    time.sleep(delay)

        raise last_exception

    ak_request.request_with_retry = _request_with_retry
    # func.py 中是 from ... import request_with_retry，需同步覆盖该引用。
    ak_func.request_with_retry = _request_with_retry


async def fetch_akshare_sectors(
    num: int = 200,
    http_profile: Optional[HttpClientProfile] = None,
) -> list:
    profile = http_profile or HttpClientProfile()
    last_err: Optional[Exception] = None

    # Prefer Sina-sector path for better stability in proxy environments.
    for proxy_url in _iter_proxy_candidates(profile):
        try:
            return await retry_async(
                lambda: asyncio.to_thread(_fetch_akshare_sectors_sina_spot_sync, num, proxy_url),
                retry_count=profile.retry_count,
                retry_backoff_sec=profile.retry_backoff_sec,
                retryable=(Exception,),
            )
        except Exception as e:
            last_err = e

    # Fallback to Eastmoney-board path.
    for proxy_url in _iter_proxy_candidates(profile):
        try:
            return await retry_async(
                lambda: asyncio.to_thread(_fetch_akshare_sectors_sync, num, proxy_url),
                retry_count=profile.retry_count,
                retry_backoff_sec=profile.retry_backoff_sec,
                retryable=(Exception,),
            )
        except Exception as e:
            last_err = e

    if last_err:
        raise last_err
    raise RuntimeError("akshare fetch failed")


def _build_tushare_trade_dates(max_days: int = 7) -> list[str]:
    today = date.today()
    return [(today - timedelta(days=i)).strftime("%Y%m%d") for i in range(max(1, max_days))]


def _tushare_rows_from_payload(payload: dict) -> list[dict]:
    data = payload.get("data") if isinstance(payload, dict) else {}
    fields = data.get("fields") if isinstance(data, dict) else []
    items = data.get("items") if isinstance(data, dict) else []
    if not isinstance(fields, list) or not isinstance(items, list):
        return []

    rows = []
    for item in items:
        if isinstance(item, dict):
            rows.append(item)
            continue
        if not isinstance(item, list):
            continue
        row = {}
        for idx, field in enumerate(fields):
            if idx < len(item):
                row[str(field)] = item[idx]
        rows.append(row)
    return rows


async def _tushare_query(
    api_name: str,
    *,
    token: str,
    params: dict,
    fields: str,
    profile: HttpClientProfile,
) -> dict:
    if not token:
        raise RuntimeError("tushare token not configured")

    headers = {
        "Content-Type": "application/json",
        "User-Agent": profile.user_agent,
    }
    payload = {
        "api_name": api_name,
        "token": token,
        "params": params,
        "fields": fields,
    }

    last_error: Optional[Exception] = None
    for proxy_url in _iter_proxy_candidates(profile):
        async def _request_once() -> dict:
            async with httpx.AsyncClient(
                timeout=profile.timeout_sec,
                proxy=proxy_url,
                trust_env=False,
                follow_redirects=True,
            ) as client:
                resp = await client.post(TUSHARE_PRO_URL, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                code = int(data.get("code", -1) or -1)
                if code != 0:
                    msg = str(data.get("msg") or "unknown")
                    raise TushareApiError(api_name, code, msg)
                return data

        try:
            return await retry_async(
                _request_once,
                retry_count=profile.retry_count,
                retry_backoff_sec=profile.retry_backoff_sec,
                retryable=(httpx.HTTPError, ValueError, asyncio.TimeoutError),
            )
        except TushareApiError:
            raise
        except Exception as e:
            last_error = e
            continue

    if last_error:
        raise last_error
    raise RuntimeError(f"tushare api={api_name} failed")


def _parse_tushare_moneyflow_item(row: dict, category_type: str, name_field: str) -> dict:
    quality_errors = []
    name = str(row.get(name_field) or "").strip()
    if not name:
        quality_errors.append("name_empty")

    api_id = str(row.get("ts_code") or "").strip()
    daily_change = _to_float(row.get("pct_change"), 0.0)
    lead_stock = str(row.get("lead_stock") or "").strip()
    lead_stock_change = _to_float(row.get("pct_change_stock"), 0.0)
    net_amount = _to_float(row.get("net_amount"), default=None)
    if net_amount is None:
        net_buy = _to_float(row.get("net_buy_amount"), 0.0)
        net_sell = _to_float(row.get("net_sell_amount"), 0.0)
        net_amount = net_buy - net_sell
    # TuShare moneyflow fields are usually in 万元, normalize to 亿元 for consistency.
    if abs(net_amount) > 10000:
        net_amount = net_amount / 10000.0

    return {
        "name": name,
        "api_id": api_id,
        "category_type": category_type,
        "daily_change": daily_change,
        "net_amount": net_amount,
        "turnover": 0.0,
        "lead_stock": lead_stock,
        "lead_stock_change": lead_stock_change,
        "quality_status": "failed" if quality_errors else "ok",
        "quality_reason": "; ".join(quality_errors),
    }


async def fetch_tushare_sectors(
    token: str,
    num: int = 200,
    http_profile: Optional[HttpClientProfile] = None,
) -> list[dict]:
    profile = http_profile or HttpClientProfile()
    token = str(token or "").strip()
    if not token:
        raise RuntimeError("tushare token not configured")

    api_plan = [
        {
            "api_name": "moneyflow_ind_ths",
            "category_type": "行业",
            "name_field": "industry",
            "fields": (
                "trade_date,ts_code,industry,pct_change,company_num,lead_stock,"
                "close_price,pct_change_stock,net_buy_amount,net_sell_amount,"
                "net_buy_amount_rate,net_amount"
            ),
        },
        {
            "api_name": "moneyflow_cnt_ths",
            "category_type": "概念",
            "name_field": "name",
            "fields": (
                "trade_date,ts_code,name,pct_change,lead_stock,close_price,"
                "pct_change_stock,net_amount,net_rate,company_num,net_buy_amount,net_sell_amount"
            ),
        },
    ]

    # Try recent trade dates to avoid empty datasets on non-trading days.
    last_error: Optional[Exception] = None
    for trade_date in _build_tushare_trade_dates(7):
        try:
            merged = []
            for item in api_plan:
                payload = await _tushare_query(
                    item["api_name"],
                    token=token,
                    params={"trade_date": trade_date},
                    fields=item["fields"],
                    profile=profile,
                )
                rows = _tushare_rows_from_payload(payload)
                for row in rows[:num]:
                    merged.append(
                        _parse_tushare_moneyflow_item(
                            row,
                            item["category_type"],
                            item["name_field"],
                        )
                    )
            if merged:
                return merged[: max(num * 2, num)]
        except Exception as e:
            # API-level errors (permission/token/invalid params) should fail fast.
            if isinstance(e, TushareApiError):
                raise e
            if isinstance(e, RuntimeError) and "tushare api=" in str(e):
                raise e
            last_error = e
            continue

    if last_error:
        raise last_error
    raise RuntimeError("tushare returned empty dataset")


async def fetch_items_by_source(
    source_name: str,
    num: int = 200,
    http_profile: Optional[HttpClientProfile] = None,
    tushare_token: str = "",
) -> list:
    if source_name == "sina":
        industry_data = await fetch_sina_sectors("1", num, http_profile=http_profile)
        concept_data = await fetch_sina_sectors("0", num, http_profile=http_profile)
        all_items = []
        for item in industry_data:
            all_items.append(parse_sina_item(item, "\u884c\u4e1a"))
        for item in concept_data:
            all_items.append(parse_sina_item(item, "\u6982\u5ff5"))
        return all_items
    if source_name == "akshare":
        return await fetch_akshare_sectors(num, http_profile=http_profile)
    if source_name == "eastmoney":
        return await fetch_eastmoney_sectors(num, http_profile=http_profile)
    if source_name == "tushare":
        return await fetch_tushare_sectors(
            token=tushare_token,
            num=num,
            http_profile=http_profile,
        )
    raise ValueError(f"unsupported source: {source_name}")


def _short_error_text(err: Exception, max_len: int = 220) -> str:
    msg = str(err).strip().replace("\n", " ")
    if len(msg) > max_len:
        msg = msg[:max_len] + "..."
    return f"{type(err).__name__}: {msg}"


def _normalize_health_error(source_name: str, err: Exception) -> str:
    if source_name == "tushare":
        raw = str(err)
        if "code=40203" in raw and "doc_id=108" in raw:
            return (
                "TuShare 权限不足：当前 token 未开通 doc_id=108 "
                "(moneyflow_ind_ths/moneyflow_cnt_ths)"
            )
    return _short_error_text(err, max_len=180)


async def fetch_items_with_fallback(
    source_name: str,
    num: int,
    http_profile: Optional[HttpClientProfile] = None,
    tushare_token: str = "",
) -> tuple[list, str, Optional[str]]:
    """
    Try requested source first. If it fails and requested source is not default source,
    fallback to default source to keep main refresh flow alive.
    Returns: (items, actual_source_name, fallback_reason)
    """
    try:
        items = await fetch_items_by_source(
            source_name,
            num,
            http_profile=http_profile,
            tushare_token=tushare_token,
        )
        if not items:
            raise RuntimeError(f"{source_name} returned empty dataset")
        return items, source_name, None
    except Exception as primary_err:
        if source_name == DATA_SOURCE_NAME:
            raise

        fallback_source = DATA_SOURCE_NAME
        fallback_reason = (
            f"primary source {source_name} failed ({_short_error_text(primary_err)}), "
            f"fallback to {fallback_source}"
        )
        items = await fetch_items_by_source(
            fallback_source,
            num,
            http_profile=http_profile,
            tushare_token=tushare_token,
        )
        if not items:
            raise RuntimeError(f"{fallback_source} returned empty dataset after fallback")
        return items, fallback_source, fallback_reason


def _build_eastmoney_health_params(num: int = 20) -> tuple[dict, dict]:
    industry_params = {
        "pn": "1",
        "pz": str(num),
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:90 t:2 f:!50",
        "fields": EASTMONEY_INDUSTRY_FIELDS,
    }
    concept_params = {
        "pn": "1",
        "pz": str(num),
        "po": "1",
        "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": "2",
        "invt": "2",
        "fid": "f12",
        "fs": "m:90 t:3 f:!50",
        "fields": EASTMONEY_CONCEPT_FIELDS,
    }
    return industry_params, concept_params


def _collect_sample_names(items: list, max_count: int = 5) -> list:
    sample = []
    for it in items:
        name = str(it.get("name", "")).strip()
        if not name or name in sample:
            continue
        sample.append(name)
        if len(sample) >= max_count:
            break
    return sample


async def _check_single_source_health(
    source_name: str,
    profile: HttpClientProfile,
    num: int = 20,
    tushare_token: str = "",
) -> dict:
    started_at = time.perf_counter()
    timeout_sec = min(max(profile.timeout_sec * 2.0, 8.0), 40.0)
    degraded = False
    note = ""
    try:
        if source_name == "sina":
            industry_data, concept_data = await asyncio.wait_for(
                asyncio.gather(
                    fetch_sina_sectors("1", num, http_profile=profile),
                    fetch_sina_sectors("0", num, http_profile=profile),
                ),
                timeout=timeout_sec,
            )
            items = [parse_sina_item(x, "行业") for x in industry_data] + [parse_sina_item(x, "概念") for x in concept_data]
        elif source_name == "akshare":
            items = await asyncio.wait_for(
                fetch_akshare_sectors(num, http_profile=profile),
                timeout=timeout_sec,
            )
        elif source_name == "eastmoney":
            items = await asyncio.wait_for(
                fetch_eastmoney_sectors(num, http_profile=profile),
                timeout=timeout_sec,
            )
            degraded = any(
                "eastmoney_fallback_via_akshare" in str(it.get("quality_reason", ""))
                for it in items
            )
            if degraded:
                note = "fallback_via_akshare_sina_spot"
        elif source_name == "tushare":
            items = await asyncio.wait_for(
                fetch_tushare_sectors(
                    token=tushare_token,
                    num=num,
                    http_profile=profile,
                ),
                timeout=timeout_sec,
            )
        else:
            raise ValueError(f"unsupported source: {source_name}")

        if not items:
            raise RuntimeError("empty dataset")

        latency_ms = int((time.perf_counter() - started_at) * 1000)
        return {
            "source_name": source_name,
            "source_display_name": SOURCE_DISPLAY_NAMES.get(source_name, source_name),
            "status": "ok",
            "latency_ms": latency_ms,
            "count": len(items),
            "sample_names": _collect_sample_names(items, 5),
            "degraded": degraded,
            "note": note,
            "error": "",
        }
    except Exception as e:
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        return {
            "source_name": source_name,
            "source_display_name": SOURCE_DISPLAY_NAMES.get(source_name, source_name),
            "status": "error",
            "latency_ms": latency_ms,
            "count": 0,
            "sample_names": [],
            "degraded": False,
            "note": "",
            "error": _normalize_health_error(source_name, e),
        }


def _pick_recommended_primary_source(results: list[dict]) -> str:
    for candidate in SOURCE_RECOMMEND_ORDER:
        found = next((x for x in results if x.get("source_name") == candidate and x.get("status") == "ok"), None)
        if found:
            return candidate
    return ""


def _pick_recommended_verify_source(primary_source: str, results: Optional[list[dict]] = None) -> str:
    """
    Pick a verify source different from primary source.
    If results provided, only pick from healthy sources.
    """
    for candidate in SOURCE_RECOMMEND_ORDER:
        if candidate == primary_source:
            continue
        if results is not None:
            found = next((x for x in results if x.get("source_name") == candidate), None)
            if not found or found.get("status") != "ok":
                continue
        return candidate
    return ""


async def _pick_available_verify_source(
    primary_source: str,
    http_profile: Optional[HttpClientProfile] = None,
    tushare_token: str = "",
) -> str:
    """
    Pick a verify source different from primary and actually fetchable.
    """
    for candidate in SOURCE_RECOMMEND_ORDER:
        if candidate == primary_source:
            continue
        try:
            items = await fetch_items_by_source(
                candidate,
                30,
                http_profile=http_profile,
                tushare_token=tushare_token,
            )
            if items:
                return candidate
        except Exception:
            continue
    return ""


def build_compare_stats(primary_items: dict, verify_items: dict, warn_threshold_pct: float) -> dict:
    shared_names = sorted(set(primary_items.keys()) & set(verify_items.keys()))
    if not shared_names:
        return {
            "status": "empty",
            "matched_count": 0,
            "warn_count": 0,
            "warn_threshold_pct": warn_threshold_pct,
            "mean_abs_diff": 0.0,
            "max_abs_diff": 0.0,
            "max_diff_name": "",
        }

    warn_count = 0
    diffs = []
    max_abs_diff = -1.0
    max_diff_name = ""

    for name in shared_names:
        p = _to_float(primary_items[name].get("daily_change", 0.0), 0.0)
        v = _to_float(verify_items[name].get("daily_change", 0.0), 0.0)
        diff = abs(p - v)
        diffs.append(diff)
        if diff >= warn_threshold_pct:
            warn_count += 1
        if diff > max_abs_diff:
            max_abs_diff = diff
            max_diff_name = name

    mean_abs_diff = sum(diffs) / len(diffs) if diffs else 0.0
    return {
        "status": "ok",
        "matched_count": len(shared_names),
        "warn_count": warn_count,
        "warn_threshold_pct": warn_threshold_pct,
        "warn_ratio": round((warn_count / len(shared_names)) * 100.0, 2),
        "mean_abs_diff": round(mean_abs_diff, 4),
        "max_abs_diff": round(max_abs_diff if max_abs_diff >= 0 else 0.0, 4),
        "max_diff_name": max_diff_name,
    }


# ============================================================
# API璺敱
# ============================================================

@router.get("/sectors")
async def get_sectors(
    db: Session = Depends(get_db),
    category_type: Optional[str] = Query(None, description="筛选：行业/概念"),
    level: Optional[int] = Query(None, description="筛选：层级 1/2/3"),
    favorited: Optional[bool] = Query(None, description="筛选：仅关注"),
    search: Optional[str] = Query(None, description="搜索关键词"),
):
    """获取板块列表"""
    query = db.query(Sector).filter(Sector.is_active == True)

    if category_type:
        query = query.filter(Sector.category_type == category_type)
    if level:
        query = query.filter(Sector.level == level)
    if favorited is not None:
        query = query.filter(Sector.is_favorited == favorited)
    if search:
        query = query.filter(Sector.name.contains(search))

    sectors = query.order_by(Sector.name).all()

    return [{
        "id": s.id,
        "name": s.name,
        "category_type": s.category_type,
        "api_id": s.api_id,
        "level": s.level,
        "parent_id": s.parent_id,
        "is_active": s.is_active,
        "is_favorited": s.is_favorited,
    } for s in sectors]
@router.post("/sectors/refresh")
async def refresh_sectors(db: Session = Depends(get_db)):
    """刷新板块数据（支持主源+校验源双源比对）"""
    today = date.today()
    requested_source_name = _get_config(db, "data", "primary_source", DATA_SOURCE_NAME).strip().lower() or DATA_SOURCE_NAME
    if requested_source_name not in SOURCE_DISPLAY_NAMES:
        requested_source_name = DATA_SOURCE_NAME
    requested_source_display_name = SOURCE_DISPLAY_NAMES.get(requested_source_name, requested_source_name)
    source_name = requested_source_name
    source_display_name = requested_source_display_name
    warn_threshold_pct = _to_float(_get_config(db, "data", "compare_warn_threshold_pct", "0.8"), 0.8)
    http_profile = _load_data_http_profile(db)
    tushare_token = _get_config(db, "data", "tushare_token", "").strip()
    quality_rule_config = _load_quality_rule_config(db)

    dual_compare_enabled = _config_bool(_get_config(db, "data", "dual_compare_enabled", "0"))
    configured_verify_source_name = _get_config(db, "data", "verify_source", "").strip().lower()
    verify_source_name = configured_verify_source_name
    if dual_compare_enabled and (not verify_source_name or verify_source_name == source_name):
        auto_verify = await _pick_available_verify_source(
            source_name,
            http_profile=http_profile,
            tushare_token=tushare_token,
        )
        if auto_verify:
            verify_source_name = auto_verify
        else:
            verify_source_name = ""
    verify_source_display_name = SOURCE_DISPLAY_NAMES.get(verify_source_name, verify_source_name or "")
    configured_verify_source_display_name = SOURCE_DISPLAY_NAMES.get(configured_verify_source_name, configured_verify_source_name or "")
    verify_source_auto_adjusted = verify_source_name != configured_verify_source_name
    result = {
        "new_sectors": 0,
        "updated": 0,
        "total": 0,
        "errors": [],
        "warnings": [],
        "requested_source_name": requested_source_name,
        "requested_source_display_name": requested_source_display_name,
        "source_name": source_name,
        "source_display_name": source_display_name,
        "configured_verify_source_name": configured_verify_source_name,
        "configured_verify_source_display_name": configured_verify_source_display_name,
        "verify_source_name": verify_source_name,
        "verify_source_display_name": verify_source_display_name,
        "verify_source_auto_adjusted": verify_source_auto_adjusted,
        "source_degraded": False,
        "fallback_used": False,
        "fallback_from": "",
        "fallback_to": "",
        "fallback_reason": "",
        "dual_compare_enabled": dual_compare_enabled,
        "last_sync_at": "",
        "compare": {
            "status": "disabled",
            "matched_count": 0,
            "warn_count": 0,
            "warn_threshold_pct": warn_threshold_pct,
            "mean_abs_diff": 0.0,
            "max_abs_diff": 0.0,
            "max_diff_name": "",
        },
    }

    try:
        all_items, actual_source_name, fallback_reason = await fetch_items_with_fallback(
            source_name,
            200,
            http_profile=http_profile,
            tushare_token=tushare_token,
        )
        source_name = actual_source_name
        source_display_name = SOURCE_DISPLAY_NAMES.get(source_name, source_name)
        result["source_name"] = source_name
        result["source_display_name"] = source_display_name

        # Fallback may change primary source at runtime; ensure verify source stays different.
        if dual_compare_enabled and (not verify_source_name or verify_source_name == source_name):
            from_verify = verify_source_name
            runtime_verify = await _pick_available_verify_source(
                source_name,
                http_profile=http_profile,
                tushare_token=tushare_token,
            )
            if runtime_verify:
                verify_source_name = runtime_verify
                verify_source_display_name = SOURCE_DISPLAY_NAMES.get(verify_source_name, verify_source_name)
                result["verify_source_name"] = verify_source_name
                result["verify_source_display_name"] = verify_source_display_name
                verify_source_auto_adjusted = True
                result["verify_source_auto_adjusted"] = True
                result["warnings"].append(
                    f"verify source auto-adjusted at runtime from "
                    f"{from_verify or '<empty>'} to {verify_source_name}"
                )
            elif verify_source_name == source_name:
                verify_source_name = ""
                verify_source_display_name = ""
                result["verify_source_name"] = ""
                result["verify_source_display_name"] = ""
                verify_source_auto_adjusted = True
                result["verify_source_auto_adjusted"] = True
                result["warnings"].append(
                    f"verify source auto-adjusted at runtime from "
                    f"{from_verify or source_name} to <empty>"
                )

        if fallback_reason:
            result["fallback_used"] = True
            result["fallback_from"] = requested_source_name
            result["fallback_to"] = source_name
            result["fallback_reason"] = fallback_reason
            result["warnings"].append(fallback_reason)
        if verify_source_auto_adjusted:
            result["warnings"].append(
                f"verify source auto-adjusted from "
                f"{configured_verify_source_name or '<empty>'} to {verify_source_name}"
            )
        source_degraded = any(
            "eastmoney_fallback_via_akshare_sina_spot" in str(item.get("quality_reason", ""))
            for item in all_items
        )
        result["source_degraded"] = source_degraded
        if source_degraded and source_name == "eastmoney":
            result["warnings"].append("eastmoney degraded: fallback via akshare_sina_sector_spot")
        result["total"] = len(all_items)
        for item in all_items:
            _apply_row_quality_rules(item, quality_rule_config)

        existing_daily = db.query(DailyData).filter(DailyData.date == today).all()
        daily_map = {d.sector_id: d for d in existing_daily}

        latest_item_by_name = {}
        for item in all_items:
            name = item.get("name", "")
            if name:
                latest_item_by_name[name] = item
        quality_failed_rows = sum(
            1 for item in latest_item_by_name.values()
            if str(item.get("quality_status", "ok")).strip().lower() != "ok"
        )
        result["quality"] = {
            "required_fields": quality_rule_config.get("required_fields", []),
            "total_rows": len(latest_item_by_name),
            "failed_rows": quality_failed_rows,
            "ok_rows": max(0, len(latest_item_by_name) - quality_failed_rows),
            "anomaly_limits": {
                "daily_change_abs_max": quality_rule_config.get("daily_change_abs_max"),
                "lead_stock_change_abs_max": quality_rule_config.get("lead_stock_change_abs_max"),
                "turnover_abs_max": quality_rule_config.get("turnover_abs_max"),
                "net_amount_abs_max": quality_rule_config.get("net_amount_abs_max"),
            },
        }

        if dual_compare_enabled:
            if not verify_source_name:
                result["compare"] = {"status": "skipped_no_verify_source"}
            elif verify_source_name == source_name:
                result["compare"] = {"status": "skipped_same_source"}
            else:
                try:
                    verify_raw_items = await fetch_items_by_source(
                        verify_source_name,
                        200,
                        http_profile=http_profile,
                        tushare_token=tushare_token,
                    )
                    verify_item_by_name = {}
                    for row in verify_raw_items:
                        n = row.get("name", "")
                        if n:
                            verify_item_by_name[n] = row
                    result["compare"] = build_compare_stats(
                        latest_item_by_name,
                        verify_item_by_name,
                        warn_threshold_pct,
                    )
                except Exception as compare_err:
                    result["compare"] = {
                        "status": "error",
                        "message": _short_error_text(compare_err, max_len=180),
                    }

        for name, item in latest_item_by_name.items():
            try:
                sector = db.query(Sector).filter(Sector.name == name).first()
                if not sector:
                    sector = Sector(
                        name=name,
                        category_type=item["category_type"],
                        api_id=item["api_id"],
                    )
                    db.add(sector)
                    db.flush()
                    result["new_sectors"] += 1

                daily = daily_map.get(sector.id)
                if daily:
                    daily.daily_change = item["daily_change"]
                    daily.net_amount = item["net_amount"]
                    daily.turnover = item["turnover"]
                    daily.lead_stock = item["lead_stock"]
                    daily.lead_stock_change = item["lead_stock_change"]
                    daily.quality_status = item.get("quality_status", "ok")
                    daily.quality_reason = item.get("quality_reason", "")
                else:
                    daily = DailyData(
                        sector_id=sector.id,
                        date=today,
                        daily_change=item["daily_change"],
                        net_amount=item["net_amount"],
                        turnover=item["turnover"],
                        lead_stock=item["lead_stock"],
                        lead_stock_change=item["lead_stock_change"],
                        quality_status=item.get("quality_status", "ok"),
                        quality_reason=item.get("quality_reason", ""),
                    )
                    db.add(daily)
                    daily_map[sector.id] = daily

                result["updated"] += 1
            except Exception as item_err:
                result["errors"].append(f"{name}: {str(item_err)}")

        db.commit()

        sync_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        result["last_sync_at"] = sync_ts
        try:
            quality_rows = result.get("quality", {}) if isinstance(result.get("quality"), dict) else {}
            _upsert_config(db, "sync", "last_sync_at", sync_ts)
            _upsert_config(db, "sync", "last_sync_date", str(today))
            _upsert_config(db, "sync", "requested_source_name", requested_source_name)
            _upsert_config(db, "sync", "requested_source_display_name", requested_source_display_name)
            _upsert_config(db, "sync", "source_name", source_name)
            _upsert_config(db, "sync", "source_display_name", source_display_name)
            _upsert_config(db, "sync", "last_new_sectors", str(result.get("new_sectors", 0)))
            _upsert_config(db, "sync", "last_updated_rows", str(result.get("updated", 0)))
            _upsert_config(db, "sync", "last_total_rows", str(quality_rows.get("total_rows", 0)))
            _upsert_config(db, "sync", "last_quality_ok_rows", str(quality_rows.get("ok_rows", 0)))
            _upsert_config(db, "sync", "last_quality_failed_rows", str(quality_rows.get("failed_rows", 0)))
            _upsert_config(db, "sync", "source_degraded", "1" if result.get("source_degraded") else "0")
            _upsert_config(db, "sync", "verify_source_name", verify_source_name)
            _upsert_config(db, "sync", "verify_source_display_name", verify_source_display_name)
            _upsert_config(db, "sync", "fallback_used", "1" if result.get("fallback_used") else "0")
            _upsert_config(db, "sync", "fallback_from", str(result.get("fallback_from", "")))
            _upsert_config(db, "sync", "fallback_to", str(result.get("fallback_to", "")))
            _upsert_config(db, "sync", "fallback_reason", str(result.get("fallback_reason", "")))
            _upsert_config(db, "sync", "dual_compare_enabled", "1" if dual_compare_enabled else "0")
            _upsert_config(db, "sync", "last_compare_status", str(result.get("compare", {}).get("status", "")))
            _upsert_config(db, "sync", "last_compare_matched_count", str(result.get("compare", {}).get("matched_count", 0)))
            _upsert_config(db, "sync", "last_compare_warn_count", str(result.get("compare", {}).get("warn_count", 0)))
            _upsert_config(db, "sync", "last_compare_mean_abs_diff", str(result.get("compare", {}).get("mean_abs_diff", 0.0)))
            _upsert_config(db, "sync", "last_compare_max_abs_diff", str(result.get("compare", {}).get("max_abs_diff", 0.0)))
            _upsert_config(db, "sync", "last_compare_max_diff_name", str(result.get("compare", {}).get("max_diff_name", "")))
            _upsert_config(db, "sync", "last_compare_message", str(result.get("compare", {}).get("message", "")))
            db.commit()
        except Exception as sync_meta_err:
            db.rollback()
            result["errors"].append(f"sync metadata save failed: {str(sync_meta_err)}")

    except httpx.HTTPError as e:
        result["errors"].append(f"API请求失败: {str(e)}")
    except Exception as e:
        result["errors"].append(f"处理失败: {str(e)}")
        db.rollback()

    return result


@router.get("/data-sources/health")
async def check_data_sources_health(db: Session = Depends(get_db)):
    """检查各数据源连通性与数据可用性（不写库）。"""
    profile = _load_data_http_profile(db)
    tushare_token = _get_config(db, "data", "tushare_token", "").strip()
    sources = SOURCE_CANDIDATES
    results = []
    for src in sources:
        results.append(
            await _check_single_source_health(
                src,
                profile,
                num=20,
                tushare_token=tushare_token,
            )
        )

    ok_count = len([x for x in results if x["status"] == "ok"])
    overall = "ok" if ok_count == len(results) else ("partial" if ok_count > 0 else "error")

    requested_source = _get_config(db, "data", "primary_source", DATA_SOURCE_NAME).strip().lower() or DATA_SOURCE_NAME
    if requested_source not in SOURCE_DISPLAY_NAMES:
        requested_source = DATA_SOURCE_NAME
    configured_verify_source = _get_config(db, "data", "verify_source", "").strip().lower()
    dual_compare_enabled = _config_bool(_get_config(db, "data", "dual_compare_enabled", "0"))
    current = next((x for x in results if x["source_name"] == requested_source), None)
    if not current:
        current = next((x for x in results if x["source_name"] == DATA_SOURCE_NAME), None)

    recommended = _pick_recommended_primary_source(results)
    recommended_verify = _pick_recommended_verify_source(recommended, results) if recommended else ""

    return {
        "status": overall,
        "checked_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "requested_source_name": requested_source,
        "requested_source_status": current["status"] if current else "unknown",
        "recommended_primary_source": recommended,
        "recommended_primary_source_display_name": SOURCE_DISPLAY_NAMES.get(recommended, recommended) if recommended else "",
        "configured_verify_source_name": configured_verify_source,
        "configured_verify_source_display_name": SOURCE_DISPLAY_NAMES.get(configured_verify_source, configured_verify_source),
        "recommended_verify_source": recommended_verify,
        "recommended_verify_source_display_name": SOURCE_DISPLAY_NAMES.get(recommended_verify, recommended_verify) if recommended_verify else "",
        "dual_compare_enabled": dual_compare_enabled,
        "verify_conflict_with_primary": bool(
            dual_compare_enabled and (
                not configured_verify_source or configured_verify_source == requested_source
            )
        ),
        "profile": {
            "timeout_sec": profile.timeout_sec,
            "retry_count": profile.retry_count,
            "retry_backoff_sec": profile.retry_backoff_sec,
            "proxy_enabled": bool(profile.proxy_url),
            "proxy_strategy": profile.proxy_strategy,
        },
        "results": results,
    }


@router.post("/data-sources/recommend/apply")
async def apply_recommended_primary_source(db: Session = Depends(get_db)):
    """
    检查数据源健康状态并一键应用推荐主数据源。
    规则：sina > eastmoney > akshare（仅在对应源健康时可选）。
    """
    profile = _load_data_http_profile(db)
    tushare_token = _get_config(db, "data", "tushare_token", "").strip()
    sources = SOURCE_CANDIDATES
    results = []
    for src in sources:
        results.append(
            await _check_single_source_health(
                src,
                profile,
                num=20,
                tushare_token=tushare_token,
            )
        )

    requested_source = _get_config(db, "data", "primary_source", DATA_SOURCE_NAME).strip().lower() or DATA_SOURCE_NAME
    if requested_source not in SOURCE_DISPLAY_NAMES:
        requested_source = DATA_SOURCE_NAME
    configured_verify_source = _get_config(db, "data", "verify_source", "").strip().lower()
    dual_compare_enabled = _config_bool(_get_config(db, "data", "dual_compare_enabled", "0"))
    recommended = _pick_recommended_primary_source(results)
    recommended_verify = _pick_recommended_verify_source(recommended, results) if recommended else ""
    if not recommended:
        return {
            "status": "error",
            "applied": False,
            "message": "no healthy source available",
            "requested_source_name": requested_source,
            "recommended_primary_source": "",
            "recommended_verify_source": "",
            "results": results,
        }

    changed = recommended != requested_source
    verify_adjusted = False
    new_verify_source = configured_verify_source

    if changed:
        _upsert_config(db, "data", "primary_source", recommended)

    if dual_compare_enabled and (not new_verify_source or new_verify_source == recommended):
        if recommended_verify:
            new_verify_source = recommended_verify
            if new_verify_source != configured_verify_source:
                _upsert_config(db, "data", "verify_source", new_verify_source)
                verify_adjusted = True
        elif new_verify_source == recommended:
            new_verify_source = ""
            _upsert_config(db, "data", "verify_source", "")
            verify_adjusted = configured_verify_source != ""

    if changed or verify_adjusted:
        db.commit()

    return {
        "status": "ok",
        "applied": changed,
        "requested_source_name": requested_source,
        "new_primary_source": recommended,
        "new_primary_source_display_name": SOURCE_DISPLAY_NAMES.get(recommended, recommended),
        "recommended_verify_source": recommended_verify,
        "recommended_verify_source_display_name": SOURCE_DISPLAY_NAMES.get(recommended_verify, recommended_verify) if recommended_verify else "",
        "new_verify_source": new_verify_source,
        "new_verify_source_display_name": SOURCE_DISPLAY_NAMES.get(new_verify_source, new_verify_source) if new_verify_source else "",
        "verify_source_adjusted": verify_adjusted,
        "message": "applied" if changed else "already_recommended",
        "results": results,
    }


@router.put("/sectors/{sector_id}")
async def update_sector(
    sector_id: int,
    updates: dict,
    db: Session = Depends(get_db),
):
    """编辑板块（active/favorited 等）。"""
    sector = db.query(Sector).filter(Sector.id == sector_id).first()
    if not sector:
        return {"error": "板块不存在"}

    # 鍏佽鏇存柊鐨勫瓧娈?
    allowed = ["is_active", "is_favorited", "level", "parent_id", "name"]
    for key in allowed:
        if key in updates:
            setattr(sector, key, updates[key])

    db.commit()
    return {"status": "ok", "id": sector_id}


@router.delete("/sectors/{sector_id}")
async def delete_sector(sector_id: int, db: Session = Depends(get_db)):
    """删除板块。"""
    sector = db.query(Sector).filter(Sector.id == sector_id).first()
    if not sector:
        return {"error": "板块不存在"}

    # 鍚屾椂鍒犻櫎鍏宠仈鐨刣aily_data
    db.query(DailyData).filter(DailyData.sector_id == sector_id).delete()
    db.delete(sector)
    db.commit()
    return {"status": "ok", "deleted": sector.name}


@router.get("/sectors/{sector_id}/daily")
async def get_sector_daily(
    sector_id: int,
    days: int = Query(30, description="鏌ヨ澶╂暟"),
    db: Session = Depends(get_db),
):
    """获取板块历史每日数据。"""
    records = (
        db.query(DailyData)
        .filter(DailyData.sector_id == sector_id)
        .order_by(DailyData.date.desc())
        .limit(days)
        .all()
    )
    return [{
        "date": str(r.date),
        "daily_change": r.daily_change,
        "expected_change": r.expected_change,
        "deviation": r.deviation,
        "cumulative_deviation": r.cumulative_deviation,
        "net_amount": r.net_amount,
        "turnover": r.turnover,
        "lead_stock": r.lead_stock,
        "lead_stock_change": r.lead_stock_change,
        "quality_status": r.quality_status,
        "quality_reason": r.quality_reason,
    } for r in records]

@router.post("/sectors/{sector_id}/explain")
async def explain_sector_score(
    sector_id: int,
    target_date: str = Query(..., description="瑕佽В閲婄殑鍏蜂綋鏃ユ湡 YYYY-MM-DD"),
    db: Session = Depends(get_db)
):
    """请求 AI 解释指定日期的板块得分逻辑。"""
    from server.core.scoring import ScoringEngine
    from server.core.ai_client import AIClient
    from server.models import Relation
    
    dt = datetime.strptime(target_date, "%Y-%m-%d").date()
    
    sector = db.query(Sector).filter(Sector.id == sector_id).first()
    if not sector:
        return {"error": "板块不存在"}
        
    daily = db.query(DailyData).filter(
        DailyData.sector_id == sector_id, 
        DailyData.date == dt
    ).first()
    
    score = daily.cumulative_deviation if daily and daily.cumulative_deviation else 0.0
    
    engine = ScoringEngine(db)
    all_relations = db.query(Relation).all()
    # 绛涢€夌浉鍏宠仈鐨勬澘鍧?
    relevant_rels = [r for r in all_relations if r.source_id == sector_id or r.target_id == sector_id]
    
    breakdown_data = []
    
    for rel in relevant_rels:
        related_id = rel.target_id if rel.source_id == sector_id else rel.source_id
        related_sector = db.query(Sector).filter(Sector.id == related_id).first()
        if not related_sector: continue
        
        related_data = engine.get_daily_data(related_id, dt)
        if not related_data or not related_data.daily_change: continue
        
        confidence = engine.calc_confidence(related_id, dt)
        importance = engine.get_logic_importance(rel.logic_name)
        contribution = related_data.daily_change * rel.weight * rel.level_coefficient * confidence * importance
        
        breakdown_data.append({
            "related_sector": related_sector.name,
            "logic_name": rel.logic_name,
            "weight": round(rel.weight * rel.level_coefficient, 2),
            "daily_change": round(related_data.daily_change, 2),
            "confidence": round(confidence, 2),
            "contribution": abs(contribution)
        })
        
    # 濡傛灉鍏宠仈椤瑰お澶氾紝AI 鍙兘浼氭贩涔憋紝鍥犳瀵规暟鎹寜鐪熷疄鐨勬暟瀛﹁础鐚害缁濆鍊煎€掑簭锛屽彇鍓?8
    breakdown_data.sort(key=lambda x: x["contribution"], reverse=True)
    breakdown_data = breakdown_data[:8]

    # 闃插尽鏈哄埗锛氬鏋滄棤鏁版嵁锛岀洿鎺ュ垏鏂ぇ妯″瀷璇锋眰浠ヨ妭鐪佽祫婧?
    if not breakdown_data or score == 0.0:
        return {
            "sector": sector.name,
            "date": target_date,
            "score": score,
            "explanation": "当前目标日期缺乏足够交易数据或强关联异动明细，无法生成有效解释。"
        }

    ai_client = AIClient(db)
    explanation = await ai_client.explain_sector_score(
        sector_name=sector.name,
        target_date=target_date,
        score=score,
        breakdown_data=breakdown_data
    )
    
    return {
        "sector": sector.name,
        "date": target_date,
        "score": score,
        "explanation": explanation
    }


@router.delete("/relations/unlocked")
async def clear_unlocked_relations(db: Session = Depends(get_db)):
    """清理所有未锁定（is_locked=False）的板块关联。"""
    from server.models import Relation
    deleted_count = db.query(Relation).filter(Relation.is_locked == False).delete()
    db.commit()
    return {"status": "ok", "deleted_count": deleted_count}


@router.get("/sync-status")
async def get_sync_status(db: Session = Depends(get_db)):
    """获取最近一次同步状态。"""
    from sqlalchemy import func
    max_date = db.query(func.max(DailyData.date)).scalar()

    last_sync_date = str(max_date) if max_date else "鏆傛棤鏁版嵁"
    source_name = _get_config(db, "sync", "source_name", DATA_SOURCE_NAME)
    source_display_name = _get_config(
        db,
        "sync",
        "source_display_name",
        SOURCE_DISPLAY_NAMES.get(source_name, source_name),
    )
    source_degraded = _config_bool(_get_config(db, "sync", "source_degraded", "0"))
    requested_source_name = _get_config(db, "sync", "requested_source_name", _get_config(db, "data", "primary_source", source_name))
    requested_source_display_name = _get_config(
        db,
        "sync",
        "requested_source_display_name",
        SOURCE_DISPLAY_NAMES.get(requested_source_name, requested_source_name),
    )
    verify_source_name = _get_config(db, "sync", "verify_source_name", _get_config(db, "data", "verify_source", ""))
    verify_source_display_name = _get_config(
        db,
        "sync",
        "verify_source_display_name",
        SOURCE_DISPLAY_NAMES.get(verify_source_name, verify_source_name),
    )
    fallback_used = _config_bool(_get_config(db, "sync", "fallback_used", "0"))
    fallback_from = _get_config(db, "sync", "fallback_from", "")
    fallback_to = _get_config(db, "sync", "fallback_to", "")
    fallback_reason = _get_config(db, "sync", "fallback_reason", "")
    dual_compare_enabled = _config_bool(
        _get_config(db, "sync", "dual_compare_enabled", _get_config(db, "data", "dual_compare_enabled", "0"))
    )
    last_sync_at = _get_config(db, "sync", "last_sync_at", "")
    last_compare_status = _get_config(db, "sync", "last_compare_status", "disabled")
    last_compare_matched_count = int(_to_float(_get_config(db, "sync", "last_compare_matched_count", "0"), 0))
    last_compare_warn_count = int(_to_float(_get_config(db, "sync", "last_compare_warn_count", "0"), 0))
    last_compare_mean_abs_diff = _to_float(_get_config(db, "sync", "last_compare_mean_abs_diff", "0"), 0.0)
    last_compare_max_abs_diff = _to_float(_get_config(db, "sync", "last_compare_max_abs_diff", "0"), 0.0)
    last_compare_max_diff_name = _get_config(db, "sync", "last_compare_max_diff_name", "")
    last_compare_message = _get_config(db, "sync", "last_compare_message", "")
    last_new_sectors = _to_int(_get_config(db, "sync", "last_new_sectors", "0"), 0)
    last_updated_rows = _to_int(_get_config(db, "sync", "last_updated_rows", "0"), 0)
    last_total_rows = _to_int(_get_config(db, "sync", "last_total_rows", "0"), 0)
    last_quality_ok_rows = _to_int(_get_config(db, "sync", "last_quality_ok_rows", "0"), 0)
    last_quality_failed_rows = _to_int(_get_config(db, "sync", "last_quality_failed_rows", "0"), 0)

    return {
        "status": "ok",
        "last_sync_date": last_sync_date,
        "requested_source_name": requested_source_name,
        "requested_source_display_name": requested_source_display_name,
        "source_name": source_name,
        "source_display_name": source_display_name,
        "source_degraded": source_degraded,
        "verify_source_name": verify_source_name,
        "verify_source_display_name": verify_source_display_name,
        "fallback_used": fallback_used,
        "fallback_from": fallback_from,
        "fallback_to": fallback_to,
        "fallback_reason": fallback_reason,
        "dual_compare_enabled": dual_compare_enabled,
        "last_sync_at": last_sync_at,
        "last_new_sectors": last_new_sectors,
        "last_updated_rows": last_updated_rows,
        "last_total_rows": last_total_rows,
        "last_quality_ok_rows": last_quality_ok_rows,
        "last_quality_failed_rows": last_quality_failed_rows,
        "compare": {
            "status": last_compare_status,
            "matched_count": last_compare_matched_count,
            "warn_count": last_compare_warn_count,
            "mean_abs_diff": round(last_compare_mean_abs_diff, 4),
            "max_abs_diff": round(last_compare_max_abs_diff, 4),
            "max_diff_name": last_compare_max_diff_name,
            "message": last_compare_message,
        },
    }



