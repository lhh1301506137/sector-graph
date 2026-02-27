# server/config.py
# 閰嶇疆绠＄悊锛氳鍐檆onfig琛?

import json
from sqlalchemy.orm import Session
from server.models import Config


# 榛樿閰嶇疆锛堥娆″惎鍔ㄦ椂鍐欏叆锛?
DEFAULT_CONFIG = {
    "ai": {
        "provider": "deepseek",
        "api_key": "",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
    },
    "algo": {
        "time_decay_days": "30",
        "time_decay_min": "0.1",
        "deviation_mode": "positive_only",
        "backtest_period": "60",
        "ranking_top_n": "10",
        "backtest_hit_range": "20",
        "quality_max_failed_rows": "25",
        "quality_required_fields": "name,category_type,daily_change,net_amount,turnover,lead_stock_change",
        "quality_daily_change_abs_max": "20",
        "quality_lead_stock_change_abs_max": "25",
        "quality_turnover_abs_max": "30",
        "quality_net_amount_abs_max": "500",
        "quality_stale_minutes": "240",
        "quality_require_freshness_for_publish": "1",
        "quality_min_total_rows": "180",
    },
    "user": {
        "theme": "dark",
    },
    "data": {
        "primary_source": "sina",
        "verify_source": "akshare",
        "tushare_token": "",
        "dual_compare_enabled": "0",
        "compare_warn_threshold_pct": "0.8",
        "request_timeout_sec": "15",
        "request_retry_count": "2",
        "request_retry_backoff_sec": "0.6",
        "http_proxy_enabled": "0",
        "http_proxy": "",
        "http_proxy_strategy": "auto",
        "http_user_agent": "",
    },
}


def get_config(db: Session, category: str, key: str) -> str:
    """Get one config value."""
    config = db.query(Config).filter(
        Config.category == category,
        Config.key == key
    ).first()
    return config.value if config else ""


def set_config(db: Session, category: str, key: str, value: str):
    """Set one config value."""
    config = db.query(Config).filter(
        Config.category == category,
        Config.key == key
    ).first()
    if config:
        config.value = value
    else:
        config = Config(category=category, key=key, value=value)
        db.add(config)
    db.commit()


def get_all_config(db: Session) -> dict:
    """Get all config values grouped by category."""
    configs = db.query(Config).all()
    result = {}
    for c in configs:
        if c.category not in result:
            result[c.category] = {}
        result[c.category][c.key] = c.value
    return result


def init_default_config(db: Session):
    """Initialize default config and fill missing keys."""
    changed = False
    for category, items in DEFAULT_CONFIG.items():
        for key, value in items.items():
            existing = db.query(Config).filter(
                Config.category == category,
                Config.key == key
            ).first()
            if not existing:
                db.add(Config(category=category, key=key, value=value))
                changed = True

    if changed:
        db.commit()
        print("Default config initialized/filled")


# 基础逻辑词库预设（启动时补齐到 relation_logics）
INIT_LOGICS = [
    {
        "logic_name": "原料供应",
        "category": "供应",
        "description": "上游原材料价格或产量变化，影响下游成本和供给。",
        "default_weight": 7.0,
        "importance": 1.0,
        "prompt_template": "分析板块A是否是板块B的关键原料供应方，A变化是否会传导到B。",
    },
    {
        "logic_name": "股权控制",
        "category": "政策联动",
        "description": "母子公司、交叉持股或同一实控人，存在利益传导。",
        "default_weight": 5.0,
        "importance": 0.8,
        "prompt_template": "分析板块A和板块B是否存在显著的股权或实控关系。",
    },
    {
        "logic_name": "政策扶持",
        "category": "政策联动",
        "description": "同一政策方向可同时影响多个细分板块。",
        "default_weight": 6.0,
        "importance": 0.9,
        "prompt_template": "分析近期政策是否同时利好板块A和板块B。",
    },
    {
        "logic_name": "技术同源",
        "category": "技术同源",
        "description": "底层工艺或研发成果可复用，形成联动。",
        "default_weight": 4.0,
        "importance": 0.6,
        "prompt_template": "分析板块A与板块B是否共享关键技术平台。",
    },
]


def init_default_logics(db: Session):
    """Initialize default relation logic seeds."""
    from server.models import RelationLogic
    count = db.query(RelationLogic).count()
    if count > 0:
        return
    
    for item in INIT_LOGICS:
        db.add(RelationLogic(**item))
    db.commit()
    print("Relation logic seeds initialized")

