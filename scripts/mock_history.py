# scripts/mock_history.py
import random
from datetime import date, timedelta
from server.database import SessionLocal
from server.models import Sector, DailyData, Relation, RelationLogic

def mock_data():
    db = SessionLocal()
    try:
        # 1. 确保有板块和逻辑
        sectors = db.query(Sector).all()
        if not sectors:
            print("请先执行刷新数据获取板块。")
            return
            
        logics = db.query(RelationLogic).all()
        if not logics:
            print("逻辑词库为空，无法模拟。")
            return

        # 2. 生成最近 14 天的数据
        today = date.today()
        for i in range(14, 0, -1):
            d = today - timedelta(days=i)
            print(f"模拟日期: {d}")
            for s in sectors[:20]: # 模拟前20个活跃板块
                # 随机生成涨跌幅 -5% 到 +5%
                daily_change = random.uniform(-4.0, 6.0)
                
                # 检查是否已存在
                existing = db.query(DailyData).filter(DailyData.sector_id == s.id, DailyData.date == d).first()
                if not existing:
                    data = DailyData(
                        sector_id=s.id,
                        date=d,
                        daily_change=round(daily_change, 2),
                        net_amount=random.uniform(-10, 50),
                        turnover=random.uniform(0.5, 5.0)
                    )
                    db.add(data)
        
        # 3. 模拟一些随机关系 (为了让 Alpha 有波动)
        if db.query(Relation).count() < 10:
            print("生成随机关系样本...")
            for i in range(15):
                s1 = random.choice(sectors)
                s2 = random.choice(sectors)
                if s1.id == s2.id: continue
                logic = random.choice(logics)
                rel = Relation(
                    source_id=s1.id,
                    target_id=s2.id,
                    logic_name=logic.logic_name,
                    weight=random.uniform(5, 10),
                    source="ai"
                )
                db.add(rel)

        db.commit()
        print("模拟历史数据完成。")
    finally:
        db.close()

if __name__ == "__main__":
    mock_data()
