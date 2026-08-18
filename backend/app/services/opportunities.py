"""Opportunity scanner.

Uses the city's cached snapshot (and peer snapshots) to rank every commercial
category by Opportunity Score, with filters. No new Overture downloads happen
beyond the snapshots themselves.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from .. import config
from ..cache import cache
from ..models import CityMeta, OpportunitiesResult, OpportunityRow, PeerCity
from ..taxonomy import FAMILY_LABEL, get_category, is_commercial, label_for
from . import analysis as analysis_service
from . import peers as peers_service
from . import snapshot as snapshot_service

ProgressFn = Callable[[str, float, str], None]

DEFAULT_FILTERS = {
    "min_score": 60,
    "min_confidence": 30,
    "min_existing": 0,
    "max_categories": 50,
    "families": None,        # list of family ids or None
    "include": None,         # list of category ids
    "exclude": None,
}


def _peer_median(counts: list[int]) -> float:
    vals = sorted(counts)
    if not vals:
        return 0.0
    n = len(vals)
    if n % 2 == 1:
        return float(vals[n // 2])
    return (vals[n // 2 - 1] + vals[n // 2]) / 2


def scan_opportunities(city_id: str, filters: Optional[dict[str, Any]] = None,
                       progress: ProgressFn | None = None, force: bool = False) -> OpportunitiesResult:
    f = {**DEFAULT_FILTERS, **(filters or {})}
    if "refresh" in f:
        force = force or bool(f.pop("refresh"))
    # Version the cache key so taxonomy/matching changes invalidate stale scans.
    cache_key = f"opportunities:v{config.LOGIC_VERSION}:{city_id}"
    cached = cache.get(cache_key)
    if cached and not force:
        try:
            result = OpportunitiesResult(**cached)
            if not filters:
                return result
        except Exception:
            pass

    if progress:
        progress("loading", 0.05, "Loading city snapshot…")
    city = snapshot_service.ensure_city(city_id)

    def _snap_progress(stage: str, frac: float, msg: str) -> None:
        if progress:
            progress(stage, 0.05 + frac * 0.35, msg)

    snap = snapshot_service.get_or_build_snapshot(city, progress=_snap_progress, force=force)

    if progress:
        progress("peers", 0.42, "Preparing peer cities…")

    def _peer_progress(stage: str, frac: float, msg: str) -> None:
        if progress:
            progress(stage, 0.42 + frac * 0.28, msg)

    peers, peer_info = peers_service.select_peers(city, progress=_peer_progress)
    peers = peers_service.ensure_peer_snapshots(peers, progress=_peer_progress)

    if progress:
        progress("analyzing", 0.72, "Aggregating category counts…")

    # Candidates come from leaf counts (specific business types, no taxonomy
    # roots); counts are computed LIVE from the DB with taxonomy equivalents
    # expanded (a place tagged bank_or_credit_union IS a bank), so the scanner
    # agrees with the per-category analysis page even for snapshots built
    # before an equivalence existed.
    from ..taxonomy import CATEGORY_EQUIVALENTS

    def _expand(cats: dict[str, int]) -> dict[str, int]:
        """Expand category counts with taxonomy equivalents.
        
        If grocery_store has 176 and is equivalent to supermarket, then
        supermarket should also have 176 (not 0).
        """
        out = dict(cats)
        # First pass: collect all equivalences
        equiv_map: dict[str, set[str]] = {}
        for c in cats:
            equiv_map[c] = CATEGORY_EQUIVALENTS.get(c, set())
            for eq in equiv_map[c]:
                if eq not in equiv_map:
                    equiv_map[eq] = CATEGORY_EQUIVALENTS.get(eq, set())
        # Second pass: for each category, sum counts of all equivalent categories
        for c in list(out.keys()):
            equiv_cats = equiv_map.get(c, set()) | {c}
            total = sum(cats.get(ec, 0) for ec in equiv_cats)
            out[c] = total
            for eq in equiv_cats:
                if eq not in out:
                    out[eq] = total
        return out

    # Use leaf_counts for both candidates AND counts — leaf_counts has
    # specific business types (restaurant, cafe, gym) not taxonomy roots
    # (food_and_drink, shopping). The matched_counts_expanded() has roots,
    # so using it for leaf category counts returns 0.
    city_leaf_counts = _expand(dict(snap.leaf_counts or {}))
    city_counts = city_leaf_counts  # Use leaf counts for city counts
    peer_leaf_by_city: dict[str, dict[str, int]] = {}
    peer_counts_by_city: dict[str, dict[str, int]] = {}
    for p in peers:
        if not p.snapshot_ready:
            continue
        meta_data = cache.get(f"city:{p.city_id}")
        meta = CityMeta(**meta_data) if meta_data else None
        if meta:
            try:
                psnap = snapshot_service.get_or_build_snapshot(meta)
                peer_leaf_by_city[p.city_id] = _expand(dict(psnap.leaf_counts or {}))
                peer_counts_by_city[p.city_id] = snapshot_service.matched_counts_expanded(p.city_id)
            except Exception:
                peer_leaf_by_city[p.city_id] = {}
                peer_counts_by_city[p.city_id] = {}
        else:
            peer_leaf_by_city[p.city_id] = {}
            peer_counts_by_city[p.city_id] = {}

    peer_leaf_counts = list(peer_leaf_by_city.values())
    peer_counts = peer_leaf_counts  # Use leaf counts for peers too

    # Candidate categories: specific business types with signal somewhere
    candidates: set[str] = set(city_leaf_counts.keys())
    for pc in peer_leaf_counts:
        candidates.update(pc.keys())
    # Categories you cannot open (ATM, ...) are never opportunities.
    candidates -= config.NON_STARTABLE_CATEGORIES

    usable = analysis_service._usable_peers(peers, snap.total_places, city.population)
    peer_rows_for_stats: list[PeerCity] = []
    for p in usable:
        pr = PeerCity(**p.model_dump())
        peer_rows_for_stats.append(pr)

    rows: list[OpportunityRow] = []
    context = {"city": city, "city_name": city.name, "snapshot": snap}

    # Build a peer-count lookup so stats reuse real counts
    for cat in sorted(candidates):
        if not is_commercial(cat):
            continue
        fam = None
        from ..taxonomy import get_category
        ci = get_category(cat)
        family = ci["family"] if ci else "other"

        if f["families"] and family not in f["families"]:
            continue
        if f["include"] and cat not in f["include"]:
            continue
        if f["exclude"] and cat in f["exclude"]:
            continue

        city_count = city_counts.get(cat, 0)
        peer_med = _peer_median([pc.get(cat, 0) for pc in peer_counts])
        # Require signal somewhere: either the city has it, or peers clearly do
        if city_count < 2 and peer_med < 2:
            continue
        if city_count < f["min_existing"]:
            continue

        # Set peer counts for stats computation
        for p in peer_rows_for_stats:
            p.count = peer_counts_by_city.get(p.city_id, {}).get(cat, 0)
            if p.population and p.population > 0:
                p.per_10k = round(p.count / p.population * 10000, 4)

        stats = analysis_service.compute_stats(cat, city_count, city.population, peer_rows_for_stats, context)

        # Demand boost: increase score for categories with strong demand signals
        try:
            from .demand import compute_demand_score
            cat_info = get_category(cat)
            aliases = cat_info.get("aliases", []) if cat_info else []
            demand = compute_demand_score(
                category_label=stats.label,
                city_name=city.name,
                country_name=city.country,
                category_aliases=aliases,
            )
            if demand and demand.get("score", 0) > 0:
                demand_bonus = round(demand["score"] * 0.15)  # up to +15 points
                stats.opportunity_score = min(100, (stats.opportunity_score or 0) + demand_bonus)
                stats.score_label = analysis_service.score_label(stats.opportunity_score)
        except Exception:
            pass

        if stats.opportunity_score is None:
            continue
        if stats.opportunity_score < f["min_score"]:
            continue
        if (stats.data_confidence or 0) < f["min_confidence"]:
            continue

        rows.append(OpportunityRow(
            category_id=cat,
            label=stats.label,
            family=stats.family,
            family_label=stats.family_label,
            existing=city_count,
            per_10k=stats.per_10k,
            expected=stats.expected_count,
            gap=stats.gap,
            gap_pct=stats.gap_pct,
            score=stats.opportunity_score,
            score_label=stats.score_label,
            confidence=stats.data_confidence,
            warnings=stats.warnings,
            explanation=stats.explanation,
        ))

    rows.sort(key=lambda r: (-(r.score or 0), -(r.gap or 0)))
    rows = rows[: int(f["max_categories"])]

    anomaly_warnings: list[str] = []
    if snap.population:
        density = snap.total_places / snap.population * 10000
        if density < config.MIN_PLACES_PER_10K:
            anomaly_warnings.append(
                f"Total POI coverage is low ({density:.1f} per 10,000 residents). "
                "Rankings may reflect incomplete data."
            )
    else:
        anomaly_warnings.append("Population unavailable; per-capita figures could not be computed.")
    if len(peers) < config.PEER_MIN_COUNT:
        anomaly_warnings.append(f"Only {len(peers)} comparable peer cities were found.")

    result = OpportunitiesResult(
        city=city,
        snapshot=snap,
        peers=peers,
        opportunities=rows,
        filters_applied=f,
        generated_at=analysis_service._now(),
        anomaly_warnings=anomaly_warnings,
    )
    cache.set(cache_key, result.model_dump(), config.get_ttl("opportunities"))
    if progress:
        progress("done", 1.0, f"Found {len(rows)} opportunities")
    return result
