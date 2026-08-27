"""SQLite-backed persistence for background jobs.

Survives process restarts (e.g. Fly scale-to-zero): job rows, results, and
payloads are stored in DATA_DIR/jobs.sqlite; jobs that were queued or running
when the process stopped are re-queued automatically on boot.
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Optional


class JobStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT,
                progress REAL DEFAULT 0,
                message TEXT,
                result TEXT,
                error TEXT,
                created_at TEXT,
                updated_at TEXT
            )"""
        )
        self._conn.commit()

    def upsert(
        self,
        job_id: str,
        kind: str,
        payload: str,
        status: str,
        stage: str,
        progress: float,
        message: Optional[str],
        result: Optional[str],
        error: Optional[str],
        created_at: str,
        updated_at: str,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (job_id,kind,payload,status,stage,progress,message,result,error,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(job_id) DO UPDATE SET kind=excluded.kind, payload=excluded.payload,"
                " status=excluded.status, stage=excluded.stage, progress=excluded.progress,"
                " message=excluded.message, result=excluded.result, error=excluded.error,"
                " created_at=excluded.created_at, updated_at=excluded.updated_at",
                (job_id, kind, payload, status, stage, progress, message, result, error, created_at, updated_at),
            )
            self._conn.commit()

    def update(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        cols = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [job_id]
        with self._lock:
            self._conn.execute(f"UPDATE jobs SET {cols} WHERE job_id = ?", vals)
            self._conn.commit()

    def load_all(self) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute("SELECT * FROM jobs")
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
        return [dict(zip(cols, r)) for r in rows]

    def delete_older_than(self, iso_cutoff: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM jobs WHERE updated_at < ?", (iso_cutoff,))
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
