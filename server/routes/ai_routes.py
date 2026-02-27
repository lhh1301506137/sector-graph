# server/routes/ai_routes.py
# AI 分析与确认路由

import json
from typing import List, Optional, Tuple
from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session
from datetime import datetime

from server.database import get_db, SessionLocal
from server.models import (
    Sector,
    Relation,
    RelationLogic,
    PendingAISuggestion,
    BacktestResult,
    BacktestJob,
    Config,
    AlgoOptimizationSuggestion,
)
from server.core.ai_client import AIClient

router = APIRouter()

class AIAnalyzeRequest(BaseModel):
    batch_size: int = 10  # 每次分析多少对关系

@router.get("/ai/pending")
async def get_pending(db: Session = Depends(get_db)):
    """获取待确认的AI分析结果（从数据库读取）"""
    return db.query(PendingAISuggestion).filter(PendingAISuggestion.status == "pending").all()

@router.post("/ai/clear-pending")
async def clear_pending(db: Session = Depends(get_db)):
    """清理待确认队列"""
    db.query(PendingAISuggestion).filter(PendingAISuggestion.status == "pending").delete()
    db.commit()
    return {"status": "ok"}

async def run_ai_batch_task(batch_size: int):
    """后台运行AI批量分析任务"""
    db = SessionLocal()
    try:
        ai = AIClient(db)
        sectors = db.query(Sector).filter(Sector.is_active == True).all()
        
        count = 0
        for i in range(len(sectors)):
            for j in range(i + 1, len(sectors)):
                if count >= batch_size: break
                
                s1, s2 = sectors[i], sectors[j]
                
                # 检查是否已存在关联或已在待处理列表中
                exists = db.query(Relation).filter(
                    ((Relation.source_id == s1.id) & (Relation.target_id == s2.id)) |
                    ((Relation.source_id == s2.id) & (Relation.target_id == s1.id))
                ).first()
                
                if not exists:
                    # 也检查是否已经在 pending 中
                    in_pending = db.query(PendingAISuggestion).filter(
                        ((PendingAISuggestion.source_id == s1.id) & (PendingAISuggestion.target_id == s2.id)) |
                        ((PendingAISuggestion.source_id == s2.id) & (PendingAISuggestion.target_id == s1.id))
                    ).first()
                    
                    if not in_pending:
                        result = await ai.analyze_sector_pair(s1.name, s2.name)
                        if result:
                            suggestion = PendingAISuggestion(
                                source_id=s1.id,
                                target_id=s2.id,
                                source_name=s1.name,
                                target_name=s2.name,
                                logic_name=result.get("logic_name"),
                                weight=result.get("weight", 5.0),
                                reason=result.get("reason", ""),
                                status="pending"
                            )
                            db.add(suggestion)
                            db.commit() # 逐条提交，保证中途出错也能保存前面的
                            count += 1
            if count >= batch_size: break
            
    finally:
        db.close()

@router.post("/ai/analyze")
async def analyze_new_relations(req: AIAnalyzeRequest, background_tasks: BackgroundTasks):
    """触发AI分析"""
    if req.batch_size > 50:
        return {"error": "单次分析规模不能超过 50 对关系，请分批进行以控制成本。"}
    background_tasks.add_task(run_ai_batch_task, req.batch_size)
    return {"message": f"AI分析任务已在后台启动，结果将持久化至数据库。", "status": "processing"}

class ConfirmItem(BaseModel):
    id: int # PendingAISuggestion 的 ID
    source_id: int
    target_id: int
    logic_name: str
    weight: float
    direction: str = "A↔B"

@router.post("/ai/confirm")
async def confirm_ai_results(items: List[ConfirmItem], db: Session = Depends(get_db)):
    """批量确认AI结果并写入Relations表"""
    count = 0
    skipped = 0
    for item in items:
        # 幂等保护：避免重复导入
        exists = db.query(Relation).filter(
            (((Relation.source_id == item.source_id) & (Relation.target_id == item.target_id)) |
             ((Relation.source_id == item.target_id) & (Relation.target_id == item.source_id))) &
            (Relation.logic_name == item.logic_name)
        ).first()
        if exists:
            suggestion = db.query(PendingAISuggestion).filter(PendingAISuggestion.id == item.id).first()
            if suggestion:
                suggestion.status = "confirmed"
            skipped += 1
            continue

        # 查找逻辑对应的关系类型
        logic = db.query(RelationLogic).filter(RelationLogic.logic_name == item.logic_name).first()
        rel_type = logic.category if logic else "供应"
        
        relation = Relation(
            source_id=item.source_id,
            target_id=item.target_id,
            type=rel_type,
            logic_name=item.logic_name, # 保存逻辑模式名称
            weight=item.weight,
            direction=item.direction,
            source="ai"
        )
        db.add(relation)
        
        # 更新建议状态
        suggestion = db.query(PendingAISuggestion).filter(PendingAISuggestion.id == item.id).first()
        if suggestion:
            suggestion.status = "confirmed"
        
        count += 1
    
    db.commit()
    return {"status": "ok", "added": count, "skipped": skipped}


class GenerateOptimizationSuggestionRequest(BaseModel):
    run_id: Optional[str] = None


def _safe_json_loads(raw: str, fallback):
    text = str(raw or "").strip()
    if not text:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        return fallback


def _get_latest_completed_backtest_run_id(db: Session) -> str:
    recent = db.query(BacktestJob.run_id).filter(
        BacktestJob.status == "completed"
    ).order_by(BacktestJob.id.desc()).limit(50).all()
    for row in recent:
        rid = str(row[0] or "").strip()
        if not rid:
            continue
        exists = db.query(BacktestResult.id).filter(BacktestResult.run_id == rid).first()
        if exists:
            return rid
    latest = db.query(BacktestResult.run_id).filter(
        BacktestResult.run_id != ""
    ).order_by(BacktestResult.id.desc()).first()
    if latest and latest[0]:
        return str(latest[0]).strip()
    return ""


def _load_algo_config_map(db: Session) -> dict:
    rows = db.query(Config).filter(Config.category == "algo").all()
    return {str(item.key): str(item.value) for item in rows}


def _as_int(text: str, default: int) -> int:
    try:
        return int(float(str(text).strip()))
    except Exception:
        return default


def _as_float(text: str, default: float) -> float:
    try:
        return float(str(text).strip())
    except Exception:
        return default


def _format_float(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.4f}".rstrip("0").rstrip(".")


def _build_suggested_algo_config(current: dict, metrics: dict) -> Tuple[dict, List[str]]:
    suggested = dict(current)
    reasons: List[str] = []

    current_days = _as_int(current.get("time_decay_days", "30"), 30)
    current_min = _as_float(current.get("time_decay_min", "0.1"), 0.1)
    current_mode = str(current.get("deviation_mode", "positive_only") or "positive_only")

    avg_alpha = float(metrics.get("avg_alpha", 0.0))
    avg_hit = float(metrics.get("avg_hit_rate", 0.0))
    avg_random = float(metrics.get("avg_random_hit_rate", 0.0))
    hit_advantage = float(metrics.get("hit_advantage", avg_hit - avg_random))

    new_days = current_days
    new_min = current_min
    new_mode = current_mode

    # Conservative heuristics: keep deterministic and explainable.
    if avg_alpha < 0 or hit_advantage < 0:
        new_days = max(12, int(round(current_days * 0.75)))
        new_min = min(0.35, current_min + 0.05)
        reasons.append("回测 Alpha 或命中优势偏弱：缩短时间衰减窗口并提高衰减下限，提升近期信号权重。")
    elif avg_alpha > 0.8 and hit_advantage > 4:
        new_days = min(120, int(round(current_days * 1.2)))
        new_min = max(0.05, current_min - 0.03)
        reasons.append("回测表现稳定优于随机基准：适当拉长衰减窗口，增强趋势延续性。")
    else:
        reasons.append("回测表现处于中性区间：保持核心参数不变，优先观察下一轮结果。")

    if avg_alpha < -0.5 and current_mode == "all":
        new_mode = "positive_only"
        reasons.append("负向偏差过大：建议先使用仅正偏差模式抑制噪声。")

    suggested["time_decay_days"] = str(new_days)
    suggested["time_decay_min"] = _format_float(new_min)
    suggested["deviation_mode"] = new_mode
    suggested["suggestion_generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    changed = [k for k in ["time_decay_days", "time_decay_min", "deviation_mode"] if str(suggested.get(k)) != str(current.get(k))]
    if not changed:
        reasons.append("建议参数与当前参数一致，可直接进入配置版本化阶段。")
    return suggested, reasons


def _serialize_optimization_suggestion(item: AlgoOptimizationSuggestion) -> dict:
    summary = _safe_json_loads(item.summary, {})
    current_params = _safe_json_loads(item.current_params, {})
    suggested_params = _safe_json_loads(item.suggested_params, {})
    reasoning = _safe_json_loads(item.reasoning, [])
    changed_keys = []
    if isinstance(current_params, dict) and isinstance(suggested_params, dict):
        for key in sorted(set(current_params.keys()) | set(suggested_params.keys())):
            if str(current_params.get(key)) != str(suggested_params.get(key)):
                changed_keys.append(key)
    return {
        "id": item.id,
        "run_id": item.run_id,
        "source_type": item.source_type,
        "status": item.status,
        "summary": summary if isinstance(summary, dict) else {},
        "current_params": current_params if isinstance(current_params, dict) else {},
        "suggested_params": suggested_params if isinstance(suggested_params, dict) else {},
        "reasoning": reasoning if isinstance(reasoning, list) else [],
        "changed_keys": changed_keys,
        "created_at": item.created_at.strftime("%Y-%m-%d %H:%M:%S") if item.created_at else None,
        "applied_at": item.applied_at.strftime("%Y-%m-%d %H:%M:%S") if item.applied_at else None,
    }


@router.post("/ai/optimization/suggestions/generate")
async def generate_optimization_suggestion(
    payload: GenerateOptimizationSuggestionRequest,
    db: Session = Depends(get_db),
):
    requested_run_id = str(payload.run_id or "").strip()
    run_id = requested_run_id or _get_latest_completed_backtest_run_id(db)
    if not run_id:
        return {"error": "no_backtest_run_found"}

    rows = db.query(BacktestResult).filter(
        BacktestResult.run_id == run_id
    ).order_by(BacktestResult.date.desc()).all()
    if not rows:
        return {"error": f"run_id has no backtest results: {run_id}"}

    total_days = len(rows)
    sum_hits = 0.0
    sum_random = 0.0
    sum_alpha = 0.0
    positive_alpha_days = 0
    for row in rows:
        top_hits = float(row.top_10_hits or 0)
        alpha = float(row.average_alpha or 0.0)
        random_hit = float(row.random_hit_rate or 0.0)
        sum_hits += (top_hits / 10.0) * 100.0
        sum_random += random_hit
        sum_alpha += alpha
        if alpha > 0:
            positive_alpha_days += 1

    avg_hit = sum_hits / total_days if total_days else 0.0
    avg_random = sum_random / total_days if total_days else 0.0
    avg_alpha = sum_alpha / total_days if total_days else 0.0
    hit_advantage = avg_hit - avg_random
    metrics = {
        "total_days": total_days,
        "avg_hit_rate": round(avg_hit, 4),
        "avg_random_hit_rate": round(avg_random, 4),
        "avg_alpha": round(avg_alpha, 4),
        "hit_advantage": round(hit_advantage, 4),
        "positive_alpha_days": positive_alpha_days,
        "positive_alpha_ratio": round((positive_alpha_days / total_days) if total_days else 0.0, 4),
        "first_date": str(rows[-1].date) if rows else "",
        "last_date": str(rows[0].date) if rows else "",
    }

    current_algo = _load_algo_config_map(db)
    suggested_algo, reasons = _build_suggested_algo_config(current_algo, metrics)

    row = AlgoOptimizationSuggestion(
        run_id=run_id,
        source_type="backtest",
        status="generated",
        summary=json.dumps(metrics, ensure_ascii=False),
        current_params=json.dumps(current_algo, ensure_ascii=False),
        suggested_params=json.dumps(suggested_algo, ensure_ascii=False),
        reasoning=json.dumps(reasons, ensure_ascii=False),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    return {
        "status": "ok",
        "suggestion": _serialize_optimization_suggestion(row),
    }


@router.get("/ai/optimization/suggestions")
async def list_optimization_suggestions(
    run_id: str = "",
    limit: int = 10,
    db: Session = Depends(get_db),
):
    query = db.query(AlgoOptimizationSuggestion)
    rid = str(run_id or "").strip()
    if rid:
        query = query.filter(AlgoOptimizationSuggestion.run_id == rid)
    rows = query.order_by(AlgoOptimizationSuggestion.id.desc()).limit(max(1, min(int(limit or 10), 100))).all()
    return [_serialize_optimization_suggestion(item) for item in rows]
