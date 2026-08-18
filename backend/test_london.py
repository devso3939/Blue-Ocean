import sys
import time

sys.path.insert(0, ".")
from app.cache import cache
from app.providers.city import CityResolver
from app.services import analysis as analysis_service

for k in ["city_metadata:united kingdom:london", "city:london-gb"]:
    cache.delete(k)

resolver = CityResolver()
city = resolver.resolve("United Kingdom", "London")
print("CITY:", city.display_name, "| id:", city.city_id, "| boundary:", city.boundary_type,
      "| pop:", city.population, city.population_year)

def progress(stage, frac, msg):
    print(f"  [{frac*100:5.1f}%] {stage}: {msg}", flush=True)

t0 = time.time()
a = analysis_service.analyze_category("london-gb", "gym", progress=progress)
print(f"\nDONE in {time.time()-t0:.1f}s")
s = a.stats
print(f"=== GYM IN LONDON === existing={s.count} per10k={s.per_10k} bench={s.expected_per_10k} "
      f"expected={s.expected_count} gap={s.gap} score={s.opportunity_score} ({s.score_label}) conf={s.data_confidence}")
print("peers:")
for p in a.peers:
    per = f"{p.per_10k:.3f}" if p.per_10k is not None else "n/a"
    print(f"  - {p.name} ({p.country}): pop={p.population}, count={p.count}, per10k={per}, ready={p.snapshot_ready}, note={p.note}")
