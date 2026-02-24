# server/core/backtest.py
# 历史回测验证引擎

import json
from datetime import date, timedelta
from typing import List, Dict
from sqlalchemy.orm import Session
from sqlalchemy import func

from server.models import Sector, DailyData, Prediction, BacktestResult
from server.core.scoring import run_scoring

class BacktestEngine:
    def __init__(self, db: Session):
        self.db = db

    async def run_period_backtest(self, days: int = 60) -> Dict:
        """
        [Upgrade] 内存优化版回测引擎
        """
        today = date.today()
        # 预留深度：评分窗口(30) + 预测窗口(1)
        start_date = today - timedelta(days=days + 35) 
        
        # 1. 内存快照化：一次性拉取所有板块和每日数据
        sectors = self.db.query(Sector).filter(Sector.is_active == True).all()
        sector_map = {s.id: s.name for s in sectors}
        
        # 拉取全量历史表现
        all_daily = self.db.query(DailyData).filter(
            DailyData.date >= start_date
        ).all()
        
        # 构建索引: {date: {sector_id: record}}
        data_index = {}
        for d in all_daily:
            if d.date not in data_index:
                data_index[d.date] = {}
            data_index[d.date][d.sector_id] = d

        valid_dates = sorted(data_index.keys())
        # 确定回测的目标日期序列 (最近N天)
        test_dates = [d for d in valid_dates if d >= (today - timedelta(days=days)) and d < today]
        
        total_hits = 0
        total_random_hits = 0
        total_alpha = 0.0
        valid_days = 0

        for current_date in test_dates:
            # 2. 模拟当天视角进行评分 (传入全局 data_index)
            scoring_res = run_scoring(self.db, current_date, data_cache=data_index)
            if scoring_res["calculated"] == 0:
                continue

            # 3. 统计当日 Top 10
            top_10 = self.db.query(Prediction).filter(
                Prediction.date == current_date
            ).order_by(Prediction.rank).limit(10).all()
            
            if not top_10: continue

            # 4. 验证 T+1 的表现 (Alpha 与 命中)
            t_plus_1 = None
            for d in valid_dates:
                if d > current_date:
                    t_plus_1 = d
                    break
            
            if not t_plus_1 or t_plus_1 not in data_index:
                continue

            # 获取当日全场表现，用于计算 Alpha 和 基准
            market_daily = data_index[t_plus_1]
            # 过滤掉 0 涨跌（停牌）的板块以防噪音
            market_changes = [d.daily_change for d in market_daily.values() if d.daily_change != 0]
            if not market_changes: continue
            
            # 计算市场中位数作为基准
            market_median = sorted(market_changes)[len(market_changes)//2]
            
            # Top 10 命中率验证 (进入全场涨幅前 20 名)
            top_20_ids = set([sid for sid, d in sorted(market_daily.items(), key=lambda x: x[1].daily_change, reverse=True)[:20]])
            
            hit_count = 0
            top_10_changes = []
            details = []
            
            for p in top_10:
                is_hit = (p.sector_id in top_20_ids)
                if is_hit: hit_count += 1
                
                # 获取 T+1 涨幅
                change = market_daily.get(p.sector_id).daily_change if p.sector_id in market_daily else 0
                top_10_changes.append(change)
                
                details.append({
                    "name": sector_map.get(p.sector_id),
                    "score": p.score,
                    "change_t1": change,
                    "is_hit": is_hit
                })

            avg_top_10_change = sum(top_10_changes) / 10.0
            daily_alpha = avg_top_10_change - market_median
            
            # 5. 计算随机对照命中率 (Random Hit Rate)
            random_hits_expected = (20.0 / len(market_daily)) * 10
            
            # 6. 持久化
            backtest_rec = self.db.query(BacktestResult).filter(BacktestResult.date == current_date).first()
            if not backtest_rec:
                backtest_rec = BacktestResult(date=current_date)
                self.db.add(backtest_rec)
            
            backtest_rec.top_10_hits = hit_count
            backtest_rec.average_alpha = round(daily_alpha, 4)
            backtest_rec.random_hit_rate = round(random_hits_expected, 4)
            backtest_rec.details = json.dumps(details, ensure_ascii=False)
            
            total_hits += hit_count
            total_random_hits += random_hits_expected
            total_alpha += daily_alpha
            valid_days += 1

        self.db.commit()
        
        return {
            "total_days": valid_days,
            "avg_hit_rate": (total_hits / (valid_days * 10)) * 100 if valid_days else 0,
            "avg_alpha": (total_alpha / valid_days) if valid_days else 0,
            "baseline_hit_rate": (total_random_hits / (valid_days * 10)) * 100 if valid_days else 0
        }

    def get_history_performance(self, limit: int = 30) -> List:
        """获取最近的回测表现趋势"""
        results = self.db.query(BacktestResult).order_by(BacktestResult.date.desc()).limit(limit).all()
        return [
            {
                "date": str(r.date),
                "hit_rate": (r.top_10_hits / 10.0) * 100,
                "hits": r.top_10_hits,
                "alpha": r.average_alpha,
                "random_hit_rate": r.random_hit_rate
            } for r in results
        ]

    def get_day_detail(self, target_date: str) -> Dict:
        """获取指定日期的 Top 10 回测明细"""
        from datetime import datetime
        dt = datetime.strptime(target_date, "%Y-%m-%d").date()
        result = self.db.query(BacktestResult).filter(BacktestResult.date == dt).first()
        
        if not result:
            return {"date": target_date, "details": [], "hits": 0, "alpha": 0.0}
            
        import json
        import logging
        details = []
        try:
            details = json.loads(result.details) if result.details else []
        except json.JSONDecodeError as e:
            logging.error(f"Failed to decode backtest details for {target_date}: {e}")
            
        return {
            "date": target_date,
            "hits": result.top_10_hits,
            "alpha": result.average_alpha,
            "details": details
        }
