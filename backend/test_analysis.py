import sys
import time

sys.path.insert(0, ".")
from app.cache import cache
from app.providers.city import CityResolver
from app.services import analysis as analysis_service

for k in ["city_metadata:georgia:tbilisi", "city:tbilisi-ge", "city_snapshot:tbilisi-ge",
          "peer_set:tbilisi-ge", "density_grid:tbilisi-ge"]:
    cache.delete(k)

resolver = CityResolver()
city = resolver.resolve("Georgia", "Tbilisi")
print("CITY:", city.display_name, "| id:", city.city_id, "| boundary:", city.boundary_type,
      "| pop:", city.population, city.population_year)
print("  bbox:", {k: round(v, 3) for k, v in city.bbox.items()})

def progress(stage, frac, msg):
    print(f"  [{frac*100:5.1f}%] {stage}: {msg}", flush=True)

t0 = time.time()
analysis = analysis_service.analyze_category("tbilisi-ge", "pet_groomer", progress=progress)
print(f"\nANALYSIS DONE in {time.time()-t0:.1f}s, id={analysis.analysis_id}")

s = analysis.stats
print("\n=== PET GROOMING IN TBILISI ===")
print("existing:", s.count, "| per_10k:", s.per_10k)
print("benchmark per_10k:", s.expected_per_10k, "| expected:", s.expected_count)
print("gap:", s.gap, "| gap_pct:", s.gap_pct)
print("score:", s.opportunity_score, f"({s.score_label})")
print("components:", s.score_components)
print("confidence:", s.data_confidence)
print("peers:")
for p in analysis.peers:
    per = f"{p.per_10k:.3f}" if p.per_10k is not None else "n/a"
    print(f"  - {p.name} ({p.country}): pop={p.population}, count={p.count}, per_10k={per}, ready={p.snapshot_ready}, boundary={p.boundary_type}, note={p.note}")
print("\nwarnings:", s.warnings)
print("\nEXPLANATION:", s.explanation[:400], "...")
print("\nplaces:", len(analysis.places), "| density cells:", len(analysis.density_grid))
