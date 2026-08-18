"""OpenStreetMap coverage validation via Overpass.

Used only to cross-check Overture counts (coverage validation), never as the
primary POI source. If Overpass is unreachable the validator returns None and
the caller marks validation as unavailable instead of failing. A probe query
runs first so a dead endpoint fails fast instead of eating many timeouts.
"""
from __future__ import annotations

import datetime
import time
from typing import Any, Optional

import httpx

from .. import config
from ..cache import cache


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _count_query(area_id: int, key: str) -> str:
    return (
        f'[out:json][timeout:20];area({area_id})->.a;'
        f'(node["{key}"](area.a);way["{key}"](area.a);rel["{key}"](area.a););out count;'
    )


def _run(url: str, query: str, timeout: float = 25.0) -> Optional[int]:
    try:
        r = httpx.post(url, data={"data": query}, timeout=timeout)
        if r.status_code != 200 or "elements" not in r.text:
            return None
        data = r.json()
        tags = (data.get("elements") or [{}])[0].get("tags", {})
        return int(tags.get("nodes", 0)) + int(tags.get("ways", 0)) + int(tags.get("relations", 0))
    except Exception:
        return None


def validate_coverage(city_osm_type: str, city_osm_id: int, bbox: dict[str, float],
                      keys: tuple[str, ...] | None = None) -> Optional[dict[str, Any]]:
    """Return per-key POI counts from OSM, or None if unavailable."""
    if not city_osm_id:
        return None
    keys = keys or config.OSM_VALIDATION_KEYS
    ckey = f"osm:validation:{city_osm_type}:{city_osm_id}"
    cached = cache.get(ckey)
    if cached is not None:
        return cached or None

    area_id = 3600000000 + city_osm_id if city_osm_type == "relation" else city_osm_id
    probe = '[out:json][timeout:8];node["place"="city"](0,0,0,0);out count;'

    # 1. find a working endpoint with a fast probe
    endpoint = None
    for url in config.OVERPASS_URLS:
        if _run(url, probe, timeout=8.0) is not None:
            endpoint = url
            break
    if endpoint is None:
        cache.set(ckey, None, config.get_ttl("osm_validation"))
        return None

    # 2. run key counts on that endpoint within a global deadline
    results: dict[str, int] = {}
    errors: list[str] = []
    deadline = time.time() + 75.0
    for key in keys:
        if time.time() > deadline:
            errors.append(f"{key}: skipped (deadline)")
            break
        total = _run(endpoint, _count_query(area_id, key), timeout=min(20.0, deadline - time.time() + 1))
        if total is None:
            errors.append(f"{key}: failed")
            continue
        results[key] = total

    if not results:
        cache.set(ckey, None, config.get_ttl("osm_validation"))
        return None

    out = {"counts": results, "errors": errors[:6], "endpoint": endpoint.split("//")[1].split("/")[0],
           "checked_at": _now()}
    cache.set(ckey, out, config.get_ttl("osm_validation"))
    return out


def top_level_agreement(osm_validation: Optional[dict[str, Any]], overture_total: int) -> Optional[float]:
    """Approximate 0..1 agreement between OSM top-level counts and Overture totals."""
    if not osm_validation or not osm_validation.get("counts") or not overture_total:
        return None
    osm_total = sum(osm_validation["counts"].values())
    if osm_total <= 0:
        return None
    return round(min(overture_total, osm_total) / max(overture_total, osm_total), 3)
