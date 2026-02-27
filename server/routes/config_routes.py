# server/routes/config_routes.py
# System configuration and algo config versioning routes

import json
import re
from datetime import date, datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from server.database import SessionLocal, get_db
from server.models import (
    AlgoConfigVersion,
    AlgoOptimizationSuggestion,
    BacktestJob,
    Config,
    DailyData,
)
from server.core.backtest import BacktestEngine
from server.core.scoring import run_scoring
from server.routes.score_routes import build_quality_snapshot

router = APIRouter()

_QUALITY_REQUIRED_FIELDS_DEFAULT = "name,category_type,daily_change,net_amount,turnover,lead_stock_change"
_QUALITY_INT_MIN = {
    "quality_max_failed_rows": 0,
    "quality_min_total_rows": 0,
    "quality_stale_minutes": 1,
}
_QUALITY_FLOAT_MIN = {
    "quality_daily_change_abs_max": 1.0,
    "quality_lead_stock_change_abs_max": 1.0,
    "quality_turnover_abs_max": 1.0,
    "quality_net_amount_abs_max": 1.0,
}
_QUALITY_BOOL_KEYS = {"quality_require_freshness_for_publish"}
_SECRET_CONFIG_KEYS = {
    ("ai", "api_key"),
    ("data", "tushare_token"),
}


class SaveConfigVersionRequest(BaseModel):
    snapshot: Optional[Dict[str, Any]] = None
    source_type: str = "manual"
    source_run_id: str = ""
    source_suggestion_id: int = 0
    reason: str = ""
    apply_now: bool = False


class ApplyConfigVersionRequest(BaseModel):
    reason: str = ""
    run_scoring: bool = False
    run_backtest: bool = False
    backtest_days: int = 60


def _normalize_int_str(value, default: int, minimum: int) -> str:
    try:
        normalized = int(float(str(value).strip()))
    except Exception:
        normalized = default
    if normalized < minimum:
        normalized = minimum
    return str(normalized)


def _normalize_float_str(value, default: float, minimum: float) -> str:
    try:
        normalized = float(str(value).strip())
    except Exception:
        normalized = default
    if normalized < minimum:
        normalized = minimum
    if normalized.is_integer():
        return str(int(normalized))
    return str(normalized)


def _normalize_bool01_str(value, default: str = "1") -> str:
    txt = str(value).strip().lower()
    if txt in {"1", "true", "yes", "on"}:
        return "1"
    if txt in {"0", "false", "no", "off"}:
        return "0"
    return "1" if str(default).strip() in {"1", "true", "yes", "on"} else "0"


def _normalize_required_fields(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return _QUALITY_REQUIRED_FIELDS_DEFAULT

    fields = []
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", token):
            continue
        if token not in fields:
            fields.append(token)

    if not fields:
        return _QUALITY_REQUIRED_FIELDS_DEFAULT
    return ",".join(fields)


def _normalize_config_value(category: str, key: str, value):
    if category != "algo":
        return value

    if key in _QUALITY_INT_MIN:
        minimum = _QUALITY_INT_MIN[key]
        default = minimum if key != "quality_stale_minutes" else 240
        if key == "quality_max_failed_rows":
            default = 25
        elif key == "quality_min_total_rows":
            default = 180
        return _normalize_int_str(value, default=default, minimum=minimum)

    if key in _QUALITY_FLOAT_MIN:
        minimum = _QUALITY_FLOAT_MIN[key]
        default = 0.0
        if key == "quality_daily_change_abs_max":
            default = 20.0
        elif key == "quality_lead_stock_change_abs_max":
            default = 25.0
        elif key == "quality_turnover_abs_max":
            default = 30.0
        elif key == "quality_net_amount_abs_max":
            default = 500.0
        return _normalize_float_str(value, default=default, minimum=minimum)

    if key in _QUALITY_BOOL_KEYS:
        return _normalize_bool01_str(value, default="1")

    if key == "quality_required_fields":
        return _normalize_required_fields(value)

    return value


def _mask_secret(value: str) -> str:
    txt = str(value or "")
    if not txt:
        return ""
    if len(txt) <= 8:
        return "****"
    return f"{txt[:4]}****{txt[-4:]}"


def _safe_json_loads(raw: str, fallback):
    text = str(raw or "").strip()
    if not text:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        return fallback


def _load_config_map(db: Session, category: str) -> Dict[str, str]:
    rows = db.query(Config).filter(Config.category == category).all()
    return {str(item.key): str(item.value) for item in rows}


def _normalize_snapshot(snapshot: Dict[str, Any]) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    for key, value in (snapshot or {}).items():
        skey = str(key or "").strip()
        if not skey:
            continue
        nval = _normalize_config_value("algo", skey, value)
        normalized[skey] = str(nval)
    return normalized


def _diff_changed_keys(old_map: Dict[str, Any], new_map: Dict[str, Any]) -> list[str]:
    changed = []
    keys = sorted(set(old_map.keys()) | set(new_map.keys()))
    for key in keys:
        if str(old_map.get(key, "")) != str(new_map.get(key, "")):
            changed.append(key)
    return changed


def _apply_algo_snapshot(db: Session, snapshot: Dict[str, str]):
    for key, value in snapshot.items():
        row = db.query(Config).filter(
            Config.category == "algo",
            Config.key == key,
        ).first()
        if row:
            row.value = str(value)
        else:
            db.add(Config(category="algo", key=key, value=str(value)))


def _serialize_algo_version(row: AlgoConfigVersion) -> dict:
    snapshot = _safe_json_loads(row.snapshot, {})
    changed_keys = _safe_json_loads(row.changed_keys, [])
    if not isinstance(snapshot, dict):
        snapshot = {}
    if not isinstance(changed_keys, list):
        changed_keys = []
    return {
        "id": row.id,
        "source_type": row.source_type,
        "source_run_id": row.source_run_id,
        "source_suggestion_id": row.source_suggestion_id,
        "reason": row.reason,
        "status": row.status,
        "snapshot": snapshot,
        "changed_keys": changed_keys,
        "created_at": row.created_at.strftime("%Y-%m-%d %H:%M:%S") if row.created_at else None,
        "applied_at": row.applied_at.strftime("%Y-%m-%d %H:%M:%S") if row.applied_at else None,
    }


def _mark_suggestion_applied(db: Session, suggestion_id: int):
    sid = int(suggestion_id or 0)
    if sid <= 0:
        return
    row = db.query(AlgoOptimizationSuggestion).filter(AlgoOptimizationSuggestion.id == sid).first()
    if not row:
        return
    row.status = "applied"
    row.applied_at = datetime.now()


def _new_backtest_run_id(db: Session) -> str:
    for _ in range(5):
        candidate = datetime.now().strftime("bt_%Y%m%d_%H%M%S_%f")[:-3]
        exists = db.query(BacktestJob).filter(BacktestJob.run_id == candidate).first()
        if not exists:
            return candidate
    return datetime.now().strftime("bt_%Y%m%d_%H%M%S_%f")


async def _run_backtest_job_task(days: int, run_id: str):
    db = SessionLocal()
    try:
        job = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
        if job:
            if job.status == "cancelled":
                return
            job.status = "running"
            job.started_at = datetime.now()
            job.error_message = ""
            db.commit()

        def should_cancel() -> bool:
            row = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
            return bool(row and row.status == "cancelled")

        engine = BacktestEngine(db)
        result = await engine.run_period_backtest(days, run_id, should_cancel=should_cancel)

        job = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
        if job:
            if job.status == "cancelled" or bool(result.get("cancelled")):
                job.status = "cancelled"
                job.ended_at = datetime.now()
                if not job.error_message:
                    job.error_message = "cancelled by user"
            else:
                job.status = "completed"
                job.ended_at = datetime.now()
                job.error_message = ""
            db.commit()
    except Exception as e:
        job = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
        if job and job.status != "cancelled":
            job.status = "failed"
            job.ended_at = datetime.now()
            job.error_message = str(e)[:1000]
            db.commit()
    finally:
        db.close()


def _run_prod_scoring(db: Session) -> dict:
    target_date = date.today()
    daily_rows = db.query(DailyData).filter(DailyData.date == target_date).all()
    quality = build_quality_snapshot(db, target_date, daily_rows)
    if not quality.get("publish_allowed", False):
        return {
            "status": "blocked",
            "reason": "quality_gate_blocked",
            "quality": quality,
        }

    run_id = datetime.now().strftime("sc_cfg_%Y%m%d_%H%M%S")
    result = run_scoring(
        db,
        target_date=target_date,
        persist_prediction=True,
        run_type="prod",
        run_id=run_id,
    )
    return {
        "status": "ok",
        "run_id": run_id,
        "result": result,
        "quality": quality,
    }


@router.get("/config")
async def get_all_config(db: Session = Depends(get_db)):
    """Get all config values grouped by category."""
    configs = db.query(Config).all()
    result = {}
    for c in configs:
        if c.category not in result:
            result[c.category] = {}

        val = c.value
        if (c.category, c.key) in _SECRET_CONFIG_KEYS:
            masked = _mask_secret(val)
            result[c.category][c.key] = ""
            result[c.category][f"{c.key}_masked"] = masked
            result[c.category][f"{c.key}_set"] = bool(val)
            continue

        result[c.category][c.key] = val
    return result


@router.post("/config")
async def update_config(data: Dict[str, Dict[str, str]], db: Session = Depends(get_db)):
    """Batch update config values."""
    for category, items in data.items():
        for key, value in items.items():
            if (category, key) in _SECRET_CONFIG_KEYS:
                if value is None or str(value).strip() == "":
                    continue
                if "****" in str(value):
                    continue

            normalized_value = _normalize_config_value(category, key, value)
            config = db.query(Config).filter(
                Config.category == category,
                Config.key == key,
            ).first()
            if config:
                config.value = str(normalized_value)
            else:
                db.add(Config(category=category, key=key, value=str(normalized_value)))

    db.commit()
    return {"status": "ok"}


@router.get("/config/versions")
async def list_algo_config_versions(
    limit: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
):
    rows = db.query(AlgoConfigVersion).order_by(AlgoConfigVersion.id.desc()).limit(limit).all()
    return [_serialize_algo_version(row) for row in rows]


@router.get("/config/versioning/status")
async def get_algo_versioning_status(db: Session = Depends(get_db)):
    current_algo = _load_config_map(db, "algo")

    rows = db.query(AlgoConfigVersion).order_by(AlgoConfigVersion.id.desc()).limit(100).all()
    matched_version = None
    for row in rows:
        snapshot = _safe_json_loads(row.snapshot, {})
        if not isinstance(snapshot, dict):
            continue
        if _diff_changed_keys(current_algo, snapshot) == []:
            matched_version = row
            break

    latest = rows[0] if rows else None
    latest_applied = db.query(AlgoConfigVersion).filter(
        AlgoConfigVersion.applied_at.isnot(None)
    ).order_by(AlgoConfigVersion.applied_at.desc(), AlgoConfigVersion.id.desc()).first()

    return {
        "total_versions": db.query(AlgoConfigVersion).count(),
        "current_algo_keys": len(current_algo),
        "current_version": _serialize_algo_version(matched_version) if matched_version else None,
        "latest_version": _serialize_algo_version(latest) if latest else None,
        "latest_applied_version": _serialize_algo_version(latest_applied) if latest_applied else None,
    }


@router.post("/config/versions/save")
async def save_algo_config_version(
    payload: SaveConfigVersionRequest,
    db: Session = Depends(get_db),
):
    current_algo = _load_config_map(db, "algo")
    input_snapshot = payload.snapshot or {}

    if input_snapshot:
        snapshot = _normalize_snapshot(input_snapshot)
    else:
        snapshot = dict(current_algo)

    if not snapshot:
        raise HTTPException(status_code=400, detail={"error": "algo_snapshot_is_empty"})

    changed_keys = _diff_changed_keys(current_algo, snapshot)

    row = AlgoConfigVersion(
        source_type=str(payload.source_type or "manual").strip() or "manual",
        source_run_id=str(payload.source_run_id or "").strip(),
        source_suggestion_id=max(0, int(payload.source_suggestion_id or 0)),
        reason=str(payload.reason or "").strip(),
        status="saved",
        snapshot=json.dumps(snapshot, ensure_ascii=False),
        changed_keys=json.dumps(changed_keys, ensure_ascii=False),
    )
    db.add(row)
    db.flush()

    if payload.apply_now:
        _apply_algo_snapshot(db, snapshot)
        row.status = "applied"
        row.applied_at = datetime.now()
        _mark_suggestion_applied(db, row.source_suggestion_id)

    db.commit()
    db.refresh(row)

    return {
        "status": "ok",
        "applied": bool(payload.apply_now),
        "version": _serialize_algo_version(row),
    }


@router.post("/config/versions/{version_id}/apply")
async def apply_algo_config_version(
    version_id: int,
    payload: ApplyConfigVersionRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    row = db.query(AlgoConfigVersion).filter(AlgoConfigVersion.id == version_id).first()
    if not row:
        raise HTTPException(status_code=404, detail={"error": f"config_version_not_found: {version_id}"})

    snapshot = _safe_json_loads(row.snapshot, {})
    if not isinstance(snapshot, dict) or not snapshot:
        raise HTTPException(status_code=400, detail={"error": f"config_version_snapshot_invalid: {version_id}"})

    before_apply = _load_config_map(db, "algo")
    _apply_algo_snapshot(db, {str(k): str(v) for k, v in snapshot.items()})

    row.status = "applied"
    row.applied_at = datetime.now()
    reason = str(payload.reason or "").strip()
    if reason:
        row.reason = reason

    _mark_suggestion_applied(db, row.source_suggestion_id)

    scoring_result = None
    run_scoring_enabled = bool(payload.run_scoring)
    if run_scoring_enabled:
        scoring_result = _run_prod_scoring(db)
        if scoring_result.get("status") == "ok":
            row.status = "refeeded"
        else:
            row.status = "applied"

    backtest_job = None
    run_backtest_enabled = bool(payload.run_backtest)
    if run_backtest_enabled:
        days = max(1, int(payload.backtest_days or 60))
        bt_run_id = _new_backtest_run_id(db)
        params_snapshot = json.dumps(
            {
                "days": days,
                "trigger": "config_version_apply",
                "version_id": version_id,
                "run_scoring": run_scoring_enabled,
            },
            ensure_ascii=False,
        )
        db.add(BacktestJob(
            run_id=bt_run_id,
            status="queued",
            days=days,
            params_snapshot=params_snapshot,
        ))
        backtest_job = {
            "status": "queued",
            "run_id": bt_run_id,
            "days": days,
        }
        background_tasks.add_task(_run_backtest_job_task, days, bt_run_id)

    db.commit()
    db.refresh(row)

    after_apply = _load_config_map(db, "algo")
    return {
        "status": "ok",
        "version": _serialize_algo_version(row),
        "applied_changed_keys": _diff_changed_keys(before_apply, after_apply),
        "scoring": scoring_result,
        "backtest": backtest_job,
    }
