"""Application configuration. All settings overridable via environment variables."""
from __future__ import annotations

import json
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Load a local .env file if present, so BLUEOCEAN_*/LLM environment variables
# can be configured in backend/.env without exporting them manually.
try:
    from dotenv import load_dotenv

    load_dotenv(BACKEND_DIR / ".env")
except ImportError:
    pass

DATA_DIR = Path(os.environ.get("BLUEOCEAN_DATA_DIR", BACKEND_DIR / "data"))
SNAPSHOT_DIR = DATA_DIR / "snapshots"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

CACHE_DB = DATA_DIR / "cache.sqlite"

# --- Cache TTLs (seconds) -------------------------------------------------
DEFAULT_TTLS = {
    "stac_release": 12 * 3600,          # Overture release resolution
    "country_list": 30 * 86400,
    "nominatim_search": 30 * 86400,     # autocomplete hits
    "city_metadata": 90 * 86400,        # boundaries, ids
    "population": 60 * 86400,
    "country_peers": 14 * 86400,        # candidate peer lists per country
    "peer_set": 30 * 86400,             # chosen peer set per city
    "city_snapshot": 14 * 86400,        # POI snapshot per city
    "osm_validation": 30 * 86400,
    "market_analysis": 30 * 86400,      # per (city, category)
    "opportunities": 30 * 86400,        # per city
}
TTLS = {k: int(os.environ.get(f"BLUEOCEAN_TTL_{k.upper()}", v)) for k, v in DEFAULT_TTLS.items()}


def get_ttl(key: str) -> int:
    return TTLS.get(key, 3600)


# --- External service endpoints ------------------------------------------
NOMINATIM_URL = os.environ.get("BLUEOCEAN_NOMINATIM_URL", "https://nominatim.openstreetmap.org")
WIKIDATA_SPARQL_URL = os.environ.get("BLUEOCEAN_WIKIDATA_URL", "https://query.wikidata.org/sparql")
OVERPASS_URLS = [
    u for u in os.environ.get(
        "BLUEOCEAN_OVERPASS_URLS",
        "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter",
    ).split(",") if u
]
RESTCOUNTRIES_URL = "https://restcountries.com/v3.1/all?fields=name,cca2,cca3,region,subregion"

USER_AGENT = os.environ.get(
    "BLUEOCEAN_USER_AGENT",
    "BlueOceanOpportunityIntel/0.1 (open data market research tool; contact: blueocean.intel.dev@example.com)",
)

# Overture data
OVERTURE_S3_BUCKET = "overturemaps-us-west-2"
OVERTURE_STAC_URL = "https://stac.overturemaps.org/catalog.json"

# --- Analysis parameters --------------------------------------------------
PEER_COUNT_DEFAULT = 5          # peers used in the benchmark
PEER_CANDIDATES = 7             # peers fetched before data-quality filtering
PEER_MIN_COUNT = 3              # below this, confidence drops and warnings appear
PEER_MIN_PLACES = 2500          # peer snapshots below this POI count are data-poor
PEER_MIN_CATEGORY_COUNT = 3     # peers below this category count are treated as missing data
PEER_RANGE_TIGHT = (0.5, 2.0)      # population multiplier range, preferred
PEER_RANGE_WIDE = (0.33, 3.0)      # expanded range when few peers
PEER_INTERNATIONAL_FALLBACK = True
PEER_MIN_POP_CANDIDATE = 50_000    # ignore tiny settlements as candidates
PEER_MIN_POP_INTERNATIONAL = 150_000
PEER_INCOUNTRY_BELOW_RANGE = 2     # extra same-country cities below the pop range

# Opportunity scoring weights
W_GAP = 0.60
W_PERCENTILE = 0.25
W_MARKET = 0.15

# Market size curve anchors
MARKET_POP_REF = 250_000
MARKET_POP_MAX = 10_000_000

# POI density anomaly threshold (places per 10k residents). Well-covered
# cities run 100-650 places per 10k; below ~50 the map data is clearly thin
# and every count is a lower bound (e.g. Gomel: 45, Tbilisi: 203, Milan: 651).
MIN_PLACES_PER_10K = 50.0

# Business types that are not entrepreneurial opportunities (you cannot open
# one), so they must never be presented as a gap or a Blue Ocean.
NON_STARTABLE_CATEGORIES = {"atm"}

# Bump when matching/scoring logic changes to invalidate cached analyses and
# opportunity scans (old cached results would otherwise stay stale for weeks).
LOGIC_VERSION = "2026-08-18.1"

# Jobs
JOB_MAX_WORKERS = int(os.environ.get("BLUEOCEAN_JOB_WORKERS", "2"))

# Nominatim politeness
NOMINATIM_MIN_INTERVAL = float(os.environ.get("BLUEOCEAN_NOMINATIM_INTERVAL", "1.0"))

# Validation datasets allowed in OSM agreement check
OSM_VALIDATION_KEYS = ("shop", "amenity", "leisure", "tourism", "office", "craft")

# Export
EXPORT_DIR = DATA_DIR / "exports"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


def parse_float_list(value: str) -> list[float] | None:
    try:
        return [float(x) for x in json.loads(value)]
    except Exception:
        return None
