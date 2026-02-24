# server/config.py
# 配置管理：读写config表

import json
from sqlalchemy.orm import Session
from server.models import Config


# 默认配置（首次启动时写入）
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
    },
    "user": {
        "theme": "dark",
    },
}


def get_config(db: Session, category: str, key: str) -> str:
    """获取单个配置值"""
    config = db.query(Config).filter(
        Config.category == category,
        Config.key == key
    ).first()
    return config.value if config else ""


def set_config(db: Session, category: str, key: str, value: str):
    """设置单个配置值"""
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
    """获取所有配置，按category分组"""
    configs = db.query(Config).all()
    result = {}
    for c in configs:
        if c.category not in result:
            result[c.category] = {}
        result[c.category][c.key] = c.value
    return result


def init_default_config(db: Session):
    """初始化默认配置（仅在config表为空时执行）"""
    count = db.query(Config).count()
    if count > 0:
        return  # 已有配置，跳过

    for category, items in DEFAULT_CONFIG.items():
        for key, value in items.items():
            db.add(Config(category=category, key=key, value=value))
    db.commit()
    print("✅ 默认配置已初始化")


# 基础逻辑词库预设
INIT_LOGICS = [
    {
        "logic_name": "原料供应",
        "category": "供应",
        "description": "上游原材料价格或产量变动，直接影响下游成本或产出",
        "default_weight": 7.0,
        "importance": 1.0,
        "prompt_template": "分析板块A是否为板块B的核心原材料供应商，若A涨价或放量，B是否会受到成本传导或需求拉动？"
    },
    {
        "logic_name": "股权控制",
        "category": "政策联动",
        "description": "母子公司、交叉持股或同一实控人，存在利益输送或合并报表预期",
        "default_weight": 5.0,
        "importance": 0.8,
        "prompt_template": "分析板块A与B是否存在显著的股权隶属关系或同一国资委/实控人背景？"
    },
    {
        "logic_name": "政策扶持",
        "category": "政策联动",
        "description": "同一份行业规划或宏观政策同时利好多个细分领域",
        "default_weight": 6.0,
        "importance": 0.9,
        "prompt_template": "近期是否有顶层设计或行业政策（如'新质生产力'、'设备更新'）同时点名这两个板块？"
    },
    {
        "logic_name": "技术同源",
        "category": "技术同源",
        "description": "核心工艺、研发成果或生产线可以共用或快速迁移",
        "default_weight": 4.0,
        "importance": 0.6,
        "prompt_template": "这两个板块的产品是否共用底层的关键技术平台？"
    }
]


def init_default_logics(db: Session):
    """初始化基础逻辑词库"""
    from server.models import RelationLogic
    count = db.query(RelationLogic).count()
    if count > 0:
        return
    
    for item in INIT_LOGICS:
        db.add(RelationLogic(**item))
    db.commit()
    print("✅ 基础逻辑词库已初始化")
