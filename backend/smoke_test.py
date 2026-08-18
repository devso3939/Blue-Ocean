import sys
import time

sys.path.insert(0, ".")
from app.cache import cache
from app.providers.city import CityResolver
from app.services import snapshot as snap

# clear stale cache from earlier runs
for k in [
    "city_metadata:georgia:tbilisi", "city:-ge", "city_snapshot:-ge",
    "city_snapshot:tbilisi-ge", "density_grid:tbilisi-ge", "peer_set:-ge",
    "wikidata:pop_osm:1996871",
]:
    cache.delete(k)

t0 = time.time()
resolver = CityResolver()
city = resolver.resolve("Georgia", "Tbilisi")
print(f"RESOLVED {city.display_name} in {time.time()-t0:.1f}s")
print("  city_id:", city.city_id, "| osm:", city.osm_type, city.osm_id)
print("  center:", city.center, "| bbox:", city.bbox)
print("  boundary type:", city.boundary_type)
print("  population:", city.population, city.population_year, "|", city.population_source)
print("  note:", city.population_note)

t0 = time.time()
meta = snap.get_or_build_snapshot(city, force=True)
print(f"\nSNAPSHOT in {time.time()-t0:.1f}s")
print("  release:", meta.overture_release, "| total places:", meta.total_places)
print("  filter stats:", meta.filter_stats.model_dump())
print("  quality:", {k: v for k, v in meta.source_quality.items() if k != "datasets_used"})
print("  top leaf:", sorted(meta.leaf_counts.items(), key=lambda kv: -kv[1])[:12])
print("  osm validation:", meta.osm_validation)
