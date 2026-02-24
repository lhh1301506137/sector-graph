# server/routes/backtest_routes.py
# 历史回测管理路由

from fastapi import APIRouter, Depends, Query, BackgroundTasks
from sqlalchemy.orm import Session
from server.database import get_db
from server.core.backtest import BacktestEngine

router = APIRouter()

@router.post("/backtest/run")
async def run_backtest(
    background_tasks: BackgroundTasks,
    days: int = Query(60, description="回测天数"),
    db: Session = Depends(get_db)
):
    """触发历史回测任务（后台运行）"""
    engine = BacktestEngine(db)
    background_tasks.add_task(engine.run_period_backtest, days)
    return {"message": f"最近{days}天的历史双盲回测已在后台启动，完成后可查看表现走势。", "status": "processing"}

@router.get("/backtest/results")
async def get_backtest_results(
    limit: int = Query(30, description="获取最近N天的结果"),
    db: Session = Depends(get_db)
):
    """获取历史回测表现结果"""
    engine = BacktestEngine(db)
    results = engine.get_history_performance(limit)
    return results

@router.get("/backtest/results/{target_date}")
async def get_backtest_day_detail(
    target_date: str,
    db: Session = Depends(get_db)
):
    """获取指定日期的回测详细列表"""
    engine = BacktestEngine(db)
    return engine.get_day_detail(target_date)
