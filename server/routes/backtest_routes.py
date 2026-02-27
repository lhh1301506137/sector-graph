# server/routes/backtest_routes.py
# 历史回测管理路由

import json
from datetime import datetime
from fastapi import APIRouter, Depends, Query, BackgroundTasks, HTTPException
from sqlalchemy.orm import Session

from server.database import get_db, SessionLocal
from server.models import BacktestJob
from server.core.backtest import BacktestEngine

router = APIRouter()


def _new_run_id(db: Session) -> str:
    """生成唯一 run_id，避免同秒多次触发冲突。"""
    for _ in range(5):
        candidate = datetime.now().strftime("bt_%Y%m%d_%H%M%S_%f")[:-3]
        exists = db.query(BacktestJob).filter(BacktestJob.run_id == candidate).first()
        if not exists:
            return candidate
    return datetime.now().strftime("bt_%Y%m%d_%H%M%S_%f")


async def _run_backtest_job_task(days: int, run_id: str):
    """后台任务执行器：独立创建 DB Session，避免依赖会话失效。"""
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
        if job:
            if job.status != "cancelled":
                job.status = "failed"
                job.ended_at = datetime.now()
                job.error_message = str(e)[:1000]
            db.commit()
    finally:
        db.close()


def _serialize_job(job: BacktestJob) -> dict:
    return {
        "id": job.id,
        "run_id": job.run_id,
        "status": job.status,
        "days": job.days,
        "started_at": job.started_at.strftime("%Y-%m-%d %H:%M:%S") if job.started_at else None,
        "ended_at": job.ended_at.strftime("%Y-%m-%d %H:%M:%S") if job.ended_at else None,
        "error_message": job.error_message or "",
        "params_snapshot": job.params_snapshot or "{}",
        "created_at": job.created_at.strftime("%Y-%m-%d %H:%M:%S") if job.created_at else None,
        "updated_at": job.updated_at.strftime("%Y-%m-%d %H:%M:%S") if job.updated_at else None,
    }


@router.post("/backtest/run")
async def run_backtest(
    background_tasks: BackgroundTasks,
    days: int = Query(60, description="回测天数"),
    db: Session = Depends(get_db)
):
    """触发历史回测任务（后台运行）"""
    run_id = _new_run_id(db)
    params_snapshot = json.dumps({"days": days}, ensure_ascii=False)

    db.add(BacktestJob(
        run_id=run_id,
        status="queued",
        days=days,
        params_snapshot=params_snapshot,
    ))
    db.commit()

    background_tasks.add_task(_run_backtest_job_task, days, run_id)
    return {
        "message": f"最近{days}天的历史双盲回测已在后台启动，完成后可查看表现走势。",
        "status": "processing",
        "run_id": run_id
    }


@router.post("/backtest/jobs/{run_id}/cancel")
async def cancel_backtest_job(
    run_id: str,
    db: Session = Depends(get_db)
):
    row = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
    if not row:
        raise HTTPException(status_code=404, detail={"error": f"run_id not found: {run_id}"})
    if row.status in {"completed", "failed", "cancelled"}:
        return {
            "status": "ignored",
            "message": f"任务当前状态为 {row.status}，无需取消。",
            "run_id": run_id,
        }
    row.status = "cancelled"
    row.ended_at = datetime.now()
    row.error_message = "cancelled by user"
    db.commit()
    return {
        "status": "ok",
        "message": "取消请求已提交。",
        "run_id": run_id,
    }


@router.get("/backtest/jobs")
async def get_backtest_jobs(
    limit: int = Query(20, ge=1, le=200, description="返回最近N个任务"),
    db: Session = Depends(get_db)
):
    rows = db.query(BacktestJob).order_by(BacktestJob.id.desc()).limit(limit).all()
    return [_serialize_job(r) for r in rows]


@router.get("/backtest/jobs/{run_id}")
async def get_backtest_job_detail(
    run_id: str,
    db: Session = Depends(get_db)
):
    row = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
    if not row:
        raise HTTPException(status_code=404, detail={"error": f"run_id not found: {run_id}"})
    return _serialize_job(row)


@router.post("/backtest/jobs/{run_id}/retry")
async def retry_backtest_job(
    run_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    row = db.query(BacktestJob).filter(BacktestJob.run_id == run_id).first()
    if not row:
        raise HTTPException(status_code=404, detail={"error": f"run_id not found: {run_id}"})
    if row.status not in {"failed", "cancelled"}:
        return {
            "status": "ignored",
            "message": f"仅 failed/cancelled 任务允许重试，当前状态: {row.status}",
            "run_id": run_id,
        }

    new_run_id = _new_run_id(db)
    snapshot = row.params_snapshot or "{}"
    days = row.days or 60

    db.add(BacktestJob(
        run_id=new_run_id,
        status="queued",
        days=days,
        params_snapshot=snapshot,
    ))
    db.commit()
    background_tasks.add_task(_run_backtest_job_task, days, new_run_id)

    return {
        "status": "ok",
        "message": "重试任务已创建并启动。",
        "run_id": run_id,
        "new_run_id": new_run_id,
    }


@router.get("/backtest/results")
async def get_backtest_results(
    limit: int = Query(30, description="获取最近N天的结果"),
    run_id: str = Query("", description="可选：指定 run_id 过滤结果"),
    db: Session = Depends(get_db)
):
    """获取历史回测表现结果"""
    engine = BacktestEngine(db)
    results = engine.get_history_performance(limit, run_id=run_id)
    return results


@router.get("/backtest/results/{target_date}")
async def get_backtest_day_detail(
    target_date: str,
    run_id: str = Query("", description="可选：指定 run_id 查看单日明细"),
    db: Session = Depends(get_db)
):
    """获取指定日期的回测详细列表"""
    engine = BacktestEngine(db)
    try:
        return engine.get_day_detail(target_date, run_id=run_id)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail={"error": "target_date must be YYYY-MM-DD"},
        )
