"""End-to-end live pipeline test: resolve_city -> opportunities -> analyze -> exports.

Run from backend/ with the venv python while uvicorn serves on 127.0.0.1:8010.
Prints a full report; exits non-zero on failure.
"""
import json
import sys
import time

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8010/api"
COUNTRY = "Georgia"
CITY = "Tbilisi"

client = httpx.Client(timeout=60.0)


def run_job(kind: str, payload: dict, timeout_s: int = 1800) -> dict:
    r = client.post(f"{BASE}/jobs", json={"kind": kind, "payload": payload})
    r.raise_for_status()
    job_id = r.json()["job_id"]
    print(f"[job {job_id}] {kind} {payload}")
    t0 = time.time()
    last = None
    while True:
        time.sleep(3)
        j = client.get(f"{BASE}/jobs/{job_id}")
        j.raise_for_status()
        d = j.json()
        line = f"  {d['status']:8s} {d['stage']:12s} {round(d['progress']*100):3d}% {d.get('message') or ''}"
        if line != last:
            print(line)
            last = line
        if d["status"] == "done":
            print(f"  done in {time.time()-t0:.0f}s")
            return d.get("result") or {}
        if d["status"] == "error":
            raise RuntimeError(f"job {kind} failed: {d.get('error')}")
        if time.time() - t0 > timeout_s:
            raise TimeoutError(f"job {kind} timed out after {timeout_s}s")


def main() -> int:
    print("== health ==")
    print(client.get(f"{BASE}/health").json())

    print(f"\n== resolve_city: {CITY}, {COUNTRY} ==")
    res = run_job("resolve_city", {"country": COUNTRY, "city": CITY})
    city_id = res.get("city_id")
    print("city_id:", city_id)
    if not city_id:
        raise RuntimeError("no city_id")
    city = client.get(f"{BASE}/city/{city_id}").json()
    print("population:", city.get("population"), "| boundary:", city.get("boundary_type"),
          "| qid:", city.get("wikidata_qid"))

    print("\n== opportunities scan (snapshot + peers + scoring; heavy) ==")
    opps = run_job("opportunities", {"city_id": city_id})
    rows = opps.get("rows") or []
    print(f"total_places: {opps.get('snapshot', {}).get('total_places')}")
    print(f"rows returned: {len(rows)}")
    emails_shown = 0
    for r in rows[:10]:
        print(f"  #{r.get('rank')} {r.get('label'):30s} score={r.get('score')} gap={r.get('gap')} "
              f"conf={r.get('confidence')} existing={r.get('existing')}")
    if not rows:
        raise RuntimeError("opportunity scan returned zero rows")

    print("\n== single category analysis ==")
    cat = rows[0].get("category_id") or rows[0].get("category")
    if not cat:
        cats = client.get(f"{BASE}/categories", params={"popular": "true"}).json()
        cat = cats[0]["id"]
    print("category:", cat)
    analysis = run_job("analyze", {"city_id": city_id, "category_id": cat})
    aid = analysis.get("analysis_id")
    stats = analysis.get("stats") or {}
    print("analysis_id:", aid)
    print("score:", stats.get("opportunity_score"), "| label:", stats.get("score_label"),
          "| gap:", stats.get("gap"), "| confidence:", stats.get("data_confidence"))
    print("peers:", [(p.get("name"), p.get("count")) for p in (analysis.get("peers") or [])])
    print("has market context:", bool(analysis.get("market")))
    print("demand in methodology:", bool((analysis.get("methodology") or {}).get("demand_detection")))
    print("ai_insight present:", bool(stats.get("ai_insight")))
    print("ai_insight preview:", (stats.get("ai_insight") or "")[:200])

    print("\n== exports ==")
    for url, want in [
        (f"{BASE}/analysis/{aid}/export?format=csv", "text/csv"),
        (f"{BASE}/analysis/{aid}/export?format=xlsx", "spreadsheet"),
        (f"{BASE}/opportunities/{city_id}/export?format=csv", "text/csv"),
    ]:
        er = client.get(url)
        print(f"  {url.split('/api/')[1][:60]:60s} -> {er.status_code} {er.headers.get('content-type', '')[:40]} {len(er.content)}b")
        er.raise_for_status()

    print("\nE2E PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\nE2E FAIL: {type(e).__name__}: {e}")
        sys.exit(1)
