# server/models.py
# 数据库模型定义（对应产品设计文档 部分1 第三章）

from datetime import datetime, date
from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, Text, UniqueConstraint, Index
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
    status = Column(String, default="active", nullable=False, comment="业务状态: new_detected/ai_pending/active/disabled/archived")
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
    volume = Column(Float, default=0.0, comment="成交量（万手）")
    turnover = Column(Float, default=0.0, comment="换手率")
    lead_stock = Column(String, default="", comment="领涨股名称")
    lead_stock_change = Column(Float, default=0.0, comment="领涨股涨幅%")
    quality_status = Column(String, default="ok", nullable=False, comment="数据质量状态: ok/failed")
    quality_reason = Column(String, default="", comment="质量异常原因")


class Prediction(Base):
    """预测记录表"""
    __tablename__ = "predictions"
    __table_args__ = (
        UniqueConstraint("sector_id", "date", "run_type", name="uq_prediction_sector_date_run_type"),
        Index("idx_predictions_date_type", "date", "run_type"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    sector_id = Column(Integer, nullable=False, comment="板块ID")
    date = Column(Date, nullable=False, comment="预测日期")
    score = Column(Float, default=0.0, comment="累计偏差得分")
    rank = Column(Integer, default=0, comment="当日排名")
    run_type = Column(String, default="prod", nullable=False, comment="结果类型: prod/backtest/draft")
    run_id = Column(String, default="", comment="运行批次ID")


class BacktestResult(Base):
    """回测结果表 (Upgrade: 支持 Alpha 和 Random 基准)"""
    __tablename__ = "backtest_results"
    __table_args__ = (
        UniqueConstraint("run_id", "date", name="uq_backtest_result_run_date"),
        Index("idx_backtest_result_date_run", "date", "run_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, default="", nullable=False, comment="回测任务ID")
    date = Column(Date, nullable=False, comment="回测目标日期")
    top_10_hits = Column(Integer, default=0, comment="Top 10 板块中命中的数量")
    random_hit_rate = Column(Float, default=0.0, comment="随机对照组命中率%")
    average_alpha = Column(Float, default=0.0, comment="超额收益率 Alpha %")
    details = Column(Text, default="[]", comment="JSON 格式的详细列表")
    created_at = Column(DateTime, default=datetime.now)


class BacktestJob(Base):
    """回测任务表"""
    __tablename__ = "backtest_jobs"
    __table_args__ = (
        UniqueConstraint("run_id", name="uq_backtest_job_run_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, nullable=False, comment="回测任务ID")
    status = Column(String, default="queued", comment="任务状态: queued/running/completed/failed/cancelled")
    days = Column(Integer, default=60, comment="回测天数")
    started_at = Column(DateTime, default=None, comment="开始时间")
    ended_at = Column(DateTime, default=None, comment="结束时间")
    error_message = Column(Text, default="", comment="错误信息")
    params_snapshot = Column(Text, default="{}", comment="参数快照JSON")
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)


class AlgoOptimizationSuggestion(Base):
    """参数优化建议（AI增强阶段：绑定 run_id 可追踪）。"""
    __tablename__ = "algo_optimization_suggestions"
    __table_args__ = (
        Index("idx_algo_opt_run_created", "run_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String, nullable=False, comment="来源回测任务ID")
    source_type = Column(String, default="backtest", comment="建议来源类型")
    status = Column(String, default="generated", comment="状态 generated/applied/dismissed")
    summary = Column(Text, default="{}", comment="汇总指标JSON")
    current_params = Column(Text, default="{}", comment="当前算法参数JSON")
    suggested_params = Column(Text, default="{}", comment="建议参数JSON")
    reasoning = Column(Text, default="[]", comment="建议理由JSON数组")
    created_at = Column(DateTime, default=datetime.now)
    applied_at = Column(DateTime, default=None, comment="应用时间")


class AlgoConfigVersion(Base):
    """算法配置版本快照（AI增强阶段：配置版本化与回滚）。"""
    __tablename__ = "algo_config_versions"
    __table_args__ = (
        Index("idx_algo_cfg_ver_created", "created_at"),
        Index("idx_algo_cfg_ver_source_run", "source_run_id", "created_at"),
        Index("idx_algo_cfg_ver_applied", "applied_at"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_type = Column(String, default="manual", comment="来源类型: manual/suggestion/rollback")
    source_run_id = Column(String, default="", comment="来源回测 run_id")
    source_suggestion_id = Column(Integer, default=0, comment="来源建议ID")
    reason = Column(Text, default="", comment="保存或应用理由")
    status = Column(String, default="saved", comment="状态: saved/applied/refeeded")
    snapshot = Column(Text, default="{}", comment="算法配置快照JSON")
    changed_keys = Column(Text, default="[]", comment="变更字段JSON数组")
    created_at = Column(DateTime, default=datetime.now)
    applied_at = Column(DateTime, default=None, comment="应用时间")


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
