"""SQLite-backed JSON cache with TTLs. Thread-safe via a lock."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from . import config


class Cache:
    def __init__(self, path: str | None = None):
        self._path = str(path or config.CACHE_DB)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._init()

    def _connect(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self._path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
        return self._conn

    def _init(self) -> None:
        with self._lock:
            conn = self._connect()
            conn.execute(
                """CREATE TABLE IF NOT EXISTS cache (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )"""
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at)")
            conn.commit()

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            conn = self._connect()
            row = conn.execute(
                "SELECT value, expires_at FROM cache WHERE key = ?", (key,)
            ).fetchone()
            if row is None:
                return default
            value, expires_at = row
            if expires_at < time.time():
                conn.execute("DELETE FROM cache WHERE key = ?", (key,))
                conn.commit()
                return default
            try:
                return json.loads(value)
            except Exception:
                return default

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        with self._lock:
            conn = self._connect()
            now = time.time()
            expires = now + (ttl if ttl is not None else 3600)
            conn.execute(
                """INSERT INTO cache (key, value, expires_at, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                     value = excluded.value,
                     expires_at = excluded.expires_at,
                     updated_at = excluded.updated_at""",
                (key, json.dumps(value, ensure_ascii=False), expires, now),
            )
            conn.commit()

    def delete(self, key: str) -> None:
        with self._lock:
            self._connect().execute("DELETE FROM cache WHERE key = ?", (key,))
            self._connect().commit()

    def touch(self, key: str, ttl: int) -> bool:
        """Refresh the TTL of a key if present."""
        with self._lock:
            conn = self._connect()
            now = time.time()
            cur = conn.execute(
                "UPDATE cache SET expires_at = ? WHERE key = ?", (now + ttl, key)
            )
            conn.commit()
            return cur.rowcount > 0

    def cleanup(self) -> int:
        with self._lock:
            conn = self._connect()
            cur = conn.execute("DELETE FROM cache WHERE expires_at < ?", (time.time(),))
            conn.commit()
            return cur.rowcount


cache = Cache()


def city_cache_key(prefix: str, *parts: str) -> str:
    return ":".join([prefix, *[p.strip().lower().replace(" ", "_") for p in parts if p]])
