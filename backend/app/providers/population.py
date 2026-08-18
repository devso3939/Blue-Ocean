"""Population and metadata from Wikidata SPARQL (population figures, country
QIDs, candidate peer cities with population and coordinates)."""
from __future__ import annotations

import re
import time
from typing import Any, Optional

import httpx

from .. import config
from ..cache import cache
from ..models import CityMeta

_UA = {"User-Agent": config.USER_AGENT, "Accept": "application/sparql-results+json"}
_POINT_RE = re.compile(r"Point\(([-\d.]+) ([-\d.]+)\)")


def _sparql(query: str, timeout: float = 90.0, retries: int = 2) -> Optional[list[dict]]:
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            r = httpx.get(
                config.WIKIDATA_SPARQL_URL,
                params={"query": query, "maxlag": "5"},
                headers=_UA,
                timeout=timeout,
            )
            if r.status_code == 200:
                return r.json().get("results", {}).get("bindings", [])
            if r.status_code in (403, 429):
                # robot policy / rate limited — back off and retry
                last_err = RuntimeError(f"Wikidata rate-limited (HTTP {r.status_code})")
            else:
                last_err = RuntimeError(f"Wikidata status {r.status_code}")
        except Exception as e:  # noqa: BLE001
            last_err = e
        if attempt < retries:
            time.sleep(3.0 * (attempt + 1))
    return None


def _val(binding: dict, key: str) -> Optional[str]:
    v = binding.get(key)
    return v.get("value") if v else None


def country_qid(cca2: str) -> Optional[str]:
    if not cca2:
        return None
    ckey = f"wikidata:country_qid:{cca2.lower()}"
    cached = cache.get(ckey)
    if cached:
        return cached
    binds = _sparql(f'SELECT ?item WHERE {{ ?item wdt:P297 "{cca2.upper()}". }}', timeout=30)
    qid = None
    if binds:
        qid = (_val(binds[0], "item") or "").rsplit("/", 1)[-1]
    if qid:
        cache.set(ckey, qid, config.get_ttl("population"))
    return qid


def _population_by_osm(osm_id: int | None) -> Optional[dict]:
    if not osm_id:
        return None
    ckey = f"wikidata:pop_osm:{osm_id}"
    cached = cache.get(ckey)
    if cached:
        return cached
    q = f"""
SELECT ?item ?pop ?date ?method WHERE {{
  ?item wdt:P402 "{osm_id}".
  ?item p:P1082 ?st.
  ?st ps:P1082 ?pop.
  OPTIONAL {{ ?st pq:P585 ?date. }}
  OPTIONAL {{ ?st pq:P459 ?method. }}
}} ORDER BY DESC(?date) LIMIT 5"""
    binds = _sparql(q, timeout=60)
    result = None
    if binds:
        best_date = None
        for b in binds:
            date = _val(b, "date") or ""
            if best_date is None or date > best_date:
                best_date = date
                result = {
                    "pop": int(float(_val(b, "pop") or 0)),
                    "date": date[:10] if date else None,
                    "method": (_val(b, "method") or "").rsplit("/", 1)[-1],
                }
    if result and result["pop"] > 0:
        cache.set(ckey, result, config.get_ttl("population"))
    return result


def _population_by_label(city_name: str, country_qid: Optional[str]) -> Optional[dict]:
    if not city_name or not country_qid:
        return None
    ckey = f"wikidata:pop_label:{country_qid}:{city_name.strip().lower()[:40]}"
    cached = cache.get(ckey)
    if cached:
        return cached
    name_lc = city_name.strip().lower()
    q = f"""
SELECT ?item ?pop ?date WHERE {{
  ?item wdt:P17 wd:{country_qid}.
  ?item wdt:P1082 ?pop.
  ?item rdfs:label ?l.
  FILTER(LCASE(?l) = "{name_lc}" || CONTAINS(LCASE(?l), "{name_lc}"))
  OPTIONAL {{ ?item p:P1082 ?st. ?st ps:P1082 ?pop; pq:P585 ?date. }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} ORDER BY DESC(?pop) LIMIT 3"""
    binds = _sparql(q, timeout=60)
    result = None
    if binds:
        b = binds[0]
        result = {
            "pop": int(float(_val(b, "pop") or 0)),
            "date": (_val(b, "date") or "")[:10] or None,
            "method": "label match",
        }
    if result and result["pop"] > 0:
        cache.set(ckey, result, config.get_ttl("population"))
    return result


def enrich_population(meta: CityMeta) -> tuple[Optional[int], Optional[int], Optional[str], Optional[str]]:
    """Return (population, year, source, note) for a resolved city."""
    if meta.population:
        return meta.population, meta.population_year, meta.population_source, None
    info = None
    source = None
    if meta.osm_id:
        info = _population_by_osm(meta.osm_id)
        if info:
            source = "Wikidata (P1082, via OSM relation)"
    if info is None:
        info = _population_by_label(meta.name, meta.country_qid)
        if info:
            source = "Wikidata (P1082, by name match)"
    if not info or not info.get("pop"):
        return None, None, None, "Population not found on Wikidata for this city."
    pop = info["pop"]
    date = info.get("date")
    year = int(date[:4]) if date and len(date) >= 4 else None
    note = None
    if year:
        age = 2026 - year  # approximate current year reference
        if age > 5:
            note = f"Population figure is from {year} and may be outdated."
    elif info.get("method"):
        note = "Population figure has no stated reference date."
    return pop, year, source, note


# ---------------------------------------------------------------------------
# City search (Wikidata)
# ---------------------------------------------------------------------------

WIKIDATA_API = "https://www.wikidata.org/w/api.php"


def wikidata_search(query: str, country_code: str | None = None, limit: int = 8) -> list[dict]:
    """Search cities on Wikidata, enrich with country/coords/population/osm id.

    Returns candidates sorted by search relevance, each with qid, label,
    description, cc, lat, lon, pop, osm_id, is_city.
    """
    qkey = query.strip().lower()[:60]
    ckey = f"wikidata:search:{qkey}:{country_code or ''}"
    cached = cache.get(ckey)
    if cached is not None:
        return cached
    try:
        r = httpx.get(
            WIKIDATA_API,
            params={
                "action": "wbsearchentities", "search": query, "language": "en",
                "uselang": "en", "type": "item", "format": "json", "limit": limit,
            },
            headers=_UA,
            timeout=30,
        )
        r.raise_for_status()
        search = r.json().get("search", [])
    except Exception:
        cache.set(ckey, [], 3600)
        return []
    if not search:
        cache.set(ckey, [], 3600)
        return []

    qids = [s["id"] for s in search if s.get("id")]
    enrich = _enrich_items(qids)
    out = []
    for s in search:
        qid = s.get("id")
        if not qid:
            continue
        e = enrich.get(qid, {})
        out.append({
            "qid": qid,
            "label": s.get("label") or "",
            "description": s.get("description") or "",
            "cc": e.get("cc"),
            "lat": e.get("lat"),
            "lon": e.get("lon"),
            "pop": e.get("pop"),
            "osm_id": e.get("osm_id"),
            "is_city": bool(e.get("is_city")),
        })
    cache.set(ckey, out, config.get_ttl("city_metadata"))
    return out


def _enrich_items(qids: list[str]) -> dict[str, dict]:
    """Batch lookup of country, coords, population, osm id for Wikidata items."""
    values = " ".join(f"wd:{q}" for q in qids)
    q = f"""
SELECT ?item ?cc ?coord ?pop ?osm ?isCity WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P17/wdt:P297 ?cc. }}
  OPTIONAL {{ ?item wdt:P625 ?coord. }}
  OPTIONAL {{ ?item wdt:P1082 ?pop. }}
  OPTIONAL {{ ?item wdt:P402 ?osm. }}
  BIND(IF(EXISTS {{ ?item wdt:P31/wdt:P279* wd:Q515 }}
       || EXISTS {{ ?item wdt:P31 wd:Q486972 }}, true, false) AS ?isCity)
}} LIMIT 50"""
    binds = _sparql(q, timeout=60)
    out: dict[str, dict] = {}
    for b in binds or []:
        qid = (_val(b, "item") or "").rsplit("/", 1)[-1]
        coord = _parse_coord(_val(b, "coord"))
        out[qid] = {
            "cc": _val(b, "cc"),
            "lat": coord[0] if coord else None,
            "lon": coord[1] if coord else None,
            "pop": int(float(_val(b, "pop") or 0)) if _val(b, "pop") else None,
            "osm_id": int(_val(b, "osm")) if _val(b, "osm") else None,
            "is_city": (_val(b, "isCity") or "") == "true",
        }
    return out


def english_labels(qids: list[str]) -> dict[str, str]:
    """English labels for a batch of Wikidata items (cached)."""
    ids = [q for q in qids if q]
    if not ids:
        return {}
    key = "wikidata:labels:" + ",".join(sorted(ids))
    cached = cache.get(key)
    if cached:
        return cached
    values = " ".join(f"wd:{q}" for q in ids)
    q = f"""
SELECT ?item ?itemLabel WHERE {{
  VALUES ?item {{ {values} }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} LIMIT 100"""
    binds = _sparql(q, timeout=60)
    out: dict[str, str] = {}
    for b in binds or []:
        qid = (_val(b, "item") or "").rsplit("/", 1)[-1]
        label = _val(b, "itemLabel")
        if qid and label:
            out[qid] = label
    if out:
        cache.set(key, out, config.get_ttl("population"))
    return out


def country_name_for_code(cca2: str) -> Optional[str]:
    from ..countries import country_code_to_name
    return country_code_to_name(cca2)


# ---------------------------------------------------------------------------
# Peer city candidates
# ---------------------------------------------------------------------------

def peer_candidates(country_qid: str, target_pop: int, min_pop: int, max_pop: int,
                    limit: int = 400) -> list[dict]:
    ckey = f"wikidata:peers:{country_qid}:{min_pop}:{max_pop}"
    cached = cache.get(ckey)
    if cached:
        return cached
    q = f"""
SELECT DISTINCT ?city ?cityLabel ?pop ?coord WHERE {{
  {{ ?city wdt:P31/wdt:P279* wd:Q515 . }} UNION {{ ?city wdt:P31/wdt:P279* wd:Q486972 . }}
  ?city wdt:P17 wd:{country_qid}.
  ?city wdt:P1082 ?pop.
  OPTIONAL {{ ?city wdt:P625 ?coord. }}
  FILTER(?pop >= {min_pop} && ?pop <= {max_pop})
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} LIMIT {limit}"""
    binds = _sparql(q, timeout=120) or []
    out = []
    seen: set[str] = set()
    for b in binds:
        qid = (_val(b, "city") or "").rsplit("/", 1)[-1]
        label = _val(b, "cityLabel") or ""
        if not qid or not label or qid in seen:
            continue
        seen.add(qid)
        coord = _parse_coord(_val(b, "coord"))
        out.append({
            "qid": qid,
            "label": label,
            "pop": int(float(_val(b, "pop") or 0)),
            "lat": coord[0] if coord else None,
            "lon": coord[1] if coord else None,
        })
    cache.set(ckey, out, config.get_ttl("country_peers"))
    return out


def international_candidates(target_pop: int, min_pop: int, max_pop: int,
                             exclude_country_qid: Optional[str] = None,
                             limit: int = 200) -> list[dict]:
    ckey = f"wikidata:peers:intl:{min_pop}:{max_pop}:{target_pop}:{exclude_country_qid or ''}"
    cached = cache.get(ckey)
    if cached:
        return cached
    excl = f"FILTER NOT EXISTS {{ ?city wdt:P17 wd:{exclude_country_qid}. }}" if exclude_country_qid else ""
    q = f"""
SELECT DISTINCT ?city ?cityLabel ?pop ?coord WHERE {{
  {{ ?city wdt:P31/wdt:P279* wd:Q515 . }} UNION {{ ?city wdt:P31/wdt:P279* wd:Q486972 . }}
  ?city wdt:P1082 ?pop.
  OPTIONAL {{ ?city wdt:P625 ?coord. }}
  FILTER(?pop >= {min_pop} && ?pop <= {max_pop})
  {excl}
  BIND(ABS(?pop - {target_pop}) AS ?diff)
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} ORDER BY ?diff LIMIT {limit}"""
    binds = _sparql(q, timeout=120) or []
    out = []
    seen: set[str] = set()
    for b in binds:
        qid = (_val(b, "city") or "").rsplit("/", 1)[-1]
        label = _val(b, "cityLabel") or ""
        if not qid or not label or qid in seen:
            continue
        seen.add(qid)
        coord = _parse_coord(_val(b, "coord"))
        out.append({
            "qid": qid,
            "label": label,
            "pop": int(float(_val(b, "pop") or 0)),
            "lat": coord[0] if coord else None,
            "lon": coord[1] if coord else None,
        })
    cache.set(ckey, out, config.get_ttl("country_peers"))
    return out


def country_code_for_qid(qid: str) -> Optional[str]:
    """ISO 3166-1 alpha-2 country code for a Wikidata item (cached)."""
    ckey = f"wikidata:country:{qid}"
    cached = cache.get(ckey)
    if cached:
        return cached
    q = f"""
SELECT ?cc WHERE {{
  ?item wdt:P17 ?country.
  ?country wdt:P297 ?cc.
  VALUES ?item {{ wd:{qid} }}
}} LIMIT 1"""
    binds = _sparql(q, timeout=45)
    cc = _val(binds[0], "cc") if binds else None
    if cc:
        cache.set(ckey, cc, config.get_ttl("population"))
    return cc


def _parse_coord(value: Optional[str]) -> Optional[tuple[float, float]]:
    if not value:
        return None
    m = _POINT_RE.search(value)
    if m:
        return (float(m.group(2)), float(m.group(1)))  # (lat, lon)
    return None
