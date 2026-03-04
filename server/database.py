# server/database.py
# 鏁版嵁搴撹繛鎺ュ拰鍒濆鍖?

import os
import sqlite3
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# 鏁版嵁搴撴枃浠惰矾寰勶紙椤圭洰鏍圭洰褰曚笅 data/ 鏂囦欢澶癸級
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "sector_graph.db")

# 纭繚 data 鐩綍瀛樺湪
os.makedirs(DATA_DIR, exist_ok=True)

# SQLAlchemy 寮曟搸鍜屼細璇?
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},  # SQLite 澶氱嚎绋嬫敮鎸?
    echo=False  # 鐢熶骇鐜鍏抽棴SQL鏃ュ織锛岃皟璇曟椂璁句负True
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI 渚濊禆娉ㄥ叆锛氳幏鍙栨暟鎹簱浼氳瘽"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """鍒濆鍖栨暟鎹簱锛氬垱寤烘墍鏈夎〃"""
    from server.models import Sector, Relation, DailyData, Prediction, BacktestResult, BacktestJob, Config
    Base.metadata.create_all(bind=engine)
    _ensure_daily_data_schema()
    _ensure_backtest_results_schema()
    print(f"Database initialized: {DB_PATH}")


def _ensure_daily_data_schema():
    """兼容历史 SQLite：为 daily_data 补齐新字段。"""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("BEGIN")
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_data'"
        ).fetchone()
        if not table_exists:
            conn.commit()
            return

        cols = conn.execute("PRAGMA table_info(daily_data)").fetchall()
        col_names = {r[1] for r in cols}

        if "volume" not in col_names:
            conn.execute("ALTER TABLE daily_data ADD COLUMN volume FLOAT DEFAULT 0.0")

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _ensure_backtest_results_schema():
    """
    兼容历史 SQLite：
    - 旧表缺少 run_id 列时自动补齐
    - 旧表若仍是 date 唯一，则重建为 (run_id, date) 唯一
    - 为 date/run_id 查询补充索引
    """
    def _index_cols(c: sqlite3.Connection, index_name: str):
        return [r[2] for r in c.execute(f"PRAGMA index_info({index_name})").fetchall()]

    def _has_legacy_unique_date(c: sqlite3.Connection) -> bool:
        for row in c.execute("PRAGMA index_list(backtest_results)").fetchall():
            idx_name = row[1]
            is_unique = int(row[2]) == 1
            if not is_unique:
                continue
            if _index_cols(c, idx_name) == ["date"]:
                return True
        return False

    def _rebuild_backtest_results(c: sqlite3.Connection, has_run_id: bool):
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS backtest_results_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL DEFAULT '',
                date DATE NOT NULL,
                top_10_hits INTEGER DEFAULT 0,
                random_hit_rate FLOAT DEFAULT 0.0,
                average_alpha FLOAT DEFAULT 0.0,
                details TEXT DEFAULT '[]',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        if has_run_id:
            c.execute(
                """
                INSERT INTO backtest_results_new
                (id, run_id, date, top_10_hits, random_hit_rate, average_alpha, details, created_at)
                SELECT
                    id,
                    COALESCE(run_id, ''),
                    date,
                    COALESCE(top_10_hits, 0),
                    COALESCE(random_hit_rate, 0.0),
                    COALESCE(average_alpha, 0.0),
                    COALESCE(details, '[]'),
                    COALESCE(created_at, CURRENT_TIMESTAMP)
                FROM backtest_results
                """
            )
        else:
            c.execute(
                """
                INSERT INTO backtest_results_new
                (id, run_id, date, top_10_hits, random_hit_rate, average_alpha, details, created_at)
                SELECT
                    id,
                    '',
                    date,
                    COALESCE(top_10_hits, 0),
                    COALESCE(random_hit_rate, 0.0),
                    COALESCE(average_alpha, 0.0),
                    COALESCE(details, '[]'),
                    COALESCE(created_at, CURRENT_TIMESTAMP)
                FROM backtest_results
                """
            )
        c.execute("DROP TABLE backtest_results")
        c.execute("ALTER TABLE backtest_results_new RENAME TO backtest_results")

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("BEGIN")
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='backtest_results'"
        ).fetchone()
        if not table_exists:
            conn.commit()
            return

        cols = conn.execute("PRAGMA table_info(backtest_results)").fetchall()
        col_names = {r[1] for r in cols}
        has_run_id = "run_id" in col_names
        legacy_unique_date = _has_legacy_unique_date(conn)

        # 旧结构会导致按 run_id 结果复现不可用，需一次性重建
        if (not has_run_id) or legacy_unique_date:
            _rebuild_backtest_results(conn, has_run_id=has_run_id)

        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_backtest_result_run_date ON backtest_results(run_id, date)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_backtest_results_date_run ON backtest_results(date, run_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_backtest_results_run_id ON backtest_results(run_id)"
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

