"""Export real businesses (with websites) from the local places store
to JSON for the client-side parsing harness."""
import json
import sqlite3
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

conn = sqlite3.connect("data/places.sqlite")
conn.row_factory = sqlite3.Row

rows = conn.execute(
    """
    SELECT name, lat, lon, leaf_category, address, websites, phones, emails, socials
    FROM places
    WHERE city_id = 'tbilisi-ge'
      AND websites IS NOT NULL AND websites != '[]' AND websites != ''
    ORDER BY confidence DESC
    LIMIT 60
    """
).fetchall()

out = []
for r in rows:
    try:
        urls = json.loads(r["websites"])
    except Exception:
        continue
    if not urls:
        continue
    out.append({
        "name": r["name"],
        "category": r["leaf_category"],
        "address": r["address"] or "",
        "url": urls[0],
        # ground truth from Overture, for comparison
        "known": {
            "phones": json.loads(r["phones"] or "[]"),
            "emails": json.loads(r["emails"] or "[]"),
            "socials": json.loads(r["socials"] or "[]"),
        },
    })

with open("../client/parsing_targets.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print(f"exported {len(out)} businesses with websites -> client/parsing_targets.json")
cats = {}
for o in out:
    cats[o["category"]] = cats.get(o["category"], 0) + 1
print("categories:", dict(sorted(cats.items(), key=lambda kv: -kv[1])[:10]))
