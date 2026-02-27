"""Shared HTTP client helpers for data source calls."""

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Optional, TypeVar

import httpx

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/117.0.0.0 Safari/537.36"
)

T = TypeVar("T")


@dataclass(frozen=True)
class HttpClientProfile:
    timeout_sec: float = 15.0
    retry_count: int = 2
    retry_backoff_sec: float = 0.6
    proxy_url: Optional[str] = None
    proxy_strategy: str = "auto"  # auto | force_proxy | force_direct
    user_agent: str = DEFAULT_USER_AGENT


def _to_bool(raw: Any, default: bool = False) -> bool:
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _to_float(raw: Any, default: float) -> float:
    try:
        if raw is None:
            return default
        txt = str(raw).strip()
        if txt == "":
            return default
        return float(txt)
    except Exception:
        return default


def _to_int(raw: Any, default: int) -> int:
    try:
        if raw is None:
            return default
        txt = str(raw).strip()
        if txt == "":
            return default
        return int(float(txt))
    except Exception:
        return default


def build_http_profile(
    config: Mapping[str, Any],
    *,
    default_user_agent: str = DEFAULT_USER_AGENT,
) -> HttpClientProfile:
    timeout_sec = _to_float(config.get("request_timeout_sec"), 15.0)
    retry_count = max(0, _to_int(config.get("request_retry_count"), 2))
    retry_backoff_sec = max(0.0, _to_float(config.get("request_retry_backoff_sec"), 0.6))

    proxy_enabled = _to_bool(config.get("http_proxy_enabled"), False)
    proxy_raw = str(config.get("http_proxy", "") or "").strip()
    proxy_url = proxy_raw if proxy_enabled and proxy_raw else None
    proxy_strategy = str(config.get("http_proxy_strategy", "auto") or "auto").strip().lower()
    if proxy_strategy not in {"auto", "force_proxy", "force_direct"}:
        proxy_strategy = "auto"
    if proxy_url is None and proxy_strategy == "force_proxy":
        # No proxy configured; degrade to direct mode to avoid hard failure.
        proxy_strategy = "force_direct"

    user_agent = str(config.get("http_user_agent", "") or "").strip() or default_user_agent

    return HttpClientProfile(
        timeout_sec=timeout_sec,
        retry_count=retry_count,
        retry_backoff_sec=retry_backoff_sec,
        proxy_url=proxy_url,
        proxy_strategy=proxy_strategy,
        user_agent=user_agent,
    )


async def retry_async(
    task_factory: Callable[[], Awaitable[T]],
    *,
    retry_count: int,
    retry_backoff_sec: float,
    retryable: tuple[type[BaseException], ...] = (Exception,),
) -> T:
    if retry_count < 0:
        retry_count = 0
    if retry_backoff_sec < 0:
        retry_backoff_sec = 0.0

    last_error: Optional[BaseException] = None
    for attempt in range(retry_count + 1):
        try:
            return await task_factory()
        except retryable as exc:
            last_error = exc
            if attempt >= retry_count:
                break
            await asyncio.sleep(retry_backoff_sec * (attempt + 1))
    assert last_error is not None
    raise last_error


async def get_json(
    url: str,
    *,
    params: Optional[Mapping[str, Any]] = None,
    headers: Optional[Mapping[str, str]] = None,
    profile: Optional[HttpClientProfile] = None,
) -> Any:
    cfg = profile or HttpClientProfile()
    req_headers = dict(headers or {})
    if not any(k.lower() == "user-agent" for k in req_headers.keys()):
        req_headers["User-Agent"] = cfg.user_agent

    transport_candidates: list[Optional[str]]
    if cfg.proxy_strategy == "force_proxy":
        transport_candidates = [cfg.proxy_url]
    elif cfg.proxy_strategy == "force_direct":
        transport_candidates = [None]
    else:
        # Auto mode: prefer direct first to avoid being trapped by unstable local proxies.
        transport_candidates = [None, cfg.proxy_url] if cfg.proxy_url else [None]

    last_error: Optional[BaseException] = None

    for proxy in transport_candidates:
        async def _request_once() -> Any:
            async with httpx.AsyncClient(
                timeout=cfg.timeout_sec,
                proxy=proxy,
                trust_env=False,
                follow_redirects=True,
            ) as client:
                response = await client.get(url, params=params, headers=req_headers)
                response.raise_for_status()
                return response.json()

        try:
            return await retry_async(
                _request_once,
                retry_count=cfg.retry_count,
                retry_backoff_sec=cfg.retry_backoff_sec,
                retryable=(httpx.HTTPError, ValueError),
            )
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            continue

    assert last_error is not None
    raise last_error
