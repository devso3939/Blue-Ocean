"""Market analysis engine.

Deterministic statistics only — no invented numbers:
- businesses per 10,000 residents per city
- weighted-median peer benchmark (population-closeness weights)
- expected supply at benchmark, estimated supply gap
- Opportunity Score (gap 60% + undersupply percentile 25% + market size 15%)
- separate Data Confidence score
"""
from __future__ import annotations

import datetime
import hashlib
import math
from typing import Any, Callable, Optional

from .. import config
from ..cache import cache
from ..models import (CategoryStats, CityMeta, MarketAnalysis, PeerCity,
                      SnapshotMeta)
from ..taxonomy import (FAMILY_LABEL, get_category, is_commercial, label_for)
from . import peers as peers_service
from . import snapshot as snapshot_service
from .ai import llm_insight

ProgressFn = Callable[[str, float, str], None]

SCORE_LABELS = [
    (90, "Exceptional Gap"),
    (80, "Very Strong Opportunity"),
    (70, "Strong Opportunity"),
    (60, "Potential Opportunity"),
    (45, "Balanced / Unclear"),
    (30, "Competitive"),
    (0, "Highly Saturated"),
]


def score_label(score: Optional[int]) -> str:
    if score is None:
        return "Insufficient Data"
    for threshold, label in SCORE_LABELS:
        if score >= threshold:
            return label
    return "Insufficient Data"


def weighted_median(values: list[tuple[float, float]]) -> Optional[float]:
    """Median of values weighted by weights."""
    if not values:
        return None
    ordered = sorted(values, key=lambda vw: vw[0])
    total = sum(w for _, w in ordered)
    if total <= 0:
        return None
    cum = 0.0
    for v, w in ordered:
        cum += w
        if cum >= total / 2:
            return v
    return ordered[-1][0]


def _gap_score(gap_pct: Optional[float]) -> float:
    """0..100 from supply shortage ratio (smooth, bounded)."""
    if gap_pct is None:
        return 50.0
    r = max(-1.5, min(2.5, gap_pct))
    return 50.0 * (1.0 + math.tanh(r * 1.4))


def _percentile_score(city_per_10k: Optional[float], peer_per_10k: list[Optional[float]]) -> float:
    values = [v for v in peer_per_10k if v is not None]
    if city_per_10k is None:
        return 50.0
    all_vals = values + [city_per_10k]
    n = len(all_vals)
    if n <= 1:
        return 50.0
    rank_asc = sum(1 for v in values if v < city_per_10k)
    return 100.0 * (n - 1 - rank_asc) / (n - 1)


def _market_size_score(pop: Optional[int]) -> float:
    if not pop or pop <= 0:
        return 40.0
    a = math.log10(max(pop, 1) / config.MARKET_POP_REF)
    b = math.log10(config.MARKET_POP_MAX / config.MARKET_POP_REF)
    return max(15.0, min(100.0, 100.0 * (0.5 + 0.5 * (a / b if b else 0.5))))


def _fmt(x: float, digits: int = 2) -> str:
    return f"{x:.{digits}f}"


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def compute_stats(
    category_id: str,
    city_count: int,
    city_pop: Optional[int],
    peers: list[PeerCity],
    context: dict[str, Any],
    name_signal_matches: int = 0,
) -> CategoryStats:
    """Core statistics + scores for one category in the target city."""
    cat_info = get_category(category_id)
    label = cat_info["label"] if cat_info else label_for(category_id)
    family = cat_info["family"] if cat_info else "other"

    per_10k = (city_count / city_pop * 10000) if city_pop else None

    peer_rows = [
        (p, (p.count / p.population * 10000) if (p.snapshot_ready and p.population) else None)
        for p in peers
    ]
    # Peers with implausibly low category counts (e.g. 2 pet groomers in a city
    # of 1.2M) are usually data-coverage gaps, not genuine undersupply. They are
    # excluded from the benchmark and flagged, so missing data cannot dominate.
    # The threshold is adaptive: for a niche category where the city itself has
    # only 1-2 businesses, a peer with 1 is a valid observation, not missing
    # data — otherwise every rare category would lose almost all its peers and
    # its confidence would be unfairly low.
    peer_min_cat = min(
        config.PEER_MIN_CATEGORY_COUNT,
        max(1, math.ceil(city_count / 2)),
    )
    qualifying = [
        (p, v) for p, v in peer_rows
        if v is not None and p.count >= peer_min_cat
    ]
    benchmark = weighted_median([
        (v, p.weight) for p, v in qualifying
    ])
    for p, v in peer_rows:
        if v is not None and p.count < peer_min_cat:
            p.per_10k = None
            p.note = (
                f"Category count ({p.count}) too low to benchmark reliably "
                "(possible data-coverage gap)"
            )

    expected_count = (benchmark * city_pop / 10000) if (benchmark is not None and city_pop) else None
    gap = (expected_count - city_count) if expected_count is not None else None
    gap_pct = (gap / expected_count) if (gap is not None and expected_count and expected_count > 0) else None

    percentile = _percentile_score(per_10k, [v for _, v in qualifying])
    market = _market_size_score(city_pop)
    gap_score = _gap_score(gap_pct)
    score = round(config.W_GAP * gap_score + config.W_PERCENTILE * percentile + config.W_MARKET * market)

    warnings: list[str] = []
    if len(qualifying) < len([r for r in peer_rows if r[1] is not None]):
        warnings.append(
            f"{len(peer_rows) - len(qualifying)} peer city/ies had implausibly low "
            f"'{label}' counts and were treated as missing data for the benchmark."
        )

    confidence, conf_components, warnings = _data_confidence(
        category_id=category_id,
        city_count=city_count,
        per_10k=per_10k,
        city_pop=city_pop,
        peers=peer_rows,
        context=context,
        peer_min_cat=peer_min_cat,
    )

    explanation = _explain(
        label=label,
        city_name=context.get("city_name", "the city"),
        count=city_count,
        per_10k=per_10k,
        benchmark=benchmark,
        expected=expected_count,
        gap=gap,
        score=score,
        score_label=score_label(score),
        warnings=warnings,
    )

    ai_insight = llm_insight(
        {
            "label": label, "count": city_count, "per_10k": per_10k,
            "expected_per_10k": benchmark, "expected_count": expected_count,
            "gap": gap, "gap_pct": gap_pct, "opportunity_score": score,
            "score_label": score_label(score), "data_confidence": confidence,
            "warnings": warnings,
        },
        context.get("city_name", "the city"),
    )

    return CategoryStats(
        category_id=category_id,
        label=label,
        family=family,
        family_label=FAMILY_LABEL.get(family, family),
        count=city_count,
        per_10k=round(per_10k, 3) if per_10k is not None else None,
        expected_per_10k=round(benchmark, 3) if benchmark is not None else None,
        expected_count=round(expected_count, 1) if expected_count is not None else None,
        gap=round(gap, 1) if gap is not None else None,
        gap_pct=round(gap_pct, 4) if gap_pct is not None else None,
        opportunity_score=score,
        score_label=score_label(score),
        score_components={
            "gap_score": round(gap_score, 1),
            "undersupply_percentile": round(percentile, 1),
            "market_size_score": round(market, 1),
            "weights": {"gap": config.W_GAP, "percentile": config.W_PERCENTILE, "market": config.W_MARKET},
            "formula": "0.60 x gapScore + 0.25 x undersupplyPercentile + 0.15 x marketSizeScore",
        },
        data_confidence=confidence,
        confidence_components=conf_components,
        warnings=warnings,
        explanation=explanation,
        ai_insight=ai_insight,
        name_signal_matches=name_signal_matches or None,
    )


def _data_confidence(
    category_id: str,
    city_count: int,
    per_10k: Optional[float],
    city_pop: Optional[int],
    peers: list[tuple[PeerCity, Optional[float]]],
    context: dict[str, Any],
    peer_min_cat: int | None = None,
) -> tuple[int, dict[str, Any], list[str]]:
    """0..100 data confidence. Independent from the opportunity score."""
    snap: Optional[SnapshotMeta] = context.get("snapshot")
    city: Optional[CityMeta] = context.get("city")
    warnings: list[str] = []
    comps: dict[str, dict] = {}

    # 1. POI coverage sanity (places per 10k residents)
    total_per_10k = None
    if snap and snap.population:
        total_per_10k = snap.total_places / snap.population * 10000
    if total_per_10k is not None and total_per_10k < config.MIN_PLACES_PER_10K:
        comps["poi_coverage"] = {
            "score": round(max(0.0, total_per_10k / config.MIN_PLACES_PER_10K), 3),
            "detail": f"{total_per_10k:.1f} POIs per 10k residents (below {config.MIN_PLACES_PER_10K:.0f} threshold)",
        }
        warnings.append(
            f"Detected POI density is low ({total_per_10k:.1f} per 10,000 residents) — business counts may understate reality. This city's map data is sparse; counts here are a lower bound."
        )
    else:
        comps["poi_coverage"] = {"score": 1.0, "detail": "POI density looks reasonable" if total_per_10k else "Population unknown"}

    # 2. Category validity
    if snap:
        q = snap.source_quality or {}
        pct_cat = q.get("pct_with_category", 100)
        comps["category_validity"] = {
            "score": round(max(0.0, min(1.0, pct_cat / 100)), 3),
            "detail": f"{pct_cat:.0f}% of POIs have a valid category",
        }
    else:
        comps["category_validity"] = {"score": 0.5, "detail": "Snapshot unavailable"}

    # 3. Overture/OSM agreement (top-level coverage cross-check)
    from ..providers.osm import top_level_agreement
    agr = top_level_agreement(snap.osm_validation if snap else None, snap.total_places if snap else 0)
    if agr is not None:
        comps["osm_agreement"] = {"score": agr, "detail": f"Overture/OSM top-level agreement {agr:.0%}"}
        if agr < 0.5:
            warnings.append(f"Overture and OpenStreetMap disagree significantly on total coverage (agreement {agr:.0%}).")
    else:
        comps["osm_agreement"] = {"score": 0.5, "detail": "OSM cross-check unavailable"}

    # 4. Population availability + recency
    if city_pop:
        year = (city.population_year if city else None) or (snap.population_year if snap else None)
        age = (2026 - year) if year else None
        if age is None:
            pop_score = 0.5
            detail = "Population known, year unknown"
        elif age <= 3:
            pop_score = 1.0
            detail = f"Population {year} estimate"
        elif age <= 6:
            pop_score = 0.8
            detail = f"Population from {year} (moderately recent)"
        else:
            pop_score = 0.55
            detail = f"Population from {year} (may be outdated)"
            warnings.append(f"Population figure is from {year} and may be outdated.")
        comps["population"] = {"score": pop_score, "detail": detail}
    else:
        comps["population"] = {"score": 0.3, "detail": "Population unavailable"}
        warnings.append("No reliable population figure was found; per-capita figures are unavailable.")

    # 5. Boundary quality
    btype = (snap.boundary_type if snap else None) or (city.boundary_type if city else None)
    comps["boundary_quality"] = {
        "score": 1.0 if btype == "polygon" else 0.55,
        "detail": "Administrative boundary" if btype == "polygon" else "Bounding box only",
    }
    if btype != "polygon":
        warnings.append("City boundary was approximated with a bounding box.")

    # 6. Number of useful peers (with meaningful category observations)
    pmc = peer_min_cat if peer_min_cat is not None else config.PEER_MIN_CATEGORY_COUNT
    useful = [p for p, v in peers if p.snapshot_ready and v is not None
              and p.count >= pmc]
    n_peers = len(useful)
    peer_count_score = {0: 0.3, 1: 0.5, 2: 0.65, 3: 0.8, 4: 0.9}.get(n_peers, 1.0)
    comps["peer_count"] = {"score": peer_count_score, "detail": f"{n_peers} comparable peer cities"}
    if n_peers < config.PEER_MIN_COUNT:
        warnings.append(f"Only {n_peers} comparable peer cities; comparisons are less reliable.")

    # 7. Peer consistency (coefficient of variation of per-10k)
    vals = [v for p, v in peers if v is not None and p.count >= pmc]
    if len(vals) >= 3:
        mean = sum(vals) / len(vals)
        if mean > 0:
            std = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))
            cv = std / mean
            consistency = max(0.2, min(1.0, 1.0 - (cv - 0.4) / 1.5))
            comps["peer_consistency"] = {"score": round(consistency, 3), "detail": f"Peer variation (CV) {cv:.2f}"}
        else:
            comps["peer_consistency"] = {"score": 0.8, "detail": "All peers at zero"}
    else:
        comps["peer_consistency"] = {"score": 0.6, "detail": "Too few peers to measure consistency"}

    # 8. Snapshot quality
    if snap:
        q = snap.source_quality or {}
        avg_conf = q.get("avg_confidence", 0.5) or 0.5
        snap_score = min(1.0, max(0.3, avg_conf))
        comps["snapshot_quality"] = {
            "score": round(snap_score, 3),
            "detail": f"Mean Overture confidence {avg_conf:.2f}",
        }
    else:
        comps["snapshot_quality"] = {"score": 0.5, "detail": "Snapshot unavailable"}

    # 9. Zero-count anomaly
    if city_count == 0 and useful and any(v is not None and v > 0 for p, v in peers if p.count >= config.PEER_MIN_CATEGORY_COUNT):
        warnings.append(
            "Zero businesses detected while peers show meaningful supply — this could be a real gap or a data coverage gap."
        )
        comps["zero_count"] = {"score": 0.55, "detail": "Zero count with positive peer signal"}

    weights = {
        "poi_coverage": 0.20, "category_validity": 0.08, "osm_agreement": 0.12,
        "population": 0.15, "boundary_quality": 0.10, "peer_count": 0.12,
        "peer_consistency": 0.12, "snapshot_quality": 0.06, "zero_count": 0.05,
    }
    total = 0.0
    wsum = 0.0
    for key, w in weights.items():
        c = comps.get(key)
        if c:
            total += w * c["score"]
            wsum += w
    confidence = round(100 * total / wsum) if wsum else 50

    # Sparse city: every count is a lower bound, so confidence cannot stay high.
    if total_per_10k is not None and total_per_10k < config.MIN_PLACES_PER_10K:
        confidence = min(confidence, 60)

    return confidence, comps, warnings


def _explain(label, city_name, count, per_10k, benchmark, expected, gap, score, score_label, warnings) -> str:
    parts = []
    city = city_name or "the city"
    if per_10k is not None and benchmark is not None and expected is not None and gap is not None:
        direction = "underserved" if gap > 0 else "well supplied"
        if gap > 0:
            parts.append(
                f"{city} appears relatively {direction} for {label.lower()} compared with cities of a similar population. "
                f"The city currently has approximately {_fmt(per_10k)} detected {label.lower()} businesses per 10,000 residents, "
                f"while the peer-city benchmark is approximately {_fmt(benchmark)}. Matching the benchmark would imply "
                f"roughly {round(expected)} businesses compared with {count} currently detected, producing an estimated "
                f"supply gap of approximately {round(gap)} businesses."
            )
        elif gap < 0:
            parts.append(
                f"{city} appears relatively well supplied for {label.lower()} compared with cities of a similar population. "
                f"It has approximately {_fmt(per_10k)} detected businesses per 10,000 residents versus a peer benchmark of "
                f"{_fmt(benchmark)}, which is roughly {-round(gap)} businesses above the benchmark level. New entrants would "
                f"face stronger existing competition than in comparable cities."
            )
        else:
            parts.append(
                f"{city}'s supply of {label.lower()} ({_fmt(per_10k)} per 10,000 residents) closely matches the peer benchmark "
                f"of {_fmt(benchmark)}. Supply appears balanced relative to comparable cities."
            )
    elif per_10k is None:
        parts.append(
            f"Population data was unavailable for {city}, so per-capita supply could not be benchmarked reliably."
        )
    else:
        parts.append(f"Too few comparable cities had usable data to benchmark {label.lower()} supply in {city}.")

    parts.append(f"The overall opportunity signal is classified as: {score_label} (score {score}/100).")
    parts.append(
        "This is statistical market intelligence based on detected business supply, not proof that a specific number "
        "of new businesses can profitably open. Local purchasing power, customer behaviour, pricing, regulation and "
        "incomplete POI coverage must also be considered."
    )
    if warnings:
        parts.append("Caveats: " + " ".join(warnings[:3]))
    return " ".join(parts)


def analyze_category(city_id: str, category_id: str, progress: ProgressFn | None = None,
                     force: bool = False) -> MarketAnalysis:
    """Full market analysis for one category in one city (cached).

    ``force=True`` re-fetches the city snapshot (recheck) and ignores the
    cached analysis.
    """
    if progress:
        progress("resolving", 0.05, "Loading city…")
    city = snapshot_service.ensure_city(city_id)
    city_id = city.city_id  # canonical id (case/format-normalized)

    analysis_id = hashlib.sha1(
        f"{city_id}:{category_id}:{config.LOGIC_VERSION}".encode()
    ).hexdigest()[:12]
    cache_key = f"market_analysis:{analysis_id}"
    if not force:
        cached = cache.get(cache_key)
        if cached:
            try:
                return MarketAnalysis(**cached)
            except Exception:
                pass

    if progress:
        progress("loading", 0.15, f"Loading businesses for {city.name}…")
    snap = snapshot_service.get_or_build_snapshot(city, progress=progress, force=force)

    if progress:
        progress("peers", 0.5, "Finding comparable cities…")
    peers, peer_info = peers_service.select_peers(city, progress=progress)
    peers = peers_service.ensure_peer_snapshots(peers, progress=progress)

    if progress:
        progress("analyzing", 0.9, "Calculating market gap and scores…")

    for p in peers:
        if p.snapshot_ready:
            try:
                p.count = snapshot_service.count_for_category(p.city_id, category_id)
            except Exception:
                p.count = 0

    usable = _usable_peers(peers, snap.total_places, city.population)
    for p in usable:
        if p.population and p.population > 0:
            p.per_10k = round(p.count / p.population * 10000, 4)

    context = {
        "city": city,
        "city_name": city.name,
        "snapshot": snap,
    }
    city_count, name_signal_matches = snapshot_service.count_for_category_details(city_id, category_id)
    stats = compute_stats(
        category_id, city_count, city.population, usable, context,
        name_signal_matches=name_signal_matches,
    )

    # Sparse-coverage flag: when the city's own map data is thin, counts are a
    # lower bound and the whole analysis must say so loudly.
    sparse_coverage = False
    sparse_detail = None
    if snap.population and snap.population > 0:
        per_10k = snap.total_places / snap.population * 10000
        if per_10k < config.MIN_PLACES_PER_10K:
            sparse_coverage = True
            sparse_detail = (
                f"Only {per_10k:.1f} places per 10,000 residents were found in the open map data "
                f"({snap.total_places:,} places for {snap.population:,} residents). Coverage is sparse in this city — "
                "counts are a lower bound and some real businesses are missing. Cross-check on Google Maps before deciding."
            )

    market_ctx = None
    try:
        from .market import fetch_market_context
        market_ctx = fetch_market_context(city, stats.label)
        if market_ctx:
            market_ctx = market_ctx.model_dump()
    except Exception:
        market_ctx = None

    places = snapshot_service.places_for_category(city_id, category_id, limit=3000)

    # Deterministic AI-analyst brief — always available; the LLM version (when a
    # key is configured) takes precedence.
    if not stats.ai_insight:
        try:
            from .ai import analyst_brief
            stats.ai_insight = analyst_brief(
                {
                    "label": stats.label, "count": stats.count, "per_10k": stats.per_10k,
                    "expected_per_10k": stats.expected_per_10k, "expected_count": stats.expected_count,
                    "gap": stats.gap, "gap_pct": stats.gap_pct, "opportunity_score": stats.opportunity_score,
                    "score_label": stats.score_label, "data_confidence": stats.data_confidence,
                    "warnings": stats.warnings, "sparse": sparse_coverage,
                    "name_signal_matches": stats.name_signal_matches,
                },
                market_ctx,
                places,
            )
        except Exception:
            pass

    grid = _density_grid(city_id, snap)

    methodology = {
        "city": city.name,
        "country": city.country,
        "population": city.population,
        "population_year": city.population_year,
        "population_source": city.population_source,
        "category": category_id,
        "overture_release": snap.overture_release,
        "fetched_at": snap.fetched_at,
        "boundary_type": snap.boundary_type,
        "total_places": snap.total_places,
        "filter_stats": snap.filter_stats.model_dump(),
        "peer_selection": peer_info,
        "peer_method": (
            "Same-country cities with 0.5x-2x the population, ranked by population similarity; "
            "widened to 0.33x-3x; international fallback when needed."
        ),
        "normalization": "businesses per 10,000 residents = count / population x 10000",
        "name_signal_matching": (
            "Taxonomy matches come from Overture's category tree plus curated name patterns; "
            "the system also learns distinctive local name signals (including local-language "
            "equivalents) from each city's own data and applies them conservatively to "
            "generically-tagged places."
        ),
        "benchmark_method": "weighted median of peer businesses-per-10k (weights favour similar population)",
        "expected_supply": "benchmark per-10k x target population / 10000",
        "opportunity_score_formula": (
            f"0.60 x gapScore + 0.25 x undersupplyPercentile + 0.15 x marketSizeScore "
            f"(this run: {stats.score_components.get('gap_score')}, "
            f"{stats.score_components.get('undersupply_percentile')}, "
            f"{stats.score_components.get('market_size_score')})"
        ),
        "disclaimer": "Estimated supply gap is market intelligence, not guaranteed demand.",
    }

    analysis = MarketAnalysis(
        analysis_id=analysis_id,
        city=city,
        category={"id": category_id, "label": stats.label, "family": stats.family,
                  "family_label": stats.family_label},
        snapshot=snap,
        peers=peers,
        peer_selection=peer_info,
        stats=stats,
        places=places,
        density_grid=grid,
        methodology=methodology,
        generated_at=_now(),
        sparse_coverage=sparse_coverage,
        sparse_coverage_detail=sparse_detail,
        market=market_ctx,
    )
    if force:
        cache.delete(cache_key)  # ensure the rechecked result replaces any stale copy
    cache.set(cache_key, analysis.model_dump(), config.get_ttl("market_analysis"))
    if progress:
        progress("done", 1.0, "Analysis complete")
    return analysis


def _usable_peers(peers: list[PeerCity], target_total_places: int, target_pop: Optional[int] = None) -> list[PeerCity]:
    """Keep peers with usable snapshots, sorted by comparison weight.

    Two data-quality filters protect the benchmark:
    - absolute minimum POI count
    - total POI density comparable to the target city (a peer with a small
      fraction of the target's POIs per capita is likely under-covered)
    Per-category quality filtering (minimum category counts) happens inside
    ``compute_stats`` so missing data cannot skew the benchmark.
    """
    target_density = 0.0
    if target_pop and target_pop > 0 and target_total_places:
        target_density = target_total_places / target_pop * 10000
    usable = []
    for p in peers:
        if not (p.snapshot_ready and p.population and p.population > 0):
            continue
        if p.total_places < min(config.PEER_MIN_PLACES, max(1500, target_total_places // 4)):
            p.note = f"POI coverage too low ({p.total_places:,} places) for a reliable comparison"
            continue
        if target_density > 0:
            p_density = p.total_places / p.population * 10000
            # Absolute floor (a city with < 30 POIs per 10k residents is
            # clearly under-covered) + relative guard against extreme gaps.
            min_density = max(30.0, 0.15 * target_density)
            if p_density < min_density:
                p.note = (
                    f"POI coverage too sparse relative to the target city "
                    f"({p_density:.1f} vs {target_density:.1f} places per 10k residents) "
                    "— likely data gaps, excluded from the benchmark"
                )
                continue
        usable.append(p)
    usable.sort(key=lambda p: -p.weight)
    return usable


def get_analysis(analysis_id: str) -> Optional[MarketAnalysis]:
    data = cache.get(f"market_analysis:{analysis_id}")
    if data:
        try:
            return MarketAnalysis(**data)
        except Exception:
            return None
    return None


def _density_grid(city_id: str, snap: SnapshotMeta) -> list[dict[str, Any]]:
    grid_key = f"density_grid:{city_id}"
    cached = cache.get(grid_key)
    if cached is not None:
        return cached
    from ..providers.overture import density_grid
    places = snapshot_service.all_places_light(city_id)
    grid = density_grid(places)
    cache.set(grid_key, grid, config.get_ttl("city_snapshot"))
    return grid
