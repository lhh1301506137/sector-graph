# server/routes/sector_routes.py
# 板块管理 + 数据刷新路由

from datetime import date, datetime
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

import httpx

from server.database import get_db
from server.models import Sector, DailyData

router = APIRouter()

# ============================================================
# 新浪API配置
# ============================================================

SINA_API_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk"
SINA_HEADERS = {
    "Host": "vip.stock.finance.sina.com.cn",
    "Referer": "https://finance.sina.com.cn",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
}


# ============================================================
# 从新浪API获取板块数据
# ============================================================

async def fetch_sina_sectors(fenlei: str = "1", num: int = 200) -> list:
    """
    从新浪API获取板块数据
    fenlei: 1=行业板块, 0=概念板块
    """
    params = {
        "page": 1,
        "num": num,
        "sort": "netamount",
        "asc": 0,
        "fenlei": fenlei,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(SINA_API_URL, params=params, headers=SINA_HEADERS)
        response.raise_for_status()
        return response.json()


def parse_sina_item(item: dict, category_type: str) -> dict:
    """解析新浪API返回的单条板块数据"""
    return {
        "name": item.get("name", ""),
        "api_id": item.get("category", ""),
        "category_type": category_type,
        "daily_change": float(item.get("avg_changeratio", 0)) * 100,  # 转为百分比
        "net_amount": float(item.get("netamount", 0)) / 100_000_000,  # 转为亿
        "turnover": float(item.get("turnover", 0)),
        "lead_stock": item.get("ts_name", ""),
        "lead_stock_change": float(item.get("ts_changeratio", 0)) * 100,
    }


# ============================================================
# API路由
# ============================================================

@router.get("/sectors")
async def get_sectors(
    db: Session = Depends(get_db),
    category_type: Optional[str] = Query(None, description="筛选：行业/概念"),
    level: Optional[int] = Query(None, description="筛选：层级 1/2/3"),
    favorited: Optional[bool] = Query(None, description="筛选：仅关注"),
    search: Optional[str] = Query(None, description="搜索关键词"),
):
    """获取板块列表"""
    query = db.query(Sector).filter(Sector.is_active == True)

    if category_type:
        query = query.filter(Sector.category_type == category_type)
    if level:
        query = query.filter(Sector.level == level)
    if favorited is not None:
        query = query.filter(Sector.is_favorited == favorited)
    if search:
        query = query.filter(Sector.name.contains(search))

    sectors = query.order_by(Sector.name).all()

    return [{
        "id": s.id,
        "name": s.name,
        "category_type": s.category_type,
        "api_id": s.api_id,
        "level": s.level,
        "parent_id": s.parent_id,
        "is_active": s.is_active,
        "is_favorited": s.is_favorited,
    } for s in sectors]


@router.post("/sectors/refresh")
async def refresh_sectors(db: Session = Depends(get_db)):
    """
    从新浪API刷新板块数据：
    1. 获取行业+概念板块列表
    2. 新板块自动入库
    3. 写入当日daily_data
    """
    today = date.today()
    result = {"new_sectors": 0, "updated": 0, "total": 0, "errors": []}

    try:
        # 并发获取行业和概念板块
        industry_data = await fetch_sina_sectors("1", 200)
        concept_data = await fetch_sina_sectors("0", 200)

        all_items = []
        for item in industry_data:
            all_items.append(parse_sina_item(item, "行业"))
        for item in concept_data:
            all_items.append(parse_sina_item(item, "概念"))

        result["total"] = len(all_items)

        for item in all_items:
            if not item["name"]:
                continue

            # 查找或创建板块
            sector = db.query(Sector).filter(Sector.name == item["name"]).first()
            if not sector:
                sector = Sector(
                    name=item["name"],
                    category_type=item["category_type"],
                    api_id=item["api_id"],
                )
                db.add(sector)
                db.flush()  # 获取ID
                result["new_sectors"] += 1

            # 写入/更新当日数据
            daily = db.query(DailyData).filter(
                DailyData.sector_id == sector.id,
                DailyData.date == today
            ).first()

            if daily:
                daily.daily_change = item["daily_change"]
                daily.net_amount = item["net_amount"]
                daily.turnover = item["turnover"]
                daily.lead_stock = item["lead_stock"]
                daily.lead_stock_change = item["lead_stock_change"]
            else:
                daily = DailyData(
                    sector_id=sector.id,
                    date=today,
                    daily_change=item["daily_change"],
                    net_amount=item["net_amount"],
                    turnover=item["turnover"],
                    lead_stock=item["lead_stock"],
                    lead_stock_change=item["lead_stock_change"],
                )
                db.add(daily)
            result["updated"] += 1

        db.commit()

    except httpx.HTTPError as e:
        result["errors"].append(f"API请求失败: {str(e)}")
    except Exception as e:
        result["errors"].append(f"处理失败: {str(e)}")
        db.rollback()

    return result


@router.put("/sectors/{sector_id}")
async def update_sector(
    sector_id: int,
    updates: dict,
    db: Session = Depends(get_db),
):
    """编辑板块（切换active/favorited等）"""
    sector = db.query(Sector).filter(Sector.id == sector_id).first()
    if not sector:
        return {"error": "板块不存在"}

    # 允许更新的字段
    allowed = ["is_active", "is_favorited", "level", "parent_id", "name"]
    for key in allowed:
        if key in updates:
            setattr(sector, key, updates[key])

    db.commit()
    return {"status": "ok", "id": sector_id}


@router.delete("/sectors/{sector_id}")
async def delete_sector(sector_id: int, db: Session = Depends(get_db)):
    """删除板块"""
    sector = db.query(Sector).filter(Sector.id == sector_id).first()
    if not sector:
        return {"error": "板块不存在"}

    # 同时删除关联的daily_data
    db.query(DailyData).filter(DailyData.sector_id == sector_id).delete()
    db.delete(sector)
    db.commit()
    return {"status": "ok", "deleted": sector.name}


@router.get("/sectors/{sector_id}/daily")
async def get_sector_daily(
    sector_id: int,
    days: int = Query(30, description="查询天数"),
    db: Session = Depends(get_db),
):
    """获取板块的历史每日数据"""
    records = (
        db.query(DailyData)
        .filter(DailyData.sector_id == sector_id)
        .order_by(DailyData.date.desc())
        .limit(days)
        .all()
    )
    return [{
        "date": str(r.date),
        "daily_change": r.daily_change,
        "expected_change": r.expected_change,
        "deviation": r.deviation,
        "cumulative_deviation": r.cumulative_deviation,
        "net_amount": r.net_amount,
        "turnover": r.turnover,
        "lead_stock": r.lead_stock,
        "lead_stock_change": r.lead_stock_change,
    } for r in records]

@router.post("/sectors/{sector_id}/explain")
async def explain_sector_score(
    sector_id: int,
    target_date: str = Query(..., description="要解释的具体日期 YYYY-MM-DD"),
    db: Session = Depends(get_db)
):
    """请求 AI 解释特定日期下板块的得分逻辑"""
    from server.core.scoring import ScoringEngine
    from server.core.ai_client import AIClient
    from server.models import Relation
    
    dt = datetime.strptime(target_date, "%Y-%m-%d").date()
    
    sector = db.query(Sector).filter(Sector.id == sector_id).first()
    if not sector:
        return {"error": "板块不存在"}
        
    daily = db.query(DailyData).filter(
        DailyData.sector_id == sector_id, 
        DailyData.date == dt
    ).first()
    
    score = daily.cumulative_deviation if daily and daily.cumulative_deviation else 0.0
    
    engine = ScoringEngine(db)
    all_relations = db.query(Relation).all()
    # 筛选相关联的板块
    relevant_rels = [r for r in all_relations if r.source_id == sector_id or r.target_id == sector_id]
    
    breakdown_data = []
    
    for rel in relevant_rels:
        related_id = rel.target_id if rel.source_id == sector_id else rel.source_id
        related_sector = db.query(Sector).filter(Sector.id == related_id).first()
        if not related_sector: continue
        
        related_data = engine.get_daily_data(related_id, dt)
        if not related_data or not related_data.daily_change: continue
        
        confidence = engine.calc_confidence(related_id, dt)
        importance = engine.get_logic_importance(rel.logic_name)
        contribution = related_data.daily_change * rel.weight * rel.level_coefficient * confidence * importance
        
        breakdown_data.append({
            "related_sector": related_sector.name,
            "logic_name": rel.logic_name,
            "weight": round(rel.weight * rel.level_coefficient, 2),
            "daily_change": round(related_data.daily_change, 2),
            "confidence": round(confidence, 2),
            "contribution": abs(contribution)
        })
        
    # 如果关联项太多，AI 可能会混乱，因此对数据按真实的数学贡献度绝对值倒序，取前 8
    breakdown_data.sort(key=lambda x: x["contribution"], reverse=True)
    breakdown_data = breakdown_data[:8]

    # 防御机制：如果无数据，直接切断大模型请求以节省资源
    if not breakdown_data or score == 0.0:
        return {
            "sector": sector.name,
            "date": target_date,
            "score": score,
            "explanation": "当前目标日期缺乏足够的交易数据或强关联异动明细，AI 引擎无法提取有效归因以进行深度分析。"
        }

    ai_client = AIClient(db)
    explanation = await ai_client.explain_sector_score(
        sector_name=sector.name,
        target_date=target_date,
        score=score,
        breakdown_data=breakdown_data
    )
    
    return {
        "sector": sector.name,
        "date": target_date,
        "score": score,
        "explanation": explanation
    }


@router.delete("/relations/unlocked")
async def clear_unlocked_relations(db: Session = Depends(get_db)):
    """一键清理所有未被用户主动锁定（is_locked=False）的板块关联，实现 AI 生成配置纠错撤回"""
    from server.models import Relation
    deleted_count = db.query(Relation).filter(Relation.is_locked == False).delete()
    db.commit()
    return {"status": "ok", "deleted_count": deleted_count}


@router.get("/sync-status")
async def get_sync_status(db: Session = Depends(get_db)):
    """获取整体板块的最后一次有效刷新/同步日期"""
    from sqlalchemy import func
    max_date = db.query(func.max(DailyData.date)).scalar()
    
    if max_date:
        return {"status": "ok", "last_sync_date": str(max_date)}
    else:
        return {"status": "ok", "last_sync_date": "暂无数据"}
