"""Overture Divisions provider.

Used to find candidate peer cities with reliable populations and coordinates
(real-world data, same release as the POI data).
"""
from __future__ import annotations

from typing import Any, Optional

from ..cache import cache
from . import overture


def _base() -> str:
    return (
        f"s3://overturemaps-us-west-2/release/{overture.latest_release()}/"
        f"theme=divisions/type=division/*"
    )


def _query(sql: str) -> list[tuple]:
    import duckdb

    con = duckdb.connect()
    try:
        con.execute("INSTALL httpfs; LOAD httpfs;")
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute("SET allow_asterisks_in_http_paths = true;")
        con.execute("SET s3_region = 'us-west-2';")
        con.execute("SET enable_progress_bar = false;")
        return con.execute(sql).fetchall()
    finally:
        con.close()


def cities_in_country(country_code: str, min_pop: int, max_pop: int, limit: int = 120) -> list[dict]:
    ckey = f"divisions:cities:{country_code}:{min_pop}:{max_pop}"
    cached = cache.get(ckey)
    if cached is not None:
        return cached
    sql = f"""
SELECT names.primary AS name, population, wikidata, country,
       ST_Y(ST_Centroid(geometry)) AS lat, ST_X(ST_Centroid(geometry)) AS lon
FROM read_parquet('{_base()}', filename=true, hive_partitioning=1)
WHERE country = '{country_code.upper()}'
  AND subtype = 'locality'
  AND population IS NOT NULL
  AND population >= {min_pop} AND population <= {max_pop}
ORDER BY population DESC
LIMIT {limit}
"""
    try:
        rows = _query(sql)
        out = [_row(r) for r in rows]
    except Exception:
        out = []
    cache.set(ckey, out, 14 * 86400)
    return out


def cities_near_population(target_pop: int, min_pop: int, max_pop: int,
                           exclude_country: str | None = None, limit: int = 60) -> list[dict]:
    ckey = f"divisions:intl:{target_pop}:{min_pop}:{max_pop}:{exclude_country or ''}"
    cached = cache.get(ckey)
    if cached is not None:
        return cached
    excl = f" AND country != '{exclude_country.upper()}'" if exclude_country else ""
    sql = f"""
SELECT names.primary AS name, population, wikidata, country,
       ST_Y(ST_Centroid(geometry)) AS lat, ST_X(ST_Centroid(geometry)) AS lon
FROM read_parquet('{_base()}', filename=true, hive_partitioning=1)
WHERE subtype = 'locality'
  AND population IS NOT NULL
  AND population >= {min_pop} AND population <= {max_pop}
  {excl}
ORDER BY ABS(population - {target_pop}) ASC
LIMIT {limit}
"""
    try:
        rows = _query(sql)
        out = [_row(r) for r in rows]
    except Exception:
        out = []
    cache.set(ckey, out, 14 * 86400)
    return out


def _row(r: tuple) -> dict:
    name, pop, wikidata, country, lat, lon = r
    return {
        "name": name or "",
        "pop": int(pop or 0),
        "qid": wikidata or None,
        "cc": (country or "").upper(),
        "lat": float(lat) if lat is not None else None,
        "lon": float(lon) if lon is not None else None,
    }
