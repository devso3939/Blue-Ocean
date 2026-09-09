#!/usr/bin/env python3
"""Seed bo.countries, bo.families, bo.categories (with OSM filters)
from the existing FastAPI modules + client CAT_OSM_FILTER."""
import sys, json, re
sys.path.insert(0, "backend")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app import taxonomy as T
from app.countries import FALLBACK_COUNTRIES

# Parse CAT_OSM_FILTER from the client engine
src = open("client/src/clientEngine.ts", encoding="utf-8").read()
m = re.search(r"const CAT_OSM_FILTER: Record<string, string> = \{(.*?)\n\};", src, re.S)
osm_filters = {}
if m:
    for line in m.group(1).splitlines():
        fm = re.match(r"\s*(\w+):\s*'(.+?)',?\s*(?://.*)?$", line)
        if fm:
            osm_filters[fm.group(1)] = fm.group(2)
print(f"parsed {len(osm_filters)} OSM filters, {len(FALLBACK_COUNTRIES)} countries, {len(T.all_categories())} categories")

def q(s):
    if s is None: return "null"
    return "'" + s.replace("'", "''") + "'"

def qa(arr):
    if not arr: return "'{}'"
    return "array[" + ",".join(q(a) for a in arr) + "]"

lines = []
# countries (region overrides like FastAPI)
REGION_OVERRIDES = {"GE": "Europe", "AM": "Europe", "AZ": "Europe", "TR": "Europe"}
for c in FALLBACK_COUNTRIES:
    region = REGION_OVERRIDES.get(c["cca2"], c["region"])
    lines.append(f"insert into bo.countries (cca2, name, region) values ({q(c['cca2'])}, {q(c['name'])}, {q(region)}) on conflict (cca2) do update set name = excluded.name, region = excluded.region;")

# families
for i, f in enumerate(T.FAMILIES):
    lines.append(f"insert into bo.families (id, label, description, sort_order) values ({q(f['id'])}, {q(f['label'])}, {q(f.get('description',''))}, {i}) on conflict (id) do update set label = excluded.label, description = excluded.description, sort_order = excluded.sort_order;")

# categories — only those the client actually queries OSM for (fast subset) + popular
cats = T.all_categories()
kept = 0
for c in cats:
    cid = c["id"]
    osm = osm_filters.get(cid)
    popular = cid in T.POPULAR_CATEGORIES
    if osm or popular:
        lines.append(
            f"insert into bo.categories (id, label, family, aliases, popular, osm_filter) "
            f"values ({q(cid)}, {q(c['label'])}, {q(c['family'])}, {qa(c.get('aliases', []))}, {popular}, {q(osm)}) "
            f"on conflict (id) do update set label = excluded.label, family = excluded.family, "
            f"aliases = excluded.aliases, popular = excluded.popular, osm_filter = excluded.osm_filter;")
        kept += 1
print(f"seeding {kept} categories (with OSM filter or popular)")

# curated per-10k benchmarks (from typical city densities; refined by peer scans over time)
BENCH = {
  "cafe": 4.0, "restaurant": 12.0, "fast_food": 3.0, "bar": 2.5, "pub": 1.2,
  "supermarket": 2.2, "grocery": 4.0, "convenience": 6.0, "bakery": 1.8,
  "pharmacy": 1.5, "hospital": 0.08, "clinic": 2.0, "dentist": 1.2,
  "hotel": 1.6, "hostel": 0.5, "gym": 1.6, "beauty_salon": 4.0,
  "hair_salon": 3.2, "nail_salon": 1.0, "spa": 0.6, "massage": 0.7,
  "clothing": 5.0, "electronics": 1.5, "furniture": 0.9, "hardware": 1.1,
  "bookstore": 0.7, "jewelry": 0.9, "sports": 0.7, "bicycle": 0.4,
  "laundry": 0.6, "pet_groomer": 0.4, "veterinary": 0.5, "florist": 0.6,
  "optician": 0.5, "butcher": 0.8, "marketplace": 0.25, "car_repair": 2.0,
  "car_wash": 0.7, "car_rental": 0.25, "fuel": 0.35, "night_club": 0.4,
  "cinema": 0.08, "bank": 1.2, "school": 2.2, "coworking": 0.25,
  "software": 2.5, "web_agency": 0.9, "it_consulting": 1.4,
  "digital_marketing": 1.0, "lawyer": 1.8, "accountant": 1.4,
  "real_estate": 1.6, "insurance": 0.8, "travel_agency": 0.6,
  "cleaning": 0.5, "courier": 0.4, "printing": 0.35, "tattoo": 0.4,
  "wedding": 0.15, "dance": 0.3, "yoga": 0.35, "music_school": 0.35,
  "art": 1.2, "library": 0.08, "post_office": 0.15, "market": 0.8,
}
for cid, v in BENCH.items():
    lines.append(f"insert into bo.category_benchmarks (category_id, per_10k, source) values ({q(cid)}, {v}, 'curated-v1') on conflict (category_id) do update set per_10k = excluded.per_10k, updated_at = now();")

sql = "\n".join(lines)
open("backend/supabase/seed_generated.sql", "w", encoding="utf-8").write(sql)
print(f"wrote backend/supabase/seed_generated.sql ({len(lines)} statements)")
