"""City resolution.

Primary: Wikidata (search + coordinates + population + OSM relation id).
Boundary enhancement: Nominatim polygon when reachable; otherwise a
population-scaled bounding box (confidence penalty applied downstream).
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any, Optional

import httpx

from .. import config
from ..cache import cache
from ..models import CityMeta
from . import population as population_provider

_SLUG_RE = re.compile(r"[^\w\u0080-\uffff]+", re.UNICODE)
_nominatim_lock = threading.Lock()
_last_request: dict[str, float] = {}
_nominatim_blocked_until: dict[str, float] = {}


def slugify(s: str) -> str:
    slug = _SLUG_RE.sub("-", s.strip().lower()).strip("-")
    return slug or "city"


def _throttle() -> None:
    with _nominatim_lock:
        last = _last_request.get("nominatim", 0.0)
        wait = config.NOMINATIM_MIN_INTERVAL - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        _last_request["nominatim"] = time.time()


def nominatim_available() -> bool:
    """True if Nominatim is not in a cool-off window."""
    return time.time() >= _nominatim_blocked_until.get("nominatim", 0.0)


def nominatim_get(params: dict[str, Any], timeout: float = 30.0, retries: int = 1) -> list[dict]:
    if not nominatim_available():
        raise RuntimeError("Nominatim in cool-off after rate limiting")
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        _throttle()
        try:
            r = httpx.get(
                f"{config.NOMINATIM_URL}/search",
                params=params,
                headers={"User-Agent": config.USER_AGENT},
                timeout=timeout,
            )
            if r.status_code == 200:
                return r.json()
            if r.status_code in (403, 429):
                _nominatim_blocked_until["nominatim"] = time.time() + 300
                last_err = RuntimeError(f"Nominatim rate-limited (HTTP {r.status_code})")
            else:
                r.raise_for_status()
        except (httpx.HTTPStatusError, httpx.HTTPError) as e:
            last_err = e
        if attempt < retries:
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"Nominatim request failed: {last_err}") from last_err


def _simplify_geojson(geojson: dict[str, Any], max_points: int = 25_000) -> dict[str, Any]:
    try:
        from shapely.geometry import mapping, shape

        geom = shape(geojson)
        if geom is None or geom.is_empty:
            return geojson
        if geom.geom_type in ("Polygon", "MultiPolygon") and geom.wkt.count(",") > max_points:
            tol = 0.0025
            simplified = geom.simplify(tol, preserve_topology=True)
            while simplified.wkt.count(",") > max_points and tol < 0.05:
                tol *= 2
                simplified = geom.simplify(tol, preserve_topology=True)
            return mapping(simplified)
        return geojson
    except Exception:
        return geojson


class CityResolutionError(Exception):
    pass


class CityResolver:
    """Resolves a (country, city) pair. Wikidata-first, Nominatim for boundaries."""

    def resolve(self, country: str, city: str) -> CityMeta:
        ckey = slugify(country) or "country"
        city_slug = slugify(city)
        if not city_slug:
            raise CityResolutionError("City name is empty")
        cache_key = f"city_metadata:{ckey}:{city_slug}"
        cached = cache.get(cache_key)
        if cached:
            try:
                meta = CityMeta(**cached)
                ttl = config.get_ttl("city_metadata") if meta.boundary_type == "polygon" else 86400
                cache.touch(cache_key, ttl)
                return meta
            except Exception:
                pass

        country_code = _country_code(country)
        candidates = population_provider.wikidata_search(city, country_code)
        if not candidates:
            raise CityResolutionError(
                f"Could not find '{city}' in '{country}'. Check the spelling or try a different country."
            )
        best = _pick_wikidata(candidates, city, country_code)
        if best is None:
            raise CityResolutionError(
                f"Found Wikidata candidates for '{city}' but none clearly matched '{country}'."
            )

        meta = meta_from_wikidata(best)
        _enhance_boundary(meta, country_code)

        ttl = config.get_ttl("city_metadata") if meta.boundary_type == "polygon" else 86400
        cache.set(cache_key, meta.model_dump(), ttl)
        cache.set(f"city:{meta.city_id}", meta.model_dump(), ttl)
        return meta

    def resolve_by_name(self, name: str, country_code: str | None = None) -> CityMeta | None:
        """Resolve a city by name + country code (used for peers)."""
        slug = slugify(name)
        if not slug:
            return None
        ckey = slugify(country_code or "x")
        cache_key = f"city_metadata:peer:{ckey}:{slug}"
        cached = cache.get(cache_key)
        if cached:
            try:
                meta = CityMeta(**cached)
                ttl = config.get_ttl("city_metadata") if meta.boundary_type == "polygon" else 86400
                cache.touch(cache_key, ttl)
                return meta
            except Exception:
                pass
        candidates = population_provider.wikidata_search(name, country_code)
        if not candidates:
            return None
        best = _pick_wikidata(candidates, name, country_code)
        if best is None:
            best = candidates[0]
        meta = meta_from_wikidata(best)
        _enhance_boundary(meta, country_code)
        ttl = config.get_ttl("city_metadata") if meta.boundary_type == "polygon" else 86400
        cache.set(cache_key, meta.model_dump(), ttl)
        cache.set(f"city:{meta.city_id}", meta.model_dump(), ttl)
        return meta


def _pick_wikidata(candidates: list[dict], city: str, country_code: str | None) -> Optional[dict]:
    city_norm = slugify(city)

    def score(c: dict) -> float:
        s = 0.0
        if country_code and c.get("cc"):
            if c["cc"].lower() == country_code.lower():
                s += 100
            else:
                s -= 300
        elif not country_code:
            s += 40
        if c.get("is_city"):
            s += 60
        label_norm = slugify(c.get("label", ""))
        if label_norm == city_norm:
            s += 80
        elif city_norm in label_norm or label_norm in city_norm:
            s += 30
        s += min(40.0, (c.get("pop") or 0) / 1_000_000)
        return s

    scored = sorted(candidates, key=score, reverse=True)
    if scored and scored[0].get("cc") and country_code and scored[0]["cc"].lower() == country_code.lower():
        return scored[0]
    if scored and not country_code:
        return scored[0]
    # country filter did not match any candidate cleanly
    for c in scored:
        if c.get("cc") is None:
            return c
    return None


def meta_from_wikidata(c: dict, enrich: bool = True) -> CityMeta:
    """Build a CityMeta from a Wikidata candidate dict.

    ``enrich=False`` skips per-item population SPARQL lookups (used for peers,
    whose population is already known from the batch correction).
    """
    lat = c.get("lat")
    lon = c.get("lon")
    cc = (c.get("cc") or "").lower()
    country_name = c.get("country_name") or (population_provider.country_name_for_code(cc) if cc else "") or "Unknown"
    name = c.get("label") or c.get("qid") or "City"
    city_id = f"{slugify(name)}-{cc}" if cc else slugify(name)

    if lat is None or lon is None:
        raise CityResolutionError(f"Wikidata has no coordinates for '{name}'.")

    half = _bbox_half(c.get("pop") or 500_000)
    bbox = {
        "min_lat": lat - half, "max_lat": lat + half,
        "min_lon": lon - half, "max_lon": lon + half,
    }
    boundary = _bbox_geojson(bbox)
    meta = CityMeta(
        city_id=city_id,
        name=name,
        display_name=f"{name}, {country_name}",
        country=country_name,
        country_code=cc,
        country_qid=population_provider.country_qid(cc) if cc else None,
        wikidata_qid=c.get("qid"),
        osm_type="relation",
        osm_id=c.get("osm_id"),
        center={"lat": lat, "lon": lon},
        bbox=bbox,
        boundary=boundary,
        boundary_type="bbox",
        source="wikidata",
    )
    if enrich:
        # population enrichment (with year, via statements)
        pop, year, source, note = population_provider.enrich_population(meta)
        meta.population = pop or c.get("pop")
        meta.population_year = year
        meta.population_source = source or "Wikidata (P1082)"
        meta.population_note = note
        if meta.population and not year:
            meta.population_note = "Population figure has no stated reference date."
    else:
        meta.population = c.get("pop")
        meta.population_source = "Wikidata (P1082, batch estimate)"
    return meta


def _bbox_half(pop: int) -> float:
    """Half-width (degrees) of a city-sized box for a given population.

    Roughly sqrt(pop / (pi * 4000 people/km2)) converted to degrees, with
    generous floors so small towns still capture their centre.
    """
    if pop <= 0:
        return 0.08
    return max(0.07, min(0.5, 0.10 * (pop / 1_000_000) ** 0.33))


def _bbox_geojson(bbox: dict[str, float]) -> dict[str, Any]:
    return {
        "type": "Polygon",
        "coordinates": [[
            [bbox["min_lon"], bbox["min_lat"]],
            [bbox["max_lon"], bbox["min_lat"]],
            [bbox["max_lon"], bbox["max_lat"]],
            [bbox["min_lon"], bbox["max_lat"]],
            [bbox["min_lon"], bbox["min_lat"]],
        ]],
    }


def _enhance_boundary(meta: CityMeta, country_code: str | None) -> None:
    """Best-effort real boundary from Nominatim; keep bbox fallback otherwise."""
    if not nominatim_available():
        return
    try:
        params = {
            "q": f"{meta.name}, {meta.country}",
            "format": "jsonv2",
            "addressdetails": 1,
            "namedetails": 1,
            "limit": 4,
            "polygon_geojson": 1,
            "dedupe": 1,
        }
        if country_code:
            params["countrycodes"] = country_code.lower()
        results = nominatim_get(params, timeout=20.0, retries=0)
        best = None
        for r in results:
            rtype = r.get("type", "")
            if rtype in ("country", "state", "province", "region", "county"):
                continue
            gj = r.get("geojson")
            if gj and gj.get("type") in ("Polygon", "MultiPolygon"):
                best = r
                break
        if best is None and results:
            # accept bbox from nominatim even without polygon
            bb = results[0].get("boundingbox") or []
            if len(bb) == 4:
                meta.bbox = {
                    "min_lat": float(bb[0]), "max_lat": float(bb[1]),
                    "min_lon": float(bb[2]), "max_lon": float(bb[3]),
                }
            return
        if best is not None:
            gj = best.get("geojson")
            meta.boundary = _simplify_geojson(gj)
            meta.boundary_type = "polygon"
            bb = best.get("boundingbox") or []
            if len(bb) == 4:
                meta.bbox = {
                    "min_lat": float(bb[0]), "max_lat": float(bb[1]),
                    "min_lon": float(bb[2]), "max_lon": float(bb[3]),
                }
            name = (best.get("namedetails") or {}).get("name:en") or (best.get("address") or {}).get("city") or meta.name
            if name and name != meta.name:
                meta.name = name
                meta.city_id = f"{slugify(name)}-{meta.country_code}"
                meta.display_name = f"{name}, {meta.country}"
    except Exception:
        # boundary stays as bbox
        pass


def _country_code(country: str) -> str | None:
    if not country:
        return None
    from ..countries import name_to_country_code

    cc = name_to_country_code(country)
    if cc:
        return cc
    c = country.strip().upper()
    if len(c) == 2 and c.isalpha():
        return c
    return None
