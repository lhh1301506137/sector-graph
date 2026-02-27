import os
import sys
import argparse

# 将项目根目录加入 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from server.database import init_db, engine, Base

def main():
    parser = argparse.ArgumentParser(description="初始化 Sector Graph 数据库")
    parser.add_argument('-f', '--force', action='store_true', help="如果指定，将先删除已存在的表结构再重新创建 (危险操作，可能丢失生产数据)")
    args = parser.parse_args()

    if args.force:
        print("警告: 收到强制清理指令，正在删除现有表结构...")
        try:
            from server.models import Sector, Relation, DailyData, Prediction, BacktestResult, BacktestJob, Config
            Base.metadata.drop_all(bind=engine)
            print("原有表结构已彻底清除。")
        except Exception as e:
            print(f"删除失败: {e}")

    print("正在创建 Sector Graph 数据库与表结构映射...")
    try:
        init_db()
        print("✅ 数据库部署准备完毕，可以顺利启动后端服务。")
    except Exception as e:
        print(f"❌ 数据库初始化异常: {e}")

if __name__ == "__main__":
    main()
