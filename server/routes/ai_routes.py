# server/routes/ai_routes.py
# AI 分析与确认路由

from typing import List, Optional
from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session
from datetime import datetime

from server.database import get_db, SessionLocal
from server.models import Sector, Relation, RelationLogic, PendingAISuggestion
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
    db.query(PendingAISuggestion).delete()
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
    for item in items:
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
    return {"status": "ok", "added": count}
