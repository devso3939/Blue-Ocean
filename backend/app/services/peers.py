"""Peer city selection.

Methodology (shown to the user on every analysis page):
1. Candidate pool from Overture Divisions (cities of the country / world).
2. Populations cross-checked against Wikidata (divisions population is
   sometimes inherited from the country level).
3. Same-country cities with ~0.5x-2x the target population, ranked by
   population similarity; widened to 0.33x-3x if needed.
4. If fewer than 3 peers: international cities of similar population
   (same region preferred).
"""
from __future__ import annotations

import math
from typing import Any, Callable

from .. import config
from ..cache import cache
from ..models import CityMeta, PeerCity
from ..providers import divisions as divisions_provider
from . import snapshot as snapshot_service

ProgressFn = Callable[[str, float, str], None]


def _closeness(pop: int, target: int) -> float:
    if pop <= 0 or target <= 0:
        return 1e9
    return abs(math.log(pop / target))


def _weight(pop: int, target: int) -> float:
    if pop <= 0 or target <= 0:
        return 0.1
    return 1.0 / (1.0 + _closeness(pop, target))


def _candidate_pool(city: CityMeta) -> list[dict]:
    """Country + international candidate pools from Overture divisions."""
    cc = city.country_code.upper() if city.country_code else None
    target = city.population or 500_000
    pool: list[dict] = []
    seen: set[str] = set()

    def add(cands: list[dict]) -> None:
        for c in cands:
            key = c.get("qid") or f"{c.get('cc')}:{c.get('name')}"
            if key in seen or c.get("qid") == city.wikidata_qid:
                continue
            if not c.get("name") or not c.get("lat"):
                continue
            seen.add(key)
            pool.append(c)

    if cc:
        # broad in-country pool (populations corrected later via Wikidata)
        add(divisions_provider.cities_in_country(cc, 20_000, int(target * 4.5), limit=300))
    # broad international pool
    lo = max(50_000, int(target * 0.2))
    hi = int(target * 4.5)
    add(divisions_provider.cities_near_population(target, lo, hi, exclude_country=cc, limit=120))
    return pool


def _correct_with_wikidata(pool: list[dict], city: CityMeta) -> list[dict]:
    """Replace divisions population/coords with authoritative Wikidata values."""
    from ..providers import population as population_provider

    qids = [c["qid"] for c in pool if c.get("qid")]
    enrich = population_provider._enrich_items(qids) if qids else {}
    out = []
    for c in pool:
        e = enrich.get(c.get("qid"), {})
        pop = e.get("pop") or c.get("pop")
        lat = e.get("lat") or c.get("lat")
        lon = e.get("lon") or c.get("lon")
        if not pop or pop <= 0 or lat is None or lon is None:
            continue
        c["pop"] = int(pop)
        c["lat"] = lat
        c["lon"] = lon
        if e.get("cc"):
            c["cc"] = e["cc"]
        out.append(c)
    return out


def select_peers(city: CityMeta, progress: ProgressFn | None = None) -> tuple[list[PeerCity], dict[str, Any]]:
    """Pick comparison cities for the target city. Cached per city."""
    cache_key = f"peer_set:{city.city_id}"
    cached = cache.get(cache_key)
    if cached:
        return [PeerCity(**p) for p in cached["peers"]], cached["info"]

    target_pop = city.population
    info: dict[str, Any] = {"target_population": target_pop, "stages": []}
    if not target_pop:
        cache.set(cache_key, {"peers": [], "info": info}, config.get_ttl("peer_set"))
        return [], info

    if progress:
        progress("peers", 0.25, "Finding comparable cities…")

    cc = city.country_code.upper() if city.country_code else None
    pool = _correct_with_wikidata(_candidate_pool(city), city)
    regions = _region_map()
    target_region = regions.get(cc or "")

    def region_bonus(c: dict) -> int:
        if target_region and regions.get((c.get("cc") or "").upper()) == target_region:
            return 0
        return 1

    selected: list[dict] = []
    used_qids: set[str] = set()

    def add_candidates(cands: list[dict], stage: str) -> int:
        added = 0
        for c in cands:
            if c.get("qid") in used_qids or c.get("qid") == city.wikidata_qid:
                continue
            selected.append(c)
            if c.get("qid"):
                used_qids.add(c["qid"])
            added += 1
        info["stages"].append(stage)
        return added

    in_country = [c for c in pool if cc and (c.get("cc") or "").upper() == cc]
    others = [c for c in pool if not (cc and (c.get("cc") or "").upper() == cc)]

    # Stage 1: same country, 0.5-2x
    tight = [c for c in in_country if config.PEER_RANGE_TIGHT[0] <= c["pop"] / target_pop <= config.PEER_RANGE_TIGHT[1]]
    tight.sort(key=lambda c: _closeness(c["pop"], target_pop))
    add_candidates(tight, f"same-country {config.PEER_RANGE_TIGHT[0]}x-{config.PEER_RANGE_TIGHT[1]}x")

    # Stage 2: same country, 0.33-3x
    if len(selected) < config.PEER_MIN_COUNT:
        wide = [c for c in in_country if config.PEER_RANGE_WIDE[0] <= c["pop"] / target_pop <= config.PEER_RANGE_WIDE[1]]
        wide.sort(key=lambda c: _closeness(c["pop"], target_pop))
        add_candidates(wide, f"same-country {config.PEER_RANGE_WIDE[0]}x-{config.PEER_RANGE_WIDE[1]}x")

    # Stage 2b: largest same-country cities below the population range
    # (e.g. London vs Birmingham) — usually far more comparable than
    # international cities of identical population.
    if len(selected) < config.PEER_MIN_COUNT:
        below = [c for c in in_country if c["pop"] < target_pop * config.PEER_RANGE_WIDE[0]]
        below.sort(key=lambda c: -c["pop"])
        add_candidates(below[: config.PEER_INCOUNTRY_BELOW_RANGE], "same-country below population range")

    # Stage 3: international fallback (same region preferred, then population).
    # Fills up to the full candidate count because same-country peers may later
    # be dropped for poor POI coverage.
    if len(selected) < config.PEER_CANDIDATES and config.PEER_INTERNATIONAL_FALLBACK:
        eligible = [c for c in others if config.PEER_RANGE_WIDE[0] <= c["pop"] / target_pop <= config.PEER_RANGE_WIDE[1]]
        eligible.sort(key=lambda c: (region_bonus(c), _closeness(c["pop"], target_pop)))
        add_candidates(eligible, "international same-region, similar-population")

    # fetch backups so data-poor peers can be dropped after snapshotting
    selected = selected[: config.PEER_CANDIDATES]
    info["warnings"] = []
    if len(selected) < config.PEER_MIN_COUNT:
        info["warnings"].append(
            f"Only {len(selected)} comparable city/ies found; fewer peers lower statistical confidence."
        )

    # English labels for display
    from ..providers import population as population_provider
    from ..providers.city import CityResolutionError, meta_from_wikidata

    qids = [c["qid"] for c in selected if c.get("qid")]
    label_map = population_provider.english_labels(qids) if qids else {}

    peers: list[PeerCity] = []
    for i, c in enumerate(selected):
        label = label_map.get(c.get("qid")) or c["name"]
        if progress:
            progress("peers", 0.3 + 0.5 * (i + 1) / max(len(selected), 1), f"Locating peer city {label}…")
        
        try:
            meta = meta_from_wikidata({
                "qid": c.get("qid"), "label": label, "cc": c.get("cc") or city.country_code,
                "lat": c["lat"], "lon": c["lon"], "pop": c["pop"],
            }, enrich=False)
        except CityResolutionError:
            continue
        peers.append(PeerCity(
            city_id=meta.city_id,
            name=meta.name,
            country=meta.country,
            country_code=meta.country_code,
            population=meta.population or c["pop"],
            population_year=None,
            wikidata_qid=c.get("qid"),
            weight=round(_weight(c["pop"], target_pop), 4),
            snapshot_ready=False,
            boundary_type=meta.boundary_type,
        ))
        cache.set(f"city:{meta.city_id}", meta.model_dump(), config.get_ttl("city_metadata"))

    cache.set(cache_key, {"peers": [p.model_dump() for p in peers], "info": info}, config.get_ttl("peer_set"))
    return peers, info


def _region_map() -> dict[str, str]:
    from ..countries import get_countries
    return {c["cca2"]: c.get("region") for c in get_countries()}


def ensure_peer_snapshots(peers: list[PeerCity], progress: ProgressFn | None = None) -> list[PeerCity]:
    """Build snapshots for all peers that don't have one yet."""
    from ..providers.city import CityResolver

    updated: list[PeerCity] = []
    for i, peer in enumerate(peers):
        meta_data = cache.get(f"city:{peer.city_id}")
        meta = CityMeta(**meta_data) if meta_data else None
        if meta is None:
            resolver = CityResolver()
            meta = resolver.resolve_by_name(peer.name, peer.country_code)
        if meta is None:
            peer.snapshot_ready = False
            peer.note = "Could not resolve location"
            updated.append(peer)
            continue

        def sub(stage: str, frac: float, msg: str) -> None:
            if progress:
                progress(stage, 0.55 + 0.40 * (i + frac) / max(len(peers), 1), f"[{peer.name}] {msg}")

        try:
            snap = snapshot_service.get_or_build_snapshot(meta, progress=sub)
            peer.snapshot_ready = True
            peer.total_places = snap.total_places
            peer.boundary_type = snap.boundary_type
            if not peer.population:
                peer.population = snap.population
            if snap.total_places < config.PEER_MIN_PLACES:
                peer.snapshot_ready = False
                peer.note = (
                    f"POI coverage too low ({snap.total_places:,} places) for a reliable comparison"
                )
        except Exception as e:  # noqa: BLE001
            peer.snapshot_ready = False
            peer.note = f"Snapshot failed: {type(e).__name__}"
        updated.append(peer)
    return updated
