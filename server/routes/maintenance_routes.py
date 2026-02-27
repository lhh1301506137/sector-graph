# server/routes/maintenance_routes.py
# 维护模式巡检与告警摘要接口

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

router = APIRouter()

PROJECT_ROOT = Path(__file__).resolve().parents[2]
REPORTS_DIR = PROJECT_ROOT / "reports"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _safe_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def _latest_file(pattern: str) -> Optional[Path]:
    if not REPORTS_DIR.exists():
        return None
    files = sorted(REPORTS_DIR.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def _safe_load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8-sig").strip()
        if not raw:
            return None
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except Exception:
        return None
    return None


def _safe_load_jsonl(path: Path, limit: int = 5) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except Exception:
        return []
    for line in lines:
        text = str(line or "").lstrip("\ufeff").strip()
        if not text:
            continue
        try:
            item = json.loads(text)
        except Exception:
            continue
        if isinstance(item, dict):
            rows.append(item)
    if limit > 0:
        return rows[-limit:]
    return rows


def _relative_report_path(path: Optional[Path]) -> str:
    if not path:
        return ""
    try:
        return str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
    except Exception:
        return str(path)


def _resolve_report_path(path_str: str) -> Optional[Path]:
    raw = str(path_str or "").strip()
    if not raw:
        return None
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate
    return (PROJECT_ROOT / candidate).resolve()


def _build_acceptance_summary(path: Optional[Path], payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    data = payload or {}
    checks = data.get("checks") if isinstance(data.get("checks"), list) else []
    failed = [str(item.get("name", "")).strip() for item in checks if not _safe_bool(item.get("passed"), False)]
    failed = [name for name in failed if name]
    return {
        "has_report": bool(path and payload),
        "report_path": _relative_report_path(path),
        "timestamp": str(data.get("timestamp") or ""),
        "passed": _safe_bool(data.get("passed"), False),
        "checks_total": len(checks),
        "failed_count": len(failed),
        "failed_checks": failed,
    }


def _build_stability_summary(path: Optional[Path], payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    data = payload or {}
    results = data.get("results") if isinstance(data.get("results"), list) else []
    return {
        "has_report": bool(path and payload),
        "report_path": _relative_report_path(path),
        "timestamp": str(data.get("timestamp") or ""),
        "passed": _safe_bool(data.get("passed"), False),
        "runs": _safe_int(data.get("runs"), 0),
        "passed_count": _safe_int(data.get("passed_count"), 0),
        "failed_count": _safe_int(data.get("failed_count"), 0),
        "alert_count": _safe_int(data.get("alert_count"), 0),
        "alert_log": str(data.get("alert_log") or ""),
        "stability_log": str(data.get("stability_log") or ""),
        "latest_run": results[-1] if results else None,
    }


@router.get("/maintenance/inspection/latest")
async def get_maintenance_inspection_latest(alerts_limit: int = Query(5, ge=0, le=50)):
    """
    返回维护模式最近巡检摘要：
    - 最新 acceptance 报告
    - 最新 stability 汇总
    - stability 关联的告警 jsonl（默认返回最后 5 条）
    """
    acceptance_path = _latest_file("maintenance_mode_acceptance_*.json")
    acceptance_payload = _safe_load_json(acceptance_path) if acceptance_path else None

    stability_path = _latest_file("maintenance_mode_stability_*.json")
    stability_payload = _safe_load_json(stability_path) if stability_path else None

    stability_summary = _build_stability_summary(stability_path, stability_payload)
    alert_path = _resolve_report_path(stability_summary.get("alert_log", ""))
    alerts: List[Dict[str, Any]] = _safe_load_jsonl(alert_path, limit=alerts_limit) if alert_path else []

    # 兜底：如果稳定性汇总缺失 alert_log，尝试直接抓最新 alert 文件
    if not alerts and not alert_path:
        latest_alert_path = _latest_file("maintenance_mode_alerts_*.jsonl")
        if latest_alert_path:
            alerts = _safe_load_jsonl(latest_alert_path, limit=alerts_limit)
            stability_summary["alert_log"] = _relative_report_path(latest_alert_path)

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "reports_dir": _relative_report_path(REPORTS_DIR),
        "acceptance": _build_acceptance_summary(acceptance_path, acceptance_payload),
        "stability": stability_summary,
        "alerts": alerts,
    }
