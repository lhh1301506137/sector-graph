"""
Create backtest_jobs table if not exists.

Safe to run repeatedly.
"""

import os
import sqlite3


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "sector_graph.db")


def main():
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS backtest_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                status TEXT DEFAULT 'queued',
                days INTEGER DEFAULT 60,
                started_at DATETIME,
                ended_at DATETIME,
                error_message TEXT DEFAULT '',
                params_snapshot TEXT DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_backtest_job_run_id ON backtest_jobs(run_id)"
        )
        conn.commit()
        print("backtest_jobs migration done.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

