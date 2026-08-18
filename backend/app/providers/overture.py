"""Overture Maps Places provider.

Reads Overture's cloud-hosted GeoParquet via DuckDB (httpfs + spatial).
A city's bounding box is used to prune remote row groups; final containment
against the real administrative boundary is done with Shapely.
"""
from __future__ import annotations

import json
import time
from typing import Any, Callable, Optional

import duckdb
import httpx
from shapely.geometry import shape
from shapely.prepared import prep

from .. import config
from ..cache import cache

ProgressFn = Callable[[str, float, str], None]

FALLBACK_RELEASE = "2026-07-22.0"  # must still exist in S3 (old releases are garbage-collected)

# Overture's STAC catalog URL has changed over time; try the known ones.
STAC_URLS = [
    config.OVERTURE_STAC_URL,
    "https://overturemaps.org/stac/catalog.json",
    "https://labs.overturemaps.org/stac/catalog.json",
]

_S3_LIST = "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix={prefix}&delimiter=/"


def _stac_latest() -> Optional[str]:
    """Latest release advertised by Overture's STAC catalog(s)."""
    for url in STAC_URLS:
        try:
            r = httpx.get(url, timeout=20)
            if r.status_code != 200:
                continue
            latest = r.json().get("latest")
            if latest and re_full_release(latest):
                return latest
        except Exception:
            continue
    return None


def _s3_releases() -> list[str]:
    """Release directories visible in Overture's S3 bucket (newest first).

    The bucket keeps only recent releases; listing it is the most reliable way
    to find one whose files actually exist.
    """
    try:
        r = httpx.get(_S3_LIST.format(prefix="release/"), timeout=20)
        if r.status_code != 200:
            return []
        import re
        return sorted(
            set(re.findall(r"release/([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)/", r.text)),
            reverse=True,
        )
    except Exception:
        return []


def _release_has_places(release: str) -> bool:
    """Does the release actually contain places parquet files?"""
    try:
        prefix = f"release/{release}/theme=places/type=place/"
        r = httpx.get(_S3_LIST.format(prefix=prefix), timeout=20)
        return r.status_code == 200 and "<Key>" in r.text
    except Exception:
        return False


def latest_release() -> str:
    """Resolve the newest Overture release whose places files exist.

    Priority: cached value -> STAC catalog -> S3 listing -> fallback. Every
    candidate is sanity-checked against S3 so a release whose files have been
    garbage-collected is never used (that was the Minsk failure: a stale
    "2025-05-20.0" fallback whose S3 objects no longer exist).
    """
    cached = cache.get("overture:release")
    if cached and _release_has_places(cached):
        return cached

    candidates: list[str] = []
    stac = _stac_latest()
    if stac:
        candidates.append(stac)
    candidates.extend(_s3_releases())
    if FALLBACK_RELEASE not in candidates:
        candidates.append(FALLBACK_RELEASE)

    release = FALLBACK_RELEASE
    for cand in candidates:
        if _release_has_places(cand):
            release = cand
            break
    cache.set("overture:release", release, config.get_ttl("stac_release"))
    return release


def re_full_release(v: str) -> bool:
    parts = v.split(".")
    return len(parts) >= 2 and len(parts[0]) == 10


def _new_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("SET allow_asterisks_in_http_paths = true;")
    con.execute("SET s3_region = 'us-west-2';")
    con.execute("SET enable_progress_bar = false;")
    return con


class OvertureProvider:
    """Fetches and filters Overture places for one city."""

    def __init__(self, release: str | None = None):
        self.release = release or latest_release()
        self._base = (
            f"s3://{config.OVERTURE_S3_BUCKET}/release/{self.release}/theme=places/type=place/*"
        )

    def fetch_places(
        self,
        bbox: dict[str, float],
        boundary_geojson: Optional[dict[str, Any]] = None,
        progress: ProgressFn | None = None,
        min_confidence: float = 0.1,
    ) -> tuple[list[dict], dict[str, int], dict[str, Any]]:
        """Returns (places, filter_stats, source_quality)."""
        t0 = time.time()
        xmin, xmax = bbox["min_lon"], bbox["max_lon"]
        ymin, ymax = bbox["min_lat"], bbox["max_lat"]

        # Expand slightly so boundary filtering is not starved at the edges
        dx = (xmax - xmin) * 0.02 + 0.005
        dy = (ymax - ymin) * 0.02 + 0.005
        qxmin, qxmax = xmin - dx, xmax + dx
        qymin, qymax = ymin - dy, ymax + dy

        if progress:
            progress("loading", 0.15, f"Querying Overture {self.release} places (bbox filter)…")

        con = _new_con()
        try:
            where = (
                f"bbox.xmin < {qxmax} AND bbox.xmax > {qxmin} "
                f"AND bbox.ymin < {qymax} AND bbox.ymax > {qymin} "
                f"AND COALESCE(operating_status, '') != 'permanently_closed'"
            )
            n_bbox = con.execute(
                f"SELECT count(*) FROM read_parquet('{self._base}', filename=true, hive_partitioning=1) "
                f"WHERE bbox.xmin < {qxmax} AND bbox.xmax > {qxmin} AND bbox.ymin < {qymax} AND bbox.ymax > {qymin}"
            ).fetchone()[0]
            n_closed = con.execute(
                f"SELECT count(*) FROM read_parquet('{self._base}', filename=true, hive_partitioning=1) "
                f"WHERE bbox.xmin < {qxmax} AND bbox.xmax > {qxmin} AND bbox.ymin < {qymax} AND bbox.ymax > {qymin} "
                f"AND operating_status = 'permanently_closed'"
            ).fetchone()[0]

            sql = f"""
SELECT
  id,
  names.primary AS name,
  basic_category,
  taxonomy.primary AS primary_category,
  taxonomy.hierarchy AS taxonomy_hierarchy,
  taxonomy.alternates AS taxonomy_alternates,
  categories.alternate AS legacy_alternates,
  confidence,
  operating_status,
  websites,
  phones,
  emails,
  socials,
  addresses,
  brand.names.primary AS brand_name,
  sources,
  ST_X(ST_PointOnSurface(geometry)) AS lon,
  ST_Y(ST_PointOnSurface(geometry)) AS lat
FROM read_parquet('{self._base}', filename=true, hive_partitioning=1)
WHERE {where}
"""
            cur = con.execute(sql)
            colnames = [d[0] for d in cur.description]
            rows = cur.fetchall()
        finally:
            con.close()

        if progress:
            progress("loading", 0.55, f"Loaded {len(rows):,} candidate places in bbox…")

        boundary_geom = None
        prepared = None
        if boundary_geojson and boundary_geojson.get("type") in ("Polygon", "MultiPolygon"):
            try:
                boundary_geom = shape(boundary_geojson)
                if boundary_geom.is_valid:
                    prepared = prep(boundary_geom)
            except Exception:
                prepared = None

        stats = {
            "in_bbox": n_bbox,
            "closed_in_bbox": n_closed,
            "in_boundary": 0,
            "removed_closed": n_closed,
            "removed_no_geometry": 0,
            "removed_low_confidence": 0,
            "removed_outside": 0,
            "removed_duplicates": 0,
            "kept": 0,
        }

        places: list[dict] = []
        seen: set[tuple] = set()

        # Sort by confidence desc so dedupe keeps the best record
        sorted_rows = sorted(rows, key=lambda r: -(r[colnames.index("confidence")] or 0.0))

        name_i = colnames.index("name")
        cat_i = colnames.index("primary_category")
        hier_i = colnames.index("taxonomy_hierarchy")
        alt_i = colnames.index("taxonomy_alternates")
        leg_i = colnames.index("legacy_alternates")
        conf_i = colnames.index("confidence")
        lon_i = colnames.index("lon")
        lat_i = colnames.index("lat")

        for row in sorted_rows:
            lon = row[lon_i]
            lat = row[lat_i]
            if lon is None or lat is None:
                stats["removed_no_geometry"] += 1
                continue
            confidence = row[conf_i] or 0.0
            if confidence < min_confidence:
                stats["removed_low_confidence"] += 1
                continue
            if prepared is not None:
                if not prepared.contains(_point(lat, lon)):
                    stats["removed_outside"] += 1
                    continue
            stats["in_boundary"] += 1

            name = row[name_i]
            primary = row[cat_i]
            hierarchy = [h for h in (row[hier_i] or []) if h]
            alternates = [a for a in (row[alt_i] or []) or (row[leg_i] or []) if a]

            # dedupe: same name + category + ~100m position
            key = (
                (primary or ""),
                ((name or "").strip().lower())[:80],
                round(lat, 3),
                round(lon, 3),
            )
            if key in seen:
                stats["removed_duplicates"] += 1
                continue
            seen.add(key)

            addr = _first_address(row[colnames.index("addresses")])
            sources = _source_datasets(row[colnames.index("sources")])
            websites = _clean_list(row[colnames.index("websites")])
            phones = _clean_list(row[colnames.index("phones")])
            emails = _clean_list(row[colnames.index("emails")])
            socials = _clean_list(row[colnames.index("socials")])

            matched = set()
            if primary:
                matched.add(primary)
            matched.update(hierarchy)
            matched.update(alternates)
            matched.discard("")

            # Connected categories: a place tagged shared_office_space also
            # counts as coworking_space (see CATEGORY_EQUIVALENTS).
            from ..taxonomy import (CATEGORY_EQUIVALENTS, NAME_SIGNALS,
                                    leaf_category, name_matches_category)
            for cat in set(matched):
                for equiv in CATEGORY_EQUIVALENTS.get(cat, set()):
                    matched.add(equiv)
            # Name-signal supplement: Overture's taxonomy is coarse for some
            # well-defined business types. A place named "Коворкинг ..." tagged
            # with a generic office category is still a coworking space.
            for cat in NAME_SIGNALS:
                if cat not in matched and name_matches_category(cat, name):
                    matched.add(cat)

            places.append({
                "id": row[colnames.index("id")],
                "name": name,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "primary_category": primary,
                "taxonomy_hierarchy": hierarchy,
                "alternate_categories": sorted(alternates),
                "leaf_category": leaf_category(primary, hierarchy),
                "matched_categories": sorted(matched),
                "confidence": round(confidence, 4),
                "operating_status": row[colnames.index("operating_status")],
                "address": addr.get("freeform"),
                "locality": addr.get("locality"),
                "postcode": addr.get("postcode"),
                "region": addr.get("region"),
                "country": addr.get("country"),
                "websites": websites,
                "phones": phones,
                "emails": emails,
                "socials": socials,
                "brand": row[colnames.index("brand_name")],
                "sources": sources,
            })

        stats["kept"] = len(places)

        quality = {
            "avg_confidence": round(sum(p["confidence"] for p in places) / len(places), 4) if places else 0,
            "pct_with_name": round(100 * sum(1 for p in places if p["name"]) / len(places), 1) if places else 0,
            "pct_with_category": round(100 * sum(1 for p in places if p["primary_category"]) / len(places), 1) if places else 0,
            "pct_with_address": round(100 * sum(1 for p in places if p["address"]) / len(places), 1) if places else 0,
            "pct_with_website": round(100 * sum(1 for p in places if p["websites"]) / len(places), 1) if places else 0,
            "datasets_used": sorted({d for p in places for d in p["sources"]}),
            "fetch_seconds": round(time.time() - t0, 1),
        }
        if progress:
            progress("loading", 0.9, f"Kept {len(places):,} places inside the city boundary…")
        return places, stats, quality


def _point(lat: float, lon: float):
    from shapely.geometry import Point
    return Point(lon, lat)


def _first_address(addresses: Any) -> dict:
    if not addresses:
        return {}
    for a in addresses:
        if isinstance(a, dict):
            if a.get("freeform") or a.get("locality"):
                return {
                    "freeform": a.get("freeform") or "",
                    "locality": a.get("locality"),
                    "postcode": a.get("postcode"),
                    "region": a.get("region"),
                    "country": a.get("country"),
                }
    return {}


def _clean_list(values: Any) -> list[str]:
    if not values:
        return []
    out = []
    for v in values:
        if isinstance(v, str) and v.strip() and v not in out:
            out.append(v.strip())
    return out


def _source_datasets(sources: Any) -> list[str]:
    if not sources:
        return []
    out = []
    for s in sources:
        if isinstance(s, dict):
            ds = s.get("dataset")
            if ds and ds not in out:
                out.append(ds)
    return out


def density_grid(places: list[dict], max_cells: int = 5000) -> list[dict]:
    """Aggregate place counts into a coarse grid for the density layer."""
    cell = 0.01  # degrees (~1 km)
    counts: dict[tuple[int, int], int] = {}
    for p in places:
        key = (int(p["lat"] / cell), int(p["lon"] / cell))
        counts[key] = counts.get(key, 0) + 1
    while len(counts) > max_cells:
        cell *= 2
        merged: dict[tuple[int, int], int] = {}
        for (cy, cx), n in counts.items():
            k = (int(cy / 2), int(cx / 2))
            merged[k] = merged.get(k, 0) + n
        counts = merged
    out = [
        {"lat": round((cy + 0.5) * cell, 4), "lon": round((cx + 0.5) * cell, 4), "count": n}
        for (cy, cx), n in counts.items()
    ]
    out.sort(key=lambda c: -c["count"])
    return out
