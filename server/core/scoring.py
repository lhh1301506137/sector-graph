# server/core/scoring.py
# 偏差累计算法（核心计算逻辑）
# 对应产品设计文档 部分2 第四章

from datetime import date, timedelta
from typing import Optional, Dict, List
from sqlalchemy.orm import Session
from sqlalchemy import func

from server.models import Sector, Relation, DailyData, Prediction

class ScoringEngine:
    """
    [Critical Improvement] 评分引擎类
    支持内存数据桥接，从根本上解决回测时的 N+1 查询性能瓶颈
    """
    def __init__(self, db: Session, data_cache: Optional[Dict] = None):
        self.db = db
        # data_cache 格式: {date: {sector_id: DailyData}}
        self.data_cache = data_cache  
        self._logic_cache = {}

    def get_daily_data(self, sector_id: int, target_date: date):
        """优先从缓存获取日频数据"""
        if self.data_cache and target_date in self.data_cache:
            return self.data_cache[target_date].get(sector_id)
        return self.db.query(DailyData).filter(
            DailyData.sector_id == sector_id, 
            DailyData.date == target_date
        ).first()

    def get_logic_importance(self, logic_name: str) -> float:
        """从缓存或数据库获取逻辑词的重要系数"""
        if not logic_name: return 1.0
        if logic_name not in self._logic_cache:
            from server.models import RelationLogic
            logic = self.db.query(RelationLogic).filter(RelationLogic.logic_name == logic_name).first()
            self._logic_cache[logic_name] = logic.importance if logic else 1.0
        return self._logic_cache[logic_name]

    def calc_confidence(self, sector_id: int, target_date: date, window: int = 30) -> float:
        """计算置信度：支持内存窗口聚合"""
        today_data = self.get_daily_data(sector_id, target_date)
        if not today_data or today_data.net_amount is None:
            return 1.0

        if self.data_cache:
            # 内存计算均值
            vals = []
            for i in range(window + 1):
                d = target_date - timedelta(days=i)
                if d in self.data_cache and sector_id in self.data_cache[d]:
                    amount = self.data_cache[d][sector_id].net_amount
                    if amount is not None: 
                        vals.append(abs(amount))
            avg_result = sum(vals) / len(vals) if vals else 0
        else:
            # 数据库计算均值
            start_date = target_date - timedelta(days=window)
            avg_result = self.db.query(func.avg(func.abs(DailyData.net_amount))).filter(
                DailyData.sector_id == sector_id,
                DailyData.date >= start_date,
                DailyData.date <= target_date
            ).scalar()

        EPSILON = 1e-6
        if not avg_result or avg_result < EPSILON:
            return 0.5
        return min(1.0, abs(today_data.net_amount) / avg_result)

    def calc_expected_change(self, sector_id: int, target_date: date, relations: List[Relation]) -> float:
        """计算预期涨幅：支持内存关系遍历"""
        relevant_rels = [r for r in relations if r.source_id == sector_id or r.target_id == sector_id]
        if not relevant_rels: return 0.0

        numerator = 0.0
        denominator = 0.0

        for rel in relevant_rels:
            related_id = rel.target_id if rel.source_id == sector_id else rel.source_id
            related_data = self.get_daily_data(related_id, target_date)
            if not related_data: continue

            importance = self.get_logic_importance(rel.logic_name)
            confidence = self.calc_confidence(related_id, target_date)
            
            numerator += related_data.daily_change * rel.weight * rel.level_coefficient * confidence * importance
            denominator += abs(rel.weight) * rel.level_coefficient * importance

        return numerator / denominator if denominator != 0 else 0.0


def get_algo_config(db: Session) -> dict:
    """获取算法参数（从config表读取）"""
    from server.models import Config
    configs = db.query(Config).filter(Config.category == "algo").all()
    result = {c.key: c.value for c in configs}
    return {
        "time_decay_days": int(result.get("time_decay_days", "30")),
        "time_decay_min": float(result.get("time_decay_min", "0.1")),
        "ranking_top_n": int(result.get("ranking_top_n", "10")),
        "deviation_mode": result.get("deviation_mode", "positive_only"),
    }

def calc_deviation(expected: float, actual: float, mode: str = "positive_only") -> float:
    """计算偏差值"""
    diff = actual - expected
    if mode == "positive_only":
        return max(0, diff)
    return diff

def calc_time_weight(days_ago: int, decay_days: int, decay_min: float) -> float:
    """计算时间衰减系数"""
    if days_ago <= 0: return 1.0
    if days_ago >= decay_days: return decay_min
    return 1.0 - (1.0 - decay_min) * (days_ago / decay_days)


def run_scoring(db: Session, target_date: date = None, data_cache: Optional[Dict] = None) -> dict:
    """全量评分入口：现支持传入内存缓存"""
    if target_date is None: 
        target_date = date.today()
        
    config = get_algo_config(db)
    engine = ScoringEngine(db, data_cache)
    
    sectors = db.query(Sector).filter(Sector.is_active == True).all()
    all_relations = db.query(Relation).all()
    
    scores = []
    for sector in sectors:
        daily = engine.get_daily_data(sector.id, target_date)
        if not daily: continue

        expected = engine.calc_expected_change(sector.id, target_date, all_relations)
        deviation = calc_deviation(expected, daily.daily_change, mode=config["deviation_mode"])

        # 持久化当日计算出来的偏差和预期
        daily.expected_change = round(expected, 4)
        daily.deviation = round(deviation, 4)
        
        # 计算累计得分 (利用缓存加速)
        query = db.query(DailyData).filter(
            DailyData.sector_id == sector.id,
            DailyData.date <= target_date,
            DailyData.date > target_date - timedelta(days=config["time_decay_days"])
        )
        if config["deviation_mode"] == "positive_only":
            query = query.filter(DailyData.deviation > 0)
        
        cum_score = 0.0
        for rec in query.all():
            days_ago = (target_date - rec.date).days
            tw = calc_time_weight(days_ago, config["time_decay_days"], config["time_decay_min"])
            cum_score += rec.deviation * tw
        
        scores.append({"sector_id": sector.id, "score": round(cum_score, 4)})

    # 排序并更新预测表
    scores.sort(key=lambda x: x["score"], reverse=True)
    db.query(Prediction).filter(Prediction.date == target_date).delete()
    
    for i, s in enumerate(scores):
        db.add(Prediction(
            sector_id=s["sector_id"],
            date=target_date,
            score=s["score"],
            rank=i + 1
        ))
    
    db.commit()
    return {"date": str(target_date), "calculated": len(scores)}
