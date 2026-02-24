# server/routes/relation_routes.py
# 关联关系管理路由

from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from server.database import get_db
from server.models import Relation, Sector

router = APIRouter()


# ============================================================
# 请求模型
# ============================================================

class RelationCreate(BaseModel):
    source_id: int
    target_id: int
    type: str = "供应"
    weight: float = 5.0
    direction: str = "A↔B"
    level_coefficient: float = 1.0
    source: str = "manual"


class RelationUpdate(BaseModel):
    type: Optional[str] = None
    weight: Optional[float] = None
    direction: Optional[str] = None
    level_coefficient: Optional[float] = None
    is_locked: Optional[bool] = None


# ============================================================
# 10种关系类型常量
# ============================================================

RELATION_TYPES = [
    "供应", "应用", "配套", "技术同源", "成本影响",
    "需求影响", "替代", "互补", "竞争", "政策联动"
]


# ============================================================
# API路由
# ============================================================

@router.get("/relations")
async def get_relations(
    db: Session = Depends(get_db),
    sector_id: Optional[int] = Query(None, description="筛选：某个板块的所有关联"),
    source: Optional[str] = Query(None, description="筛选来源：system/ai/manual"),
    locked: Optional[bool] = Query(None, description="筛选锁定状态"),
):
    """获取关联列表"""
    query = db.query(Relation)

    if sector_id:
        query = query.filter(
            (Relation.source_id == sector_id) | (Relation.target_id == sector_id)
        )
    if source:
        query = query.filter(Relation.source == source)
    if locked is not None:
        query = query.filter(Relation.is_locked == locked)

    relations = query.order_by(Relation.id).all()

    # 附带板块名称
    sector_ids = set()
    for r in relations:
        sector_ids.add(r.source_id)
        sector_ids.add(r.target_id)
    sectors = db.query(Sector).filter(Sector.id.in_(sector_ids)).all()
    sector_map = {s.id: s.name for s in sectors}

    return [{
        "id": r.id,
        "source_id": r.source_id,
        "source_name": sector_map.get(r.source_id, "未知"),
        "target_id": r.target_id,
        "target_name": sector_map.get(r.target_id, "未知"),
        "type": r.type,
        "weight": r.weight,
        "direction": r.direction,
        "level_coefficient": r.level_coefficient,
        "is_locked": r.is_locked,
        "source": r.source,
        "created_at": str(r.created_at) if r.created_at else None,
        "updated_at": str(r.updated_at) if r.updated_at else None,
    } for r in relations]


@router.post("/relations")
async def create_relation(data: RelationCreate, db: Session = Depends(get_db)):
    """添加关联"""
    # 验证板块存在
    source = db.query(Sector).filter(Sector.id == data.source_id).first()
    target = db.query(Sector).filter(Sector.id == data.target_id).first()
    if not source or not target:
        return {"error": "板块不存在"}

    # 验证关系类型
    if data.type not in RELATION_TYPES:
        return {"error": f"无效关系类型，可选：{', '.join(RELATION_TYPES)}"}

    # 避免重复关联
    existing = db.query(Relation).filter(
        Relation.source_id == data.source_id,
        Relation.target_id == data.target_id,
        Relation.type == data.type,
    ).first()
    if existing:
        return {"error": "该关联已存在", "existing_id": existing.id}

    relation = Relation(
        source_id=data.source_id,
        target_id=data.target_id,
        type=data.type,
        weight=data.weight,
        direction=data.direction,
        level_coefficient=data.level_coefficient,
        source=data.source,
    )
    db.add(relation)
    db.commit()

    return {
        "status": "ok",
        "id": relation.id,
        "source_name": source.name,
        "target_name": target.name,
    }


@router.put("/relations/{relation_id}")
async def update_relation(
    relation_id: int,
    data: RelationUpdate,
    db: Session = Depends(get_db),
):
    """修改关联（含锁定/解锁）"""
    relation = db.query(Relation).filter(Relation.id == relation_id).first()
    if not relation:
        return {"error": "关联不存在"}

    if data.type is not None:
        if data.type not in RELATION_TYPES:
            return {"error": f"无效关系类型"}
        relation.type = data.type
    if data.weight is not None:
        relation.weight = max(-10, min(10, data.weight))  # 限制范围
    if data.direction is not None:
        relation.direction = data.direction
    if data.level_coefficient is not None:
        relation.level_coefficient = data.level_coefficient
    if data.is_locked is not None:
        relation.is_locked = data.is_locked

    relation.updated_at = datetime.now()
    db.commit()

    return {"status": "ok", "id": relation_id}


@router.delete("/relations/{relation_id}")
async def delete_relation(relation_id: int, db: Session = Depends(get_db)):
    """删除关联"""
    relation = db.query(Relation).filter(Relation.id == relation_id).first()
    if not relation:
        return {"error": "关联不存在"}

    db.delete(relation)
    db.commit()
    return {"status": "ok", "deleted_id": relation_id}


@router.get("/relation-types")
async def get_relation_types():
    """获取所有可用的关系类型"""
    return {"types": RELATION_TYPES}
