# server/routes/logic_routes.py
# 逻辑关联词库管理路由

from typing import Optional
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from datetime import datetime

from server.database import get_db
from server.models import RelationLogic

router = APIRouter()

# ============================================================
# 请求模型
# ============================================================

class LogicCreate(BaseModel):
    logic_name: str
    category: str = "供应"
    description: str = ""
    default_weight: float = 5.0
    importance: float = 1.0
    prompt_template: str = ""

class LogicUpdate(BaseModel):
    logic_name: Optional[str] = None
    category: Optional[str] = None
    description: Optional[str] = None
    default_weight: Optional[float] = None
    importance: Optional[float] = None
    prompt_template: Optional[str] = None

# ============================================================
# API 路由
# ============================================================

@router.get("/logics")
async def get_logics(db: Session = Depends(get_db)):
    """获取所有逻辑词条"""
    logics = db.query(RelationLogic).order_by(RelationLogic.id).all()
    return logics

@router.post("/logics")
async def create_logic(data: LogicCreate, db: Session = Depends(get_db)):
    """创建新逻辑词条"""
    # 检查重名
    existing = db.query(RelationLogic).filter(RelationLogic.logic_name == data.logic_name).first()
    if existing:
        return {"error": "逻辑名称已存在"}
    
    logic = RelationLogic(**data.dict())
    db.add(logic)
    db.commit()
    db.refresh(logic)
    return logic

@router.put("/logics/{logic_id}")
async def update_logic(logic_id: int, data: LogicUpdate, db: Session = Depends(get_db)):
    """更新逻辑词条"""
    logic = db.query(RelationLogic).filter(RelationLogic.id == logic_id).first()
    if not logic:
        return {"error": "逻辑词条不存在"}
    
    for key, value in data.dict(exclude_unset=True).items():
        setattr(logic, key, value)
    
    db.commit()
    return logic

@router.delete("/logics/{logic_id}")
async def delete_logic(logic_id: int, db: Session = Depends(get_db)):
    """删除逻辑词条"""
    logic = db.query(RelationLogic).filter(RelationLogic.id == logic_id).first()
    if not logic:
        return {"error": "逻辑词条不存在"}
    
    db.delete(logic)
    db.commit()
    return {"status": "ok"}
