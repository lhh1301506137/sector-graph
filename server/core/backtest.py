# server/core/backtest.py
# 历史回测验证引擎

import json
from datetime import date, timedelta
from typing import List, Dict, Optional, Callable
from sqlalchemy.orm import Session
from sqlalchemy import text

from server.models import Sector, DailyData, BacktestResult, BacktestJob
from server.core.scoring import run_scoring

class BacktestEngine:
    def __init__(self, db: Session):
        self.db = db
        self._legacy_date_unique_schema = self._detect_legacy_date_unique_schema()

    def _detect_legacy_date_unique_schema(self) -> bool:
        """判断 backtest_results 是否仍为 date 唯一的旧结构。"""
        try:
            rows = self.db.execute(text("PRAGMA index_list(backtest_results)")).fetchall()
            for row in rows:
                idx_name = row[1]
                is_unique = int(row[2]) == 1
                if not is_unique:
                    continue
                cols = self.db.execute(
                    text(f"PRAGMA index_info({idx_name})")
                ).fetchall()
                col_names = [c[2] for c in cols]
                if col_names == ["date"]:
                    return True
        except Exception:
            return False
        return False

    def _resolve_effective_run_id(self, preferred_run_id: str = "") -> str:
        candidate = str(preferred_run_id or "").strip()
        if candidate:
            return candidate
        recent_jobs = self.db.query(BacktestJob.run_id).filter(
            BacktestJob.status.in_(["completed", "cancelled", "failed"])
        ).order_by(BacktestJob.id.desc()).limit(40).all()
        for row in recent_jobs:
            rid = str(row[0] or "").strip()
            if not rid:
                continue
            exists = self.db.query(BacktestResult.id).filter(
                BacktestResult.run_id == rid
            ).first()
            if exists:
                return rid
        latest = self.db.query(BacktestResult.run_id).filter(
            BacktestResult.run_id != ""
        ).order_by(BacktestResult.id.desc()).first()
        if latest and latest[0]:
            return str(latest[0]).strip()
        return ""

    def _lookup_params_snapshot(self, run_id: str) -> str:
        rid = str(run_id or "").strip()
        if not rid:
            return "{}"
        row = self.db.query(BacktestJob.params_snapshot).filter(
            BacktestJob.run_id == rid
        ).first()
        if not row or row[0] is None:
            return "{}"
        text = str(row[0]).strip()
        return text if text else "{}"

    async def run_period_backtest(
        self,
        days: int = 60,
        run_id: str = "",
        should_cancel: Optional[Callable[[], bool]] = None,
    ) -> Dict:
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
            if should_cancel and should_cancel():
                self.db.commit()
                return {
                    "run_id": run_id or "",
                    "total_days": valid_days,
                    "avg_hit_rate": (total_hits / (valid_days * 10)) * 100 if valid_days else 0,
                    "avg_alpha": (total_alpha / valid_days) if valid_days else 0,
                    "baseline_hit_rate": (total_random_hits / (valid_days * 10)) * 100 if valid_days else 0,
                    "cancelled": True,
                }

            # 2. 模拟当天视角进行评分 (传入全局 data_index)
            scoring_res = run_scoring(
                self.db,
                current_date,
                data_cache=data_index,
                persist_prediction=False,
                run_type="backtest",
                run_id=run_id or "",
            )
            if scoring_res["calculated"] == 0:
                continue

            # 3. 统计当日 Top 10
            top_10 = scoring_res.get("scores", [])[:10]
            
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
                sector_id = p["sector_id"]
                score = p["score"]
                is_hit = (sector_id in top_20_ids)
                if is_hit: hit_count += 1
                
                # 获取 T+1 涨幅
                change = market_daily.get(sector_id).daily_change if sector_id in market_daily else 0
                top_10_changes.append(change)
                
                details.append({
                    "name": sector_map.get(sector_id),
                    "score": score,
                    "change_t1": change,
                    "is_hit": is_hit
                })

            avg_top_10_change = sum(top_10_changes) / 10.0
            daily_alpha = avg_top_10_change - market_median
            
            # 5. 计算随机对照命中率 (Random Hit Rate)
            random_hits_expected = (20.0 / len(market_daily)) * 10
            
            # 6. 持久化
            effective_run_id = str(run_id or "").strip()
            backtest_rec = self.db.query(BacktestResult).filter(
                BacktestResult.date == current_date,
                BacktestResult.run_id == effective_run_id,
            ).first()
            # 仅兼容旧库（date 唯一）时，回退到按 date 覆盖
            if (not backtest_rec) and self._legacy_date_unique_schema:
                backtest_rec = self.db.query(BacktestResult).filter(
                    BacktestResult.date == current_date
                ).first()
            if not backtest_rec:
                backtest_rec = BacktestResult(
                    run_id=effective_run_id,
                    date=current_date,
                )
                self.db.add(backtest_rec)
            else:
                backtest_rec.run_id = effective_run_id
            
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
            "run_id": run_id or "",
            "total_days": valid_days,
            "avg_hit_rate": (total_hits / (valid_days * 10)) * 100 if valid_days else 0,
            "avg_alpha": (total_alpha / valid_days) if valid_days else 0,
            "baseline_hit_rate": (total_random_hits / (valid_days * 10)) * 100 if valid_days else 0,
            "cancelled": False,
        }

    def get_history_performance(self, limit: int = 30, run_id: str = "") -> List:
        """获取最近的回测表现趋势"""
        effective_run_id = self._resolve_effective_run_id(run_id)
        query = self.db.query(BacktestResult)
        if effective_run_id:
            query = query.filter(BacktestResult.run_id == effective_run_id)
        else:
            query = query.filter(BacktestResult.run_id == "")
        results = query.order_by(BacktestResult.date.desc()).limit(limit).all()
        params_snapshot = self._lookup_params_snapshot(effective_run_id)
        return [
            {
                "date": str(r.date),
                "run_id": effective_run_id,
                "params_snapshot": params_snapshot,
                "hit_rate": (r.top_10_hits / 10.0) * 100,
                "hits": r.top_10_hits,
                "alpha": r.average_alpha,
                "random_hit_rate": r.random_hit_rate
            } for r in results
        ]

    def get_day_detail(self, target_date: str, run_id: str = "") -> Dict:
        """获取指定日期的 Top 10 回测明细"""
        from datetime import datetime
        dt = datetime.strptime(target_date, "%Y-%m-%d").date()
        effective_run_id = self._resolve_effective_run_id(run_id)
        query = self.db.query(BacktestResult).filter(BacktestResult.date == dt)
        if effective_run_id:
            query = query.filter(BacktestResult.run_id == effective_run_id)
        else:
            query = query.filter(BacktestResult.run_id == "")
        result = query.first()
        params_snapshot = self._lookup_params_snapshot(effective_run_id)
        
        if not result:
            return {
                "date": target_date,
                "run_id": effective_run_id,
                "params_snapshot": params_snapshot,
                "details": [],
                "hits": 0,
                "alpha": 0.0,
            }
            
        import json
        import logging
        details = []
        try:
            details = json.loads(result.details) if result.details else []
        except json.JSONDecodeError as e:
            logging.error(f"Failed to decode backtest details for {target_date}: {e}")
            
        return {
            "date": target_date,
            "run_id": effective_run_id,
            "params_snapshot": params_snapshot,
            "hits": result.top_10_hits,
            "alpha": result.average_alpha,
            "details": details
        }
