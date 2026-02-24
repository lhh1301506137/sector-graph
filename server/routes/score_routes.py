# server/routes/score_routes.py
# 得分计算 + 排行路由

from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from server.database import get_db
from server.models import Prediction, Sector, DailyData
from server.core.scoring import run_scoring

router = APIRouter()


@router.post("/scoring/run")
async def run_scoring_api(db: Session = Depends(get_db)):
    """运行得分计算"""
    result = run_scoring(db)
    return result


@router.get("/ranking")
async def get_ranking(
    db: Session = Depends(get_db),
    target_date: Optional[str] = Query(None, description="日期, 默认今天"),
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
        .filter(Prediction.date == the_date, Sector.is_active == True)
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
        "daily_change": d.daily_change if d else None,
        "expected_change": d.expected_change if d else None,
        "deviation": d.deviation if d else None,
        "net_amount": d.net_amount if d else None,
        "lead_stock": d.lead_stock if d else None,
        "lead_stock_change": d.lead_stock_change if d else None,
    } for p, s, d in results]
