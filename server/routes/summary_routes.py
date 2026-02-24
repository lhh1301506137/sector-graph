# server/routes/summary_routes.py
# 首页摘要看板数据接口

from datetime import date
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func

from server.database import get_db
from server.models import Sector, DailyData, Prediction, BacktestResult

router = APIRouter()

@router.get("/summary")
async def get_system_summary(db: Session = Depends(get_db)):
    """获取全站摘要数据"""
    today = date.today()
    
    # 1. 最近数据更新日期
    latest_data = db.query(func.max(DailyData.date)).scalar()
    latest_date_str = str(latest_data) if latest_data else "无数据"
    
    # 2. 昨日回测命中率
    latest_backtest = db.query(BacktestResult).order_by(BacktestResult.date.desc()).first()
    hit_rate = f"{(latest_backtest.top_10_hits / 10.0) * 100:.0f}%" if latest_backtest else "0%"
    
    # 3. 今日最强警报板块
    top_pred = db.query(Prediction).filter(Prediction.date == latest_data).order_by(Prediction.score.desc()).first()
    if top_pred:
        top_sector = db.query(Sector).filter(Sector.id == top_pred.sector_id).first()
        alert_name = top_sector.name if top_sector else "计算中"
    else:
        alert_name = "待运行"
    
    # 4. 板块统计
    total_sectors = db.query(Sector).count()
    active_sectors = db.query(Sector).filter(Sector.is_active == True).count()
    
    return {
        "latest_date": latest_date_str,
        "hit_rate": hit_rate,
        "alert_sector": alert_name,
        "total_count": f"{active_sectors}/{total_sectors}",
    }
