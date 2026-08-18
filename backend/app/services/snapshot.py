"""City snapshot pipeline.

A snapshot downloads the city's Overture places once, filters them against the
administrative boundary, stores them in SQLite, and computes category counts.
All later analyses reuse the snapshot (per spec: one download, many analyses).
"""
from __future__ import annotations

import datetime
import json
import sqlite3
import threading
from collections import Counter
from typing import Any, Callable, Optional

from .. import config
from ..cache import cache
from ..models import CityMeta, FilterStats, SnapshotMeta
from ..providers import osm as osm_provider
from ..providers import overture
from ..providers.city import CityResolver, CityResolutionError

ProgressFn = Callable[[str, float, str], None]

_db_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.DATA_DIR / "places.sqlite"), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def _add_column(conn: sqlite3.Connection, name: str, ddl: str) -> None:
    try:
        conn.execute(f"ALTER TABLE places ADD COLUMN {name} {ddl}")
    except sqlite3.OperationalError:
        pass  # already present


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS places (
            city_id TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT,
            lat REAL,
            lon REAL,
            primary_category TEXT,
            matched TEXT,
            matched_signal TEXT,
            leaf_category TEXT,
            confidence REAL,
            operating_status TEXT,
            address TEXT,
            locality TEXT,
            postcode TEXT,
            region TEXT,
            country TEXT,
            websites TEXT,
            phones TEXT,
            emails TEXT,
            socials TEXT,
            brand TEXT,
            sources TEXT,
            PRIMARY KEY (city_id, id)
        )"""
    )
    # Upgrades for databases created before learned name signals existed.
    _add_column(conn, "matched_signal", "TEXT")
    _add_column(conn, "leaf_category", "TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_places_cat ON places(city_id, primary_category)")
    conn.commit()


def _leaf_category(p: dict) -> Optional[str]:
    """Most specific taxonomy category for a place, skipping broad roots."""
    from ..taxonomy import leaf_category as _leaf
    return _leaf(p.get("primary_category"), p.get("taxonomy_hierarchy"))


def _esc(cat: str) -> str:
    return cat.replace("|", "")


def _pipe(cats) -> str:
    cats = [c for c in cats if c]
    return ("|" + "|".join(sorted(set(cats))) + "|") if cats else ""


def _store_places(city_id: str, places: list[dict]) -> None:
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        conn.execute("DELETE FROM places WHERE city_id = ?", (city_id,))
        rows = []
        for p in places:
            rows.append((
                city_id, p["id"], p.get("name"), p.get("lat"), p.get("lon"),
                p.get("primary_category"),
                _pipe(p.get("matched_categories", [])),
                "",
                p.get("leaf_category"),
                p.get("confidence"), p.get("operating_status"),
                p.get("address"), p.get("locality"), p.get("postcode"), p.get("region"), p.get("country"),
                json.dumps(p.get("websites", []), ensure_ascii=False),
                json.dumps(p.get("phones", []), ensure_ascii=False),
                json.dumps(p.get("emails", []), ensure_ascii=False),
                json.dumps(p.get("socials", []), ensure_ascii=False),
                p.get("brand"),
                json.dumps(p.get("sources", []), ensure_ascii=False),
            ))
        conn.executemany(
            """INSERT OR REPLACE INTO places
               (city_id, id, name, lat, lon, primary_category, matched, matched_signal,
                leaf_category, confidence, operating_status, address, locality,
                postcode, region, country, websites, phones, emails, socials,
                brand, sources)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        conn.commit()
        conn.close()


# ---------------------------------------------------------------------------
# Learned name signals (per city, derived from the snapshot's own data)
#
# Learning is *live*: each city's pass publishes its signals into shared
# country and language buckets (cache), and every analysis of any city merges
# its own signals with what its country and language have already learned —
# so a signal learned once (e.g. Georgian "გრუმინგი" in Tbilisi) applies to
# every city in that country/language immediately, with no waiting for each
# city to re-learn it.
# ---------------------------------------------------------------------------

MAX_TOKENS_PER_CAT = 40


def _learned_flag(city_id: str) -> str:
    return f"learned_signals_v2:{city_id}"


def _applied_hash_key(city_id: str) -> str:
    return f"learned_applied:{city_id}"


def _city_context(city_id: str) -> tuple[Optional[str], Optional[str]]:
    """(country_code, language) from the cached city meta — never resolves."""
    data = cache.get(f"city:{city_id}")
    if not data:
        return None, None
    cc = (data.get("country_code") or "").strip().upper() or None
    lang = None
    if cc:
        from ..languages import language_for_country
        lang = language_for_country(cc)
    return cc, lang


def _bucket_keys(country_code: Optional[str], lang: Optional[str]) -> list[str]:
    keys = []
    if country_code:
        keys.append(f"learned:cc:{country_code.lower()}")
    if lang:
        keys.append(f"learned:lang:{lang}")
    return keys


def _read_buckets(keys: list[str]) -> dict[str, list[str]]:
    from .learning import merge_signals
    sets = [cache.get(k) for k in keys if cache.get(k)]
    return merge_signals(*sets) if sets else {}


def _publish_signals(keys: list[str], signals: dict[str, list[str]]) -> None:
    from .learning import merge_signals
    for k in keys:
        merged = merge_signals(cache.get(k), signals)
        merged = {c: toks[:MAX_TOKENS_PER_CAT] for c, toks in merged.items()}
        cache.set(k, merged, config.get_ttl("city_snapshot") * 2)


def _load_learning_rows(city_id: str) -> list[dict]:
    """Places with the fields needed for signal learning + application."""
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        cur = conn.execute(
            "SELECT id, name, primary_category, leaf_category, matched, matched_signal "
            "FROM places WHERE city_id = ?",
            (city_id,),
        )
        rows = cur.fetchall()
        conn.close()
    out = []
    for r in rows:
        # leaf_category is NULL for pre-upgrade snapshots: fall back to the
        # primary category so precision guards still work on old data.
        leaf = r[3] or r[2]
        out.append({
            "id": r[0],
            "name": r[1],
            "leaf": leaf,
            "matched": set(r[4].strip("|").split("|")) if r[4] else set(),
            "matched_signal": set(r[5].strip("|").split("|")) if r[5] else set(),
        })
    return out


def _write_learned_matches(city_id: str, changed: list[dict]) -> None:
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        for p in changed:
            conn.execute(
                "UPDATE places SET matched = ?, matched_signal = ? WHERE city_id = ? AND id = ?",
                (_pipe(p.get("matched", [])), _pipe(p.get("matched_signal", [])),
                 city_id, p["id"]),
            )
        conn.commit()
        conn.close()


def _all_matched_counts_sql(city_id: str) -> dict[str, int]:
    """Raw matched counts — no learning trigger (used inside the pass itself)."""
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        cur = conn.execute("SELECT matched FROM places WHERE city_id = ?", (city_id,))
        rows = cur.fetchall()
        conn.close()
    counter: Counter = Counter()
    for (matched,) in rows:
        if not matched:
            continue
        for c in matched.strip("|").split("|"):
            if c:
                counter[c] += 1
    return dict(counter)


def apply_learned_signals(city_id: str) -> int:
    """Learn + apply per-city and regional name signals. Live and idempotent.

    Every call:
    - learns the city's own signals once (flag-gated) and publishes them to the
      country / language buckets, so other cities benefit immediately;
    - re-applies the merged (city + country + language) signals only when the
      regional signal set has changed (digest check), so an analysis performed
      after a sibling city taught a new signal picks it up automatically.

    Returns the number of places that gained a category in this run, and
    refreshes the cached snapshot's counts to match.
    """
    from .learning import apply_signals, learn_signals

    cc, lang = _city_context(city_id)
    bucket_keys = _bucket_keys(cc, lang)

    flag = _learned_flag(city_id)
    if not cache.get(flag):
        rows0 = _load_learning_rows(city_id)
        if rows0:
            local = learn_signals(rows0)
            if local:
                _publish_signals(bucket_keys, local)
        cache.set(flag, True, config.get_ttl("city_snapshot"))

    merged = _read_buckets(bucket_keys)
    if not merged:
        return 0

    import hashlib
    digest = hashlib.sha1(json.dumps(merged, sort_keys=True).encode()).hexdigest()
    apply_key = _applied_hash_key(city_id)
    if cache.get(apply_key) == digest:
        return 0

    rows = _load_learning_rows(city_id)
    if not rows:
        cache.set(apply_key, digest, config.get_ttl("city_snapshot"))
        return 0
    changed = apply_signals(rows, merged)
    if changed:
        _write_learned_matches(city_id, changed)
    cache.set(apply_key, digest, config.get_ttl("city_snapshot"))

    # Keep cached snapshot counts consistent with the learned matches.
    meta_key = f"city_snapshot:{city_id}"
    meta = cache.get(meta_key)
    if meta:
        meta["matched_counts"] = _all_matched_counts_sql(city_id)
        added: Counter = Counter()
        for p in changed:
            for c in p.get("matched_signal", set()):
                added[c] += 1
        leaf_counts = dict(meta.get("leaf_counts") or {})
        for c, n in added.items():
            leaf_counts[c] = leaf_counts.get(c, 0) + n
        meta["leaf_counts"] = leaf_counts
        cache.set(meta_key, meta, config.get_ttl("city_snapshot"))
    return len(changed)


def ensure_learned(city_id: str) -> int:
    """Run the learned name-signal pass for a city (live + idempotent)."""
    return apply_learned_signals(city_id)


def _category_scope(category_id: str) -> tuple[str, list[str]]:
    """(escaped category, [escaped category + taxonomy equivalents]).

    A category's true scope includes its taxonomy equivalents: a place tagged
    ``bank_or_credit_union`` IS a bank, a ``shared_office_space`` IS a
    coworking space. Snapshots store the frozen match list from fetch time, so
    equivalence must be applied at query time — otherwise old snapshots (and
    matches created before an equivalence existed) undercount real businesses
    (e.g. Batumi banks: 6 instead of 21).
    """
    from ..taxonomy import CATEGORY_EQUIVALENTS
    cats = {category_id, *CATEGORY_EQUIVALENTS.get(category_id, set())}
    return _esc(category_id), sorted(_esc(c) for c in cats if c)


def count_for_category_details(city_id: str, category_id: str) -> tuple[int, int]:
    """(total, signal_only) for a category, including taxonomy equivalents.

    ``signal_only`` counts places matched purely via learned name signals
    (taxonomy + static name signals excluded), so the UI can show where
    detected supply came from.
    """
    ensure_learned(city_id)
    _, scope = _category_scope(category_id)
    clauses = " OR ".join(["instr(matched, ?) > 0"] * len(scope))
    signal_clauses = " OR ".join(["instr(matched_signal, ?) > 0"] * len(scope))
    params = [f"|{c}|" for c in scope]
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        total = conn.execute(
            f"SELECT count(*) FROM places WHERE city_id = ? AND ({clauses})",
            [city_id, *params],
        ).fetchone()[0]
        signal = conn.execute(
            f"SELECT count(*) FROM places WHERE city_id = ? AND ({signal_clauses})",
            [city_id, *params],
        ).fetchone()[0]
        conn.close()
    return int(total), int(signal)


def places_for_category(city_id: str, category_id: str, limit: int = 3000) -> list[dict]:
    ensure_learned(city_id)
    _, scope = _category_scope(category_id)
    clauses = " OR ".join(["instr(matched, ?) > 0"] * len(scope))
    params = [f"|{c}|" for c in scope]
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        cur = conn.execute(
            f"""SELECT id, name, lat, lon, primary_category, matched, confidence,
                      operating_status, address, locality, postcode, region, country,
                      websites, phones, emails, socials, brand, sources
               FROM places WHERE city_id = ? AND ({clauses})
               ORDER BY confidence DESC LIMIT ?""",
            [city_id, *params, limit],
        )
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        conn.close()
    return [_row_to_place(dict(zip(cols, r))) for r in rows]


def count_for_category(city_id: str, category_id: str) -> int:
    return count_for_category_details(city_id, category_id)[0]


def all_matched_counts(city_id: str) -> dict[str, int]:
    ensure_learned(city_id)
    return _all_matched_counts_sql(city_id)


def matched_counts_expanded(city_id: str) -> dict[str, int]:
    """Matched counts where every category includes its taxonomy equivalents.

    Computed per place (so a place matching both ``bank`` and
    ``bank_or_credit_union`` counts once for each), then each place's matched
    set is closed over CATEGORY_EQUIVALENTS. This is what the opportunity
    scanner should use: it stays correct for snapshots created before an
    equivalence existed.
    """
    from ..taxonomy import CATEGORY_EQUIVALENTS
    ensure_learned(city_id)
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        cur = conn.execute("SELECT matched FROM places WHERE city_id = ?", (city_id,))
        rows = cur.fetchall()
        conn.close()
    counter: Counter = Counter()
    for (matched,) in rows:
        if not matched:
            continue
        cats = {c for c in matched.strip("|").split("|") if c}
        for c in list(cats):
            cats.update(CATEGORY_EQUIVALENTS.get(c, set()))
        for c in cats:
            counter[c] += 1
    return dict(counter)


def all_places_light(city_id: str) -> list[dict]:
    """Minimal lat/lon rows for density computations."""
    with _db_lock:
        conn = _connect()
        _init_schema(conn)
        cur = conn.execute(
            "SELECT id, name, lat, lon FROM places WHERE city_id = ?", (city_id,)
        )
        rows = cur.fetchall()
        conn.close()
    return [{"id": r[0], "name": r[1], "lat": r[2], "lon": r[3]} for r in rows]


def _row_to_place(row: dict) -> dict:
    def loads(v):
        try:
            return json.loads(v) if v else []
        except Exception:
            return []
    return {
        "id": row["id"],
        "name": row["name"],
        "lat": row["lat"],
        "lon": row["lon"],
        "primary_category": row["primary_category"],
        "confidence": row["confidence"] or 0,
        "operating_status": row["operating_status"],
        "address": row["address"],
        "locality": row["locality"],
        "postcode": row["postcode"],
        "region": row["region"],
        "country": row["country"],
        "websites": loads(row["websites"]),
        "phones": loads(row["phones"]),
        "emails": loads(row["emails"]),
        "socials": loads(row["socials"]),
        "brand": row["brand"],
        "sources": loads(row["sources"]),
    }


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def get_or_build_snapshot(
    city: CityMeta,
    progress: ProgressFn | None = None,
    force: bool = False,
) -> SnapshotMeta:
    """Return the snapshot meta for a city, building it if needed."""
    city_id = city.city_id
    cache_key = f"city_snapshot:{city_id}"
    cached = cache.get(cache_key)
    if cached and not force:
        try:
            meta = SnapshotMeta(**cached)
        except Exception:
            meta = None
    else:
        meta = None

    if meta is None:
        cache.delete(_learned_flag(city_id))

    if meta is not None:
        # Snapshot exists — make sure learned name signals have been applied
        # (idempotent) so returned counts include them.
        apply_learned_signals(city_id)
        refreshed = cache.get(cache_key)
        return SnapshotMeta(**refreshed) if refreshed else meta

    if progress:
        progress("loading", 0.05, f"Downloading businesses for {city.name}…")

    provider = overture.OvertureProvider()

    def sub(stage: str, frac: float, msg: str) -> None:
        if progress:
            progress(stage, 0.05 + 0.75 * frac, msg)

    places, fstats, quality = provider.fetch_places(
        city.bbox, city.boundary, progress=sub
    )

    if progress:
        progress("categorizing", 0.85, "Categorizing businesses…")

    primary_counts = Counter(p.get("primary_category") for p in places if p.get("primary_category"))
    matched_counts = Counter()
    leaf_counts = Counter()
    for p in places:
        for c in p.get("matched_categories", []):
            matched_counts[c] += 1
        leaf = _leaf_category(p)
        if leaf:
            leaf_counts[leaf] += 1

    _store_places(city_id, places)

    # OSM coverage validation (best effort; None when Overpass unreachable)
    osm_validation = None
    if progress:
        progress("validating", 0.93, "Cross-checking with OpenStreetMap…")
    if city.osm_id:
        try:
            osm_validation = osm_provider.validate_coverage(
                city.osm_type, city.osm_id, city.bbox
            )
        except Exception:
            osm_validation = None

    meta = SnapshotMeta(
        city_id=city_id,
        city_name=city.name,
        country=city.country,
        population=city.population,
        population_year=city.population_year,
        overture_release=provider.release,
        fetched_at=_now(),
        bbox=city.bbox,
        boundary_type=city.boundary_type,
        total_places=len(places),
        filter_stats=FilterStats(**fstats),
        source_quality=quality,
        primary_counts=dict(primary_counts),
        matched_counts=dict(matched_counts),
        leaf_counts=dict(leaf_counts),
        osm_validation=osm_validation,
    )
    cache.set(cache_key, meta.model_dump(), config.get_ttl("city_snapshot"))

    # Learn local name signals from the fresh data and refresh the cached meta
    # so counts (matched + leaf) include the learned matches.
    if progress:
        progress("learning", 0.96, "Learning local name signals…")
    apply_learned_signals(city_id)
    refreshed = cache.get(cache_key)
    if refreshed:
        meta = SnapshotMeta(**refreshed)
    if progress:
        progress("done", 1.0, f"Snapshot ready: {len(places):,} businesses")
    return meta


def ensure_city(city_id: str, progress: ProgressFn | None = None) -> CityMeta:
    """Load a resolved city from cache, or error.

    Case-insensitive: 'Tbilisi-GE', 'tbilisi-GE' and 'tbilisi-ge' all resolve
    to the same cached city.
    """
    for candidate in (city_id, city_id.lower()):
        data = cache.get(f"city:{candidate}")
        if data:
            return CityMeta(**data)
    # try resolving via the id slug (cityname-cc)
    from ..countries import country_code_to_name
    if "-" in city_id:
        name, cc = city_id.rsplit("-", 1)
        country = country_code_to_name(cc)
        if country:
            return CityResolver().resolve(country, name.replace("-", " "))
    raise CityResolutionError(f"City '{city_id}' is not known. Resolve it first.")
