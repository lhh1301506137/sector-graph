# server/models.py
# 数据库模型定义（对应产品设计文档 部分1 第三章）

from datetime import datetime, date
from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, Text, UniqueConstraint
from server.database import Base


class Sector(Base):
    """板块表"""
    __tablename__ = "sectors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, unique=True, nullable=False, comment="板块名称")
    category_type = Column(String, default="概念", comment="行业/概念")
    api_id = Column(String, default="", comment="API标识")
    level = Column(Integer, default=2, comment="层级 1/2/3")
    parent_id = Column(Integer, default=None, comment="父板块ID")
    is_active = Column(Boolean, default=True, comment="是否在图谱中显示")
    is_favorited = Column(Boolean, default=False, comment="是否关注")
    created_at = Column(DateTime, default=datetime.now)


class Relation(Base):
    """关联关系表"""
    __tablename__ = "relations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(Integer, nullable=False, comment="源板块ID")
    target_id = Column(Integer, nullable=False, comment="目标板块ID")
    type = Column(String, default="供应", comment="10种关系类型之一")
    logic_name = Column(String, default="", comment="关联的具体逻辑模式名称")
    weight = Column(Float, default=5.0, comment="权重 -10~+10")
    direction = Column(String, default="A↔B", comment="方向")
    level_coefficient = Column(Float, default=1.0, comment="层级系数")
    is_locked = Column(Boolean, default=False, comment="用户锁定标记")
    source = Column(String, default="manual", comment="来源: system/ai/manual")
    valid_from = Column(Date, default=None, comment="生效起始（预留）")
    valid_to = Column(Date, default=None, comment="生效截止（预留）")
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)


class DailyData(Base):
    """每日数据表"""
    __tablename__ = "daily_data"
    __table_args__ = (
        UniqueConstraint("sector_id", "date", name="uq_sector_date"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    sector_id = Column(Integer, nullable=False, comment="板块ID")
    date = Column(Date, nullable=False, comment="日期")
    daily_change = Column(Float, default=0.0, comment="实际涨跌幅%")
    expected_change = Column(Float, default=None, comment="预期涨幅%")
    deviation = Column(Float, default=None, comment="偏差值")
    cumulative_deviation = Column(Float, default=None, comment="累计偏差得分")
    net_amount = Column(Float, default=0.0, comment="净流入（亿）")
    turnover = Column(Float, default=0.0, comment="换手率")
    lead_stock = Column(String, default="", comment="领涨股名称")
    lead_stock_change = Column(Float, default=0.0, comment="领涨股涨幅%")


class Prediction(Base):
    """预测记录表"""
    __tablename__ = "predictions"
    __table_args__ = (
        UniqueConstraint("sector_id", "date", name="uq_prediction_sector_date"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    sector_id = Column(Integer, nullable=False, comment="板块ID")
    date = Column(Date, nullable=False, comment="预测日期")
    score = Column(Float, default=0.0, comment="累计偏差得分")
    rank = Column(Integer, default=0, comment="当日排名")


class BacktestResult(Base):
    """回测结果表 (Upgrade: 支持 Alpha 和 Random 基准)"""
    __tablename__ = "backtest_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Date, unique=True, nullable=False, comment="回测目标日期")
    top_10_hits = Column(Integer, default=0, comment="Top 10 板块中命中的数量")
    random_hit_rate = Column(Float, default=0.0, comment="随机对照组命中率%")
    average_alpha = Column(Float, default=0.0, comment="超额收益率 Alpha %")
    details = Column(Text, default="[]", comment="JSON 格式的详细列表")
    created_at = Column(DateTime, default=datetime.now)


class Config(Base):
    """配置表"""
    __tablename__ = "config"
    __table_args__ = (
        UniqueConstraint("category", "key", name="uq_config_category_key"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    category = Column(String, nullable=False, comment="分组: ai/algo/user")
    key = Column(String, nullable=False, comment="配置键")
    value = Column(Text, default="", comment="配置值JSON")


class RelationLogic(Base):
    """逻辑关联词库表（Step 6.5 新增）"""
    __tablename__ = "relation_logics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    logic_name = Column(String, unique=True, nullable=False, comment="逻辑名称，如'原料供应'")
    category = Column(String, default="供应", comment="关联大类")
    description = Column(Text, default="", comment="逻辑详细说明")
    default_weight = Column(Float, default=5.0, comment="建议初始权重")
    importance = Column(Float, default=1.0, comment="重要程度系数")
    prompt_template = Column(Text, default="", comment="供AI参考的Prompt片段")
    created_at = Column(DateTime, default=datetime.now)


class PendingAISuggestion(Base):
    """待确认的AI建议表（Step 7 鲁棒性修复新增）"""
    __tablename__ = "pending_ai_suggestions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(Integer, nullable=False)
    target_id = Column(Integer, nullable=False)
    source_name = Column(String)
    target_name = Column(String)
    logic_name = Column(String)
    weight = Column(Float)
    reason = Column(Text)
    status = Column(String, default="pending")  # pending/confirmed/rejected
    created_at = Column(DateTime, default=datetime.now)
