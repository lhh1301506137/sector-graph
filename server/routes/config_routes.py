# server/routes/config_routes.py
# 系统配置管理路由

from typing import Dict
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from server.database import get_db
from server.models import Config

router = APIRouter()

@router.get("/config")
async def get_all_config(db: Session = Depends(get_db)):
    """获取所有配置项"""
    configs = db.query(Config).all()
    # 按 category 分组
    result = {}
    for c in configs:
        if c.category not in result:
            result[c.category] = {}
        
        val = c.value
        # 安全性加固：对 API Key 进行脱敏
        if c.key == "api_key" and val and len(val) > 8:
            val = val[:4] + "****" + val[-4:]
        
        result[c.category][c.key] = val
    return result

@router.post("/config")
async def update_config(data: Dict[str, Dict[str, str]], db: Session = Depends(get_db)):
    """批量更新配置"""
    # data 格式: {"ai": {"api_key": "..."}, "algo": {...}}
    for category, items in data.items():
        for key, value in items.items():
            config = db.query(Config).filter(
                Config.category == category,
                Config.key == key
            ).first()
            if config:
                config.value = str(value)
            else:
                db.add(Config(category=category, key=key, value=str(value)))
    
    db.commit()
    return {"status": "ok"}
