"""Country list for the UI. Fetched from restcountries (cached 30 days)
with an embedded fallback for common countries."""
from __future__ import annotations

import httpx

from . import config
from .cache import cache

# Region convention: the Caucasus is treated as Europe for peer selection
# (common convention in market analysis; keeps peers in the same market region).
REGION_OVERRIDES = {"GE": "Europe", "AM": "Europe", "AZ": "Europe", "TR": "Europe"}


# Embedded fallback (common + all countries likely to be searched)
FALLBACK_COUNTRIES = [
    {"name": "Albania", "cca2": "AL", "region": "Europe"},
    {"name": "Argentina", "cca2": "AR", "region": "Americas"},
    {"name": "Armenia", "cca2": "AM", "region": "Asia"},
    {"name": "Australia", "cca2": "AU", "region": "Oceania"},
    {"name": "Austria", "cca2": "AT", "region": "Europe"},
    {"name": "Azerbaijan", "cca2": "AZ", "region": "Asia"},
    {"name": "Belarus", "cca2": "BY", "region": "Europe"},
    {"name": "Belgium", "cca2": "BE", "region": "Europe"},
    {"name": "Bosnia and Herzegovina", "cca2": "BA", "region": "Europe"},
    {"name": "Brazil", "cca2": "BR", "region": "Americas"},
    {"name": "Bulgaria", "cca2": "BG", "region": "Europe"},
    {"name": "Canada", "cca2": "CA", "region": "Americas"},
    {"name": "Chile", "cca2": "CL", "region": "Americas"},
    {"name": "China", "cca2": "CN", "region": "Asia"},
    {"name": "Colombia", "cca2": "CO", "region": "Americas"},
    {"name": "Croatia", "cca2": "HR", "region": "Europe"},
    {"name": "Cyprus", "cca2": "CY", "region": "Europe"},
    {"name": "Czechia", "cca2": "CZ", "region": "Europe"},
    {"name": "Denmark", "cca2": "DK", "region": "Europe"},
    {"name": "Egypt", "cca2": "EG", "region": "Africa"},
    {"name": "Estonia", "cca2": "EE", "region": "Europe"},
    {"name": "Finland", "cca2": "FI", "region": "Europe"},
    {"name": "France", "cca2": "FR", "region": "Europe"},
    {"name": "Georgia", "cca2": "GE", "region": "Asia"},
    {"name": "Germany", "cca2": "DE", "region": "Europe"},
    {"name": "Greece", "cca2": "GR", "region": "Europe"},
    {"name": "Hungary", "cca2": "HU", "region": "Europe"},
    {"name": "Iceland", "cca2": "IS", "region": "Europe"},
    {"name": "India", "cca2": "IN", "region": "Asia"},
    {"name": "Indonesia", "cca2": "ID", "region": "Asia"},
    {"name": "Iran", "cca2": "IR", "region": "Asia"},
    {"name": "Ireland", "cca2": "IE", "region": "Europe"},
    {"name": "Israel", "cca2": "IL", "region": "Asia"},
    {"name": "Italy", "cca2": "IT", "region": "Europe"},
    {"name": "Japan", "cca2": "JP", "region": "Asia"},
    {"name": "Kazakhstan", "cca2": "KZ", "region": "Asia"},
    {"name": "Kenya", "cca2": "KE", "region": "Africa"},
    {"name": "Latvia", "cca2": "LV", "region": "Europe"},
    {"name": "Lithuania", "cca2": "LT", "region": "Europe"},
    {"name": "Luxembourg", "cca2": "LU", "region": "Europe"},
    {"name": "Malaysia", "cca2": "MY", "region": "Asia"},
    {"name": "Mexico", "cca2": "MX", "region": "Americas"},
    {"name": "Moldova", "cca2": "MD", "region": "Europe"},
    {"name": "Mongolia", "cca2": "MN", "region": "Asia"},
    {"name": "Montenegro", "cca2": "ME", "region": "Europe"},
    {"name": "Morocco", "cca2": "MA", "region": "Africa"},
    {"name": "Netherlands", "cca2": "NL", "region": "Europe"},
    {"name": "New Zealand", "cca2": "NZ", "region": "Oceania"},
    {"name": "Nigeria", "cca2": "NG", "region": "Africa"},
    {"name": "North Macedonia", "cca2": "MK", "region": "Europe"},
    {"name": "Norway", "cca2": "NO", "region": "Europe"},
    {"name": "Pakistan", "cca2": "PK", "region": "Asia"},
    {"name": "Peru", "cca2": "PE", "region": "Americas"},
    {"name": "Philippines", "cca2": "PH", "region": "Asia"},
    {"name": "Poland", "cca2": "PL", "region": "Europe"},
    {"name": "Portugal", "cca2": "PT", "region": "Europe"},
    {"name": "Romania", "cca2": "RO", "region": "Europe"},
    {"name": "Russia", "cca2": "RU", "region": "Europe"},
    {"name": "Saudi Arabia", "cca2": "SA", "region": "Asia"},
    {"name": "Serbia", "cca2": "RS", "region": "Europe"},
    {"name": "Singapore", "cca2": "SG", "region": "Asia"},
    {"name": "Slovakia", "cca2": "SK", "region": "Europe"},
    {"name": "Slovenia", "cca2": "SI", "region": "Europe"},
    {"name": "South Africa", "cca2": "ZA", "region": "Africa"},
    {"name": "South Korea", "cca2": "KR", "region": "Asia"},
    {"name": "Spain", "cca2": "ES", "region": "Europe"},
    {"name": "Sweden", "cca2": "SE", "region": "Europe"},
    {"name": "Switzerland", "cca2": "CH", "region": "Europe"},
    {"name": "Taiwan", "cca2": "TW", "region": "Asia"},
    {"name": "Thailand", "cca2": "TH", "region": "Asia"},
    {"name": "Türkiye", "cca2": "TR", "region": "Asia"},
    {"name": "Ukraine", "cca2": "UA", "region": "Europe"},
    {"name": "United Arab Emirates", "cca2": "AE", "region": "Asia"},
    {"name": "United Kingdom", "cca2": "GB", "region": "Europe"},
    {"name": "United States", "cca2": "US", "region": "Americas"},
    {"name": "Uruguay", "cca2": "UY", "region": "Americas"},
    {"name": "Uzbekistan", "cca2": "UZ", "region": "Asia"},
    {"name": "Vietnam", "cca2": "VN", "region": "Asia"},
]


def _apply_overrides(countries: list[dict]) -> list[dict]:
    for c in countries:
        cc = c.get("cca2", "").upper()
        if cc in REGION_OVERRIDES:
            c["region"] = REGION_OVERRIDES[cc]
    return countries


def get_countries() -> list[dict]:
    cached = cache.get("countries:list")
    if cached:
        return _apply_overrides(cached)
    try:
        from .providers import population as population_provider
        q = """
SELECT ?country ?name ?cca2 ?region WHERE {
  ?country wdt:P31 wd:Q6256.
  ?country wdt:P297 ?cca2.
  ?country rdfs:label ?name.
  FILTER(LANG(?name) = "en")
  OPTIONAL { ?country wdt:P30 ?cont. ?cont rdfs:label ?region. FILTER(LANG(?region) = "en") }
} ORDER BY ?name LIMIT 300"""
        binds = population_provider._sparql(q, timeout=60) or []
        data = []
        for b in binds:
            name = (b.get("name") or {}).get("value")
            cca2 = (b.get("cca2") or {}).get("value")
            if not name or not cca2:
                continue
            data.append({"name": name, "cca2": cca2, "region": (b.get("region") or {}).get("value", "")})
        if len(data) > 100:
            data.sort(key=lambda c: c["name"])
            data = _apply_overrides(data)
            cache.set("countries:list", data, config.get_ttl("country_list"))
            return data
    except Exception:
        pass
    return _apply_overrides(sorted(FALLBACK_COUNTRIES, key=lambda c: c["name"]))


def country_code_to_name(cca2: str) -> str | None:
    for c in get_countries():
        if c["cca2"].lower() == cca2.lower():
            return c["name"]
    return None


def name_to_country_code(name: str) -> str | None:
    n = name.strip().lower()
    for c in get_countries():
        if c["name"].lower() == n or c["name"].lower().startswith(n):
            return c["cca2"]
    return None
