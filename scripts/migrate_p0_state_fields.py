"""
P0 schema migration:
1. sectors.status
2. daily_data.quality_status, daily_data.quality_reason
3. predictions.run_type, predictions.run_id
4. predictions unique key upgrade:
   uq_prediction_sector_date -> uq_prediction_sector_date_run_type
   + index idx_predictions_date_type(date, run_type)

Idempotent and safe for existing SQLite DB.
"""

import os
import sqlite3
from typing import Dict, List, Tuple


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "sector_graph.db")


def get_columns(conn: sqlite3.Connection, table: str) -> Dict[str, Tuple]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    # row format: (cid, name, type, notnull, dflt_value, pk)
    return {r[1]: r for r in rows}


def ensure_column(
    conn: sqlite3.Connection, table: str, col: str, ddl_suffix: str, backfill_value: str = None
) -> bool:
    cols = get_columns(conn, table)
    if col in cols:
        return False

    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl_suffix}")
    if backfill_value is not None:
        conn.execute(f"UPDATE {table} SET {col} = ? WHERE {col} IS NULL", (backfill_value,))
    return True


def _index_cols(conn: sqlite3.Connection, index_name: str) -> List[str]:
    return [r[2] for r in conn.execute(f"PRAGMA index_info({index_name})").fetchall()]


def has_prediction_unique_with_run_type(conn: sqlite3.Connection) -> bool:
    for row in conn.execute("PRAGMA index_list(predictions)").fetchall():
        # row: (seq, name, unique, origin, partial)
        idx_name = row[1]
        is_unique = row[2] == 1
        if not is_unique:
            continue
        cols = _index_cols(conn, idx_name)
        if cols == ["sector_id", "date", "run_type"]:
            return True
    return False


def ensure_idx_predictions_date_type(conn: sqlite3.Connection) -> bool:
    for row in conn.execute("PRAGMA index_list(predictions)").fetchall():
        idx_name = row[1]
        cols = _index_cols(conn, idx_name)
        if cols == ["date", "run_type"]:
            return False
    conn.execute("CREATE INDEX IF NOT EXISTS idx_predictions_date_type ON predictions(date, run_type)")
    return True


def migrate_predictions_unique_to_run_type(conn: sqlite3.Connection) -> bool:
    if has_prediction_unique_with_run_type(conn):
        return False

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS predictions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sector_id INTEGER NOT NULL,
            date DATE NOT NULL,
            score FLOAT DEFAULT 0.0,
            rank INTEGER DEFAULT 0,
            run_type TEXT NOT NULL DEFAULT 'prod',
            run_id TEXT NOT NULL DEFAULT ''
        )
        """
    )
    # 兼容历史数据：将空 run_type 统一回填为 prod，避免唯一键冲突与脏值
    conn.execute(
        """
        INSERT INTO predictions_new (id, sector_id, date, score, rank, run_type, run_id)
        SELECT
            p.id,
            p.sector_id,
            p.date,
            p.score,
            p.rank,
            COALESCE(NULLIF(TRIM(p.run_type), ''), 'prod') AS run_type,
            COALESCE(p.run_id, '') AS run_id
        FROM predictions p
        WHERE NOT EXISTS (
            SELECT 1
            FROM predictions_new n
            WHERE n.sector_id = p.sector_id
              AND n.date = p.date
              AND n.run_type = COALESCE(NULLIF(TRIM(p.run_type), ''), 'prod')
        )
        """
    )
    conn.execute("DROP TABLE predictions")
    conn.execute("ALTER TABLE predictions_new RENAME TO predictions")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_prediction_sector_date_run_type ON predictions(sector_id, date, run_type)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_predictions_date_type ON predictions(date, run_type)")
    return True


def main():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found: {DB_PATH}")

    print(f"Using DB: {DB_PATH}")
    created: List[str] = []

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("BEGIN")

        if ensure_column(conn, "sectors", "status", "TEXT NOT NULL DEFAULT 'active'", "active"):
            created.append("sectors.status")

        if ensure_column(conn, "daily_data", "quality_status", "TEXT NOT NULL DEFAULT 'ok'", "ok"):
            created.append("daily_data.quality_status")

        if ensure_column(conn, "daily_data", "quality_reason", "TEXT NOT NULL DEFAULT ''", ""):
            created.append("daily_data.quality_reason")

        if ensure_column(conn, "predictions", "run_type", "TEXT NOT NULL DEFAULT 'prod'", "prod"):
            created.append("predictions.run_type")

        if ensure_column(conn, "predictions", "run_id", "TEXT NOT NULL DEFAULT ''", ""):
            created.append("predictions.run_id")

        if migrate_predictions_unique_to_run_type(conn):
            created.append("predictions.unique(sector_id,date,run_type)")

        if ensure_idx_predictions_date_type(conn):
            created.append("predictions.idx(date,run_type)")

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    if created:
        print("Added columns:")
        for item in created:
            print(f"  - {item}")
    else:
        print("No changes needed; schema already up-to-date.")


if __name__ == "__main__":
    main()
