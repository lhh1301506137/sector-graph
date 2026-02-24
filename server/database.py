# server/database.py
# 数据库连接和初始化

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# 数据库文件路径（项目根目录下 data/ 文件夹）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "sector_graph.db")

# 确保 data 目录存在
os.makedirs(DATA_DIR, exist_ok=True)

# SQLAlchemy 引擎和会话
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},  # SQLite 多线程支持
    echo=False  # 生产环境关闭SQL日志，调试时设为True
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI 依赖注入：获取数据库会话"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """初始化数据库：创建所有表"""
    from server.models import Sector, Relation, DailyData, Prediction, BacktestResult, Config
    Base.metadata.create_all(bind=engine)
    print(f"✅ 数据库已初始化: {DB_PATH}")
