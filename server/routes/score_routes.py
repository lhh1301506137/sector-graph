# server/routes/score_routes.py
# 得分计算 + 排行路由

from collections import Counter
from datetime import date, datetime
from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from server.database import get_db
from server.models import Prediction, Sector, DailyData, Config
from server.core.scoring import run_scoring

router = APIRouter()


class ScoringRunRequest(BaseModel):
    target_date: Optional[str] = None  # YYYY-MM-DD
    publish: bool = True
    run_type: str = "prod"  # prod/backtest/draft
    run_id: Optional[str] = None


def get_quality_gate(db: Session) -> int:
    """读取质量门控阈值（允许失败条数）。默认 0 表示严格模式。"""
    row = db.query(Config).filter(
        Config.category == "algo",
        Config.key == "quality_max_failed_rows"
    ).first()
    if not row or row.value is None or str(row.value).strip() == "":
        return 0
    try:
        return max(0, int(row.value))
    except Exception:
        return 0


def get_config_value(db: Session, category: str, key: str, default: str = "") -> str:
    row = db.query(Config).filter(
        Config.category == category,
        Config.key == key,
    ).first()
    if not row or row.value is None:
        return default
    value = str(row.value).strip()
    return value if value else default


def get_config_bool(db: Session, category: str, key: str, default: str = "0") -> bool:
    value = get_config_value(db, category, key, default)
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_quality_stale_minutes(db: Session) -> int:
    raw = get_config_value(db, "algo", "quality_stale_minutes", "240")
    try:
        return max(1, int(raw))
    except Exception:
        return 240


def get_sync_last_sync_at(db: Session) -> str:
    return get_config_value(db, "sync", "last_sync_at", "")


def get_sync_source_name(db: Session) -> str:
    return get_config_value(
        db,
        "sync",
        "source_name",
        get_config_value(db, "data", "primary_source", "sina"),
    )


def split_quality_reasons(raw_reason: str) -> list[str]:
    if not raw_reason:
        return []
    return [part.strip() for part in str(raw_reason).split(";") if part.strip()]


def build_freshness_snapshot(db: Session) -> dict:
    stale_minutes = get_quality_stale_minutes(db)
    last_sync_at = get_sync_last_sync_at(db)
    now = datetime.now()

    if not last_sync_at:
        return {
            "last_sync_at": "",
            "sync_age_minutes": None,
            "stale_minutes": stale_minutes,
            "freshness_ok": False,
            "freshness_reason": "missing_last_sync_at",
        }

    try:
        sync_dt = datetime.strptime(last_sync_at, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return {
            "last_sync_at": last_sync_at,
            "sync_age_minutes": None,
            "stale_minutes": stale_minutes,
            "freshness_ok": False,
            "freshness_reason": "invalid_last_sync_at",
        }

    age_minutes = int((now - sync_dt).total_seconds() // 60)
    freshness_ok = age_minutes <= stale_minutes
    return {
        "last_sync_at": last_sync_at,
        "sync_age_minutes": age_minutes,
        "stale_minutes": stale_minutes,
        "freshness_ok": freshness_ok,
        "freshness_reason": "" if freshness_ok else f"sync_age_minutes_gt_{stale_minutes}",
    }


def build_reason_distribution(daily_rows: list[DailyData]) -> list[dict]:
    reason_counter: Counter[str] = Counter()
    for row in daily_rows:
        if getattr(row, "quality_status", "ok") == "ok":
            continue
        reasons = split_quality_reasons(getattr(row, "quality_reason", ""))
        if not reasons:
            reasons = ["unknown_reason"]
        for reason in reasons:
            reason_counter[reason] += 1

    return [{"reason": reason, "count": count} for reason, count in reason_counter.most_common()]


def classify_reason_bucket(reason: str) -> str:
    rs = str(reason or "").strip().lower()
    if not rs:
        return "other"
    if rs.startswith("missing_") or rs.endswith("_empty"):
        return "missing"
    if rs.startswith("anomaly_"):
        return "anomaly"
    if rs.startswith("invalid_") or rs == "parse_failed":
        return "invalid"
    if "fallback" in rs:
        return "fallback"
    return "other"


def build_failure_bucket_stats(daily_rows: list[DailyData], total_rows: int) -> dict:
    bucket_counter: Counter[str] = Counter()

    for row in daily_rows:
        if getattr(row, "quality_status", "ok") == "ok":
            continue

        reasons = split_quality_reasons(getattr(row, "quality_reason", ""))
        if not reasons:
            bucket_counter["other"] += 1
            continue

        buckets_for_row = {classify_reason_bucket(reason) for reason in reasons}
        if not buckets_for_row:
            buckets_for_row = {"other"}
        for bucket in buckets_for_row:
            bucket_counter[bucket] += 1

    def _val(name: str) -> int:
        return int(bucket_counter.get(name, 0))

    return {
        "missing_rows": _val("missing"),
        "anomaly_rows": _val("anomaly"),
        "invalid_rows": _val("invalid"),
        "fallback_rows": _val("fallback"),
        "other_rows": _val("other"),
        "missing_ratio": round((_val("missing") / total_rows), 4) if total_rows > 0 else 0.0,
        "anomaly_ratio": round((_val("anomaly") / total_rows), 4) if total_rows > 0 else 0.0,
        "invalid_ratio": round((_val("invalid") / total_rows), 4) if total_rows > 0 else 0.0,
        "fallback_ratio": round((_val("fallback") / total_rows), 4) if total_rows > 0 else 0.0,
        "other_ratio": round((_val("other") / total_rows), 4) if total_rows > 0 else 0.0,
    }


def build_source_distribution(db: Session, total_rows: int, ok_rows: int, failed_rows: int) -> list[dict]:
    source_name = get_sync_source_name(db)
    return [{
        "source_name": source_name,
        "total_rows": total_rows,
        "ok_rows": ok_rows,
        "failed_rows": failed_rows,
    }]


def build_quality_snapshot(db: Session, dt: date, daily_rows: list[DailyData]) -> dict:
    total_rows = len(daily_rows)
    failed_rows = sum(1 for r in daily_rows if getattr(r, "quality_status", "ok") != "ok")
    ok_rows = total_rows - failed_rows
    quality_gate = get_quality_gate(db)
    freshness = build_freshness_snapshot(db)
    reasons = build_reason_distribution(daily_rows)
    failure_buckets = build_failure_bucket_stats(daily_rows, total_rows)
    by_source = build_source_distribution(db, total_rows, ok_rows, failed_rows)

    snapshot = {
        "date": str(dt),
        "total_rows": total_rows,
        "ok_rows": ok_rows,
        "failed_rows": failed_rows,
        "failed_ratio": round((failed_rows / total_rows), 4) if total_rows > 0 else 0.0,
        "max_failed_rows": quality_gate,
        "source_distribution": by_source,
        "reason_distribution": reasons,
        "failure_buckets": failure_buckets,
        **freshness,
    }
    gate = evaluate_publish_gate(db, snapshot)
    snapshot["publish_allowed"] = gate["publish_allowed"]
    snapshot["publish_blocked_reasons"] = gate["blocked_reasons"]
    snapshot["publish_gate_config"] = gate["gate_config"]
    return snapshot


def evaluate_publish_gate(db: Session, quality_snapshot: dict) -> dict:
    blocked_reasons = []
    max_failed_rows = int(quality_snapshot.get("max_failed_rows", 0))
    failed_rows = int(quality_snapshot.get("failed_rows", 0))
    total_rows = int(quality_snapshot.get("total_rows", 0))
    freshness_ok = bool(quality_snapshot.get("freshness_ok", False))

    min_total_rows_raw = get_config_value(db, "algo", "quality_min_total_rows", "1")
    try:
        min_total_rows = max(0, int(min_total_rows_raw))
    except Exception:
        min_total_rows = 1

    require_freshness = get_config_bool(db, "algo", "quality_require_freshness_for_publish", "1")

    if failed_rows > max_failed_rows:
        blocked_reasons.append({
            "rule": "failed_rows_threshold",
            "message": f"failed_rows={failed_rows} 超过阈值 {max_failed_rows}",
        })
    if total_rows < min_total_rows:
        blocked_reasons.append({
            "rule": "min_total_rows",
            "message": f"total_rows={total_rows} 低于最小要求 {min_total_rows}",
        })
    if require_freshness and (not freshness_ok):
        blocked_reasons.append({
            "rule": "freshness_required",
            "message": quality_snapshot.get("freshness_reason", "freshness_failed"),
        })

    return {
        "publish_allowed": len(blocked_reasons) == 0,
        "blocked_reasons": blocked_reasons,
        "gate_config": {
            "max_failed_rows": max_failed_rows,
            "min_total_rows": min_total_rows,
            "require_freshness_for_publish": require_freshness,
        },
    }


def to_trend_item(snapshot: dict) -> dict:
    blocked_rules = []
    for item in snapshot.get("publish_blocked_reasons") or []:
        if not isinstance(item, dict):
            continue
        rule = str(item.get("rule", "")).strip()
        if rule:
            blocked_rules.append(rule)

    top_reason = ""
    reason_distribution = snapshot.get("reason_distribution") or []
    if reason_distribution and isinstance(reason_distribution[0], dict):
        top_reason = str(reason_distribution[0].get("reason", "")).strip()

    raw_failure_buckets = snapshot.get("failure_buckets") if isinstance(snapshot, dict) else {}
    if not isinstance(raw_failure_buckets, dict):
        raw_failure_buckets = {}

    def _bucket_int(name: str) -> int:
        try:
            return int(raw_failure_buckets.get(name, 0) or 0)
        except Exception:
            return 0

    def _bucket_ratio(name: str) -> float:
        try:
            return float(raw_failure_buckets.get(name, 0.0) or 0.0)
        except Exception:
            return 0.0

    failure_buckets = {
        "missing_rows": _bucket_int("missing_rows"),
        "anomaly_rows": _bucket_int("anomaly_rows"),
        "invalid_rows": _bucket_int("invalid_rows"),
        "fallback_rows": _bucket_int("fallback_rows"),
        "other_rows": _bucket_int("other_rows"),
        "missing_ratio": _bucket_ratio("missing_ratio"),
        "anomaly_ratio": _bucket_ratio("anomaly_ratio"),
        "invalid_ratio": _bucket_ratio("invalid_ratio"),
        "fallback_ratio": _bucket_ratio("fallback_ratio"),
        "other_ratio": _bucket_ratio("other_ratio"),
    }

    return {
        "date": snapshot.get("date"),
        "total_rows": snapshot.get("total_rows", 0),
        "ok_rows": snapshot.get("ok_rows", 0),
        "failed_rows": snapshot.get("failed_rows", 0),
        "failed_ratio": snapshot.get("failed_ratio", 0.0),
        "publish_allowed": bool(snapshot.get("publish_allowed", False)),
        "blocked_rules": blocked_rules,
        "top_reason": top_reason,
        "reason_kinds": len(reason_distribution),
        "failure_buckets": failure_buckets,
    }


@router.get("/data-quality/latest")
async def get_latest_data_quality(
    target_date: Optional[str] = Query(None, description="日期, 默认今天"),
    db: Session = Depends(get_db)
):
    if target_date:
        dt = date.fromisoformat(target_date)
    else:
        dt = date.today()

    daily_rows = db.query(DailyData).filter(DailyData.date == dt).all()
    return build_quality_snapshot(db, dt, daily_rows)


@router.get("/data-quality/trend")
async def get_data_quality_trend(
    days: int = Query(10, ge=1, le=180, description="最近天数"),
    db: Session = Depends(get_db),
):
    latest_dates = [
        row[0]
        for row in (
            db.query(DailyData.date)
            .distinct()
            .order_by(DailyData.date.desc())
            .limit(days)
            .all()
        )
        if row and row[0]
    ]

    items = []
    for dt in latest_dates:
        daily_rows = db.query(DailyData).filter(DailyData.date == dt).all()
        snapshot = build_quality_snapshot(db, dt, daily_rows)
        items.append(to_trend_item(snapshot))

    # Keep newest first for dashboard-like usage.
    return {
        "days": days,
        "count": len(items),
        "items": items,
    }


@router.get("/data-quality/failed")
async def get_failed_data_quality_rows(
    target_date: Optional[str] = Query(None, description="日期, 默认今天"),
    reason: Optional[str] = Query(None, description="按质量原因精确筛选"),
    category_type: Optional[str] = Query(None, description="按板块类型筛选: 行业/概念"),
    search: Optional[str] = Query(None, description="按板块名称模糊匹配"),
    limit: int = Query(50, ge=1, le=500, description="返回数量"),
    db: Session = Depends(get_db),
):
    if target_date:
        dt = date.fromisoformat(target_date)
    else:
        dt = date.today()

    query = (
        db.query(DailyData, Sector)
        .join(Sector, DailyData.sector_id == Sector.id)
        .filter(
            DailyData.date == dt,
            DailyData.quality_status != "ok",
        )
    )

    if category_type:
        query = query.filter(Sector.category_type == category_type)
    if search:
        query = query.filter(Sector.name.contains(search))
    if reason:
        query = query.filter(DailyData.quality_reason.contains(reason))

    total_failed_rows = query.count()
    rows = query.order_by(Sector.name).limit(limit).all()

    items = []
    for daily, sector in rows:
        reasons = split_quality_reasons(getattr(daily, "quality_reason", ""))

        items.append({
            "date": str(daily.date),
            "sector_id": sector.id,
            "sector_name": sector.name,
            "category_type": sector.category_type,
            "quality_status": daily.quality_status,
            "quality_reason": daily.quality_reason,
            "quality_reasons": reasons,
            "daily_change": daily.daily_change,
            "net_amount": daily.net_amount,
            "turnover": daily.turnover,
            "lead_stock": daily.lead_stock,
            "lead_stock_change": daily.lead_stock_change,
        })

    reason_counter: Counter[str] = Counter()
    for item in items:
        reasons = item.get("quality_reasons") or []
        if not reasons:
            reason_counter["unknown_reason"] += 1
            continue
        for rs in reasons:
            reason_counter[rs] += 1

    return {
        "date": str(dt),
        "total_failed_rows": total_failed_rows,
        "returned_rows": len(items),
        "reason_distribution": [{"reason": k, "count": v} for k, v in reason_counter.most_common()],
        "items": items,
    }


@router.post("/scoring/run")
async def run_scoring_api(payload: Optional[ScoringRunRequest] = None, db: Session = Depends(get_db)):
    """运行得分计算"""
    payload = payload or ScoringRunRequest()

    target_date = None
    if payload.target_date:
        target_date = date.fromisoformat(payload.target_date)
    else:
        target_date = date.today()

    # 质量门控摘要：用于前端和日志观察
    daily_rows = db.query(DailyData).filter(DailyData.date == target_date).all()
    quality = build_quality_snapshot(db, target_date, daily_rows)
    failed_rows = quality["failed_rows"]
    quality_gate = quality["max_failed_rows"]

    if payload.publish and (not quality.get("publish_allowed", False)):
        raise HTTPException(
            status_code=400,
            detail={
                "error": (
                    f"质量门控未通过：failed_rows={failed_rows}, 阈值={quality_gate}, "
                    f"blocked_rules={len(quality.get('publish_blocked_reasons', []))}，本次禁止发布。"
                ),
                "quality": quality,
            }
        )

    run_id = payload.run_id or datetime.now().strftime("sc_%Y%m%d_%H%M%S")
    result = run_scoring(
        db,
        target_date=target_date,
        persist_prediction=payload.publish,
        run_type=payload.run_type,
        run_id=run_id,
    )
    result["quality"] = quality
    return result


@router.get("/ranking")
async def get_ranking(
    db: Session = Depends(get_db),
    target_date: Optional[str] = Query(None, description="日期, 默认今天"),
    run_type: str = Query("prod", description="结果类型: prod/backtest/draft"),
    category_type: Optional[str] = Query(None, description="筛选：行业/概念"),
    favorited: Optional[bool] = Query(None, description="筛选：仅关注"),
    search: Optional[str] = Query(None, description="搜索关键词"),
    limit: int = Query(50, description="返回数量"),
):
    """获取预测排行榜"""
    if target_date:
        the_date = date.fromisoformat(target_date)
    else:
        the_date = date.today()

    # 查询预测+板块+当日数据
    query = (
        db.query(Prediction, Sector, DailyData)
        .join(Sector, Prediction.sector_id == Sector.id)
        .outerjoin(DailyData, (DailyData.sector_id == Sector.id) & (DailyData.date == the_date))
        .filter(
            Prediction.date == the_date,
            Prediction.run_type == run_type,
            Sector.is_active == True
        )
    )

    if category_type:
        query = query.filter(Sector.category_type == category_type)
    if favorited is not None:
        query = query.filter(Sector.is_favorited == favorited)
    if search:
        query = query.filter(Sector.name.contains(search))

    query = query.order_by(Prediction.rank).limit(limit)
    results = query.all()

    return [{
        "rank": p.rank,
        "sector_id": s.id,
        "name": s.name,
        "category_type": s.category_type,
        "is_favorited": s.is_favorited,
        "score": p.score,
        "run_type": p.run_type,
        "run_id": p.run_id,
        "daily_change": d.daily_change if d else None,
        "expected_change": d.expected_change if d else None,
        "deviation": d.deviation if d else None,
        "net_amount": d.net_amount if d else None,
        "lead_stock": d.lead_stock if d else None,
        "lead_stock_change": d.lead_stock_change if d else None,
    } for p, s, d in results]
