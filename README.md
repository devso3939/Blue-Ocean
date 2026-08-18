# Blue Ocean — Market Gap Intelligence

**Find what your city is missing.**

A web application that identifies business supply gaps and potential *Blue Ocean* opportunities in cities anywhere in the world — using **real open geodata**, not mock statistics.

> Not “127 restaurants.” Instead: *0.32 restaurants per 10,000 residents vs a peer benchmark of 0.95 — an estimated supply gap of ~80 businesses, Opportunity Score 88/100.*

## What it does

- **Analyze an Industry** — Country → City → Industry. Detects the real businesses from Overture Maps, filters them to the city boundary, normalizes by population, benchmarks against automatically-selected comparable cities, and computes a deterministic **Opportunity Score (0–100)** plus a separate **Data Confidence Score (0–100)**.
- **Discover Opportunities** — pick just Country + City and get a ranked list of the most underserved commercial categories, with existing/expected/gap counts, scores and confidence. Click any row to drill into its full analysis.
- **Competition Map** — every detected business as a real geographic point (MapLibre GL), with clustering, a density heatmap, the city boundary and business popups (name, category, address, brand, website, phone, **email**, social, Google Maps / OSM links, confidence).
- **Market Context** — real World Bank country economics (GDP, growth, inflation, unemployment, labour force, inequality, life expectancy, internet/mobile penetration, urbanisation, business registration), a transparent *potential buyer score*, and a startup-cost estimate (wages, rent, fit-out, equipment, 6-month working capital + an estimated payback period) with every assumption shown. Every indicator has a **fallback chain**, so cards rarely show n/a.
- **Full transparency** — every page explains how each number was computed. Peers are always listed, data-poor peers are flagged and excluded, and missing data lowers confidence instead of being dressed up as opportunity. **Cities with sparse map coverage (fewer than 50 places per 10,000 residents) are flagged loudly, confidence is capped at 60, and counts are labelled a lower bound** — e.g. Gomel, Belarus has 45/10k vs Tbilisi's 203 and Milan's 651, so its “0 coworking spaces” is presented with an explicit “cross-check on Google Maps” warning, not as a fact.
- **Recheck data** — one click re-fetches the city snapshot from source (bypasses the cache) on both the analysis and opportunities pages.
- **Emails everywhere** — business emails from Overture appear in the table, map popups and the Excel/CSV exports (Tbilisi pet groomers: 21 of 40 have emails).

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | Next.js 14 (App Router) · React · TypeScript · Tailwind CSS · shadcn-style UI · MapLibre GL · Recharts |
| Backend | Python · FastAPI · Pydantic |
| Geodata | DuckDB + httpfs reading Overture Maps GeoParquet directly from S3 (current release, discovered via STAC) · Shapely for spatial containment · SQLite cache |
| Sources | **Overture Maps Places** (POI data, primary) · **Wikidata** (city resolution, population, country list) · **OpenStreetMap/Nominatim** (boundaries) · **Overpass** (optional coverage cross-check, degrades gracefully) |

No Google Maps API keys, no scraping, no paid APIs. Adding a `GooglePlacesProvider` later is a matter of implementing the existing provider interface.

## Architecture

```
frontend/            Next.js app (proxies /api/* to the backend)
backend/app/
  config.py          TTLs, analysis parameters, endpoints (env-overridable)
  cache.py           SQLite key-value cache with per-key TTLs
  countries.py       Country list from Wikidata (cached)
  taxonomy.py        Category system: labels, families, aliases, search
  models.py          Pydantic models (CityMeta, SnapshotMeta, MarketAnalysis…)
  providers/
    city.py          City resolution: Wikidata-first + Nominatim boundary enhancer
    population.py    Wikidata population + city search
    overture.py      DuckDB queries against Overture GeoParquet (bbox → containment)
    divisions.py     Overture divisions theme for candidate peer cities
    osm.py           Overpass coverage cross-check (best-effort, non-blocking)
  services/
    snapshot.py      City pipeline: download once → filter → dedupe → categorize → cache
    peers.py         Peer selection: same-country 0.5–2× pop → 0.33–3× → regional international
    analysis.py      Stats, weighted-median benchmark, gap, Opportunity & Confidence scores
    opportunities.py Category scan across the whole taxonomy
  main.py            FastAPI app + job manager (progress states) + exports
```

### Data pipeline (per city)

1. **Resolve** the city (Wikidata; Nominatim adds a real administrative polygon when reachable).
2. **Download** Overture places intersecting a bbox (never the whole dataset).
3. **Contain**: `ST_Within` / point-in-polygon against the city boundary (bbox fallback, widened).
4. **Clean**: drop permanently closed POIs, invalid geometry, duplicates, very low-confidence records.
5. **Categorize** into the Overture taxonomy with user-friendly labels and families. Matching is smarter than id-equality: category *equivalents* (e.g. coworking_space ↔ shared_office_space) and distinctive **name signals** recover businesses a pure taxonomy match would skip. Beyond the curated static patterns (e.g. “Коворкинг …” still counts as coworking), the system **learns new signals per city** from its own data: it extracts words and word-pairs that are strongly over-represented in a category's already-matched places (including local-language equivalents — Tbilisi learns “გრუმინგი”, “კაფე”, “რესტორანი”), then applies them only to generically-tagged places in the same family. Precision is guarded three ways: weak words (pet, dog, salon, studio…) are never learned standalone, tokens shared with other specific business types are dropped, and a learned signal never overrides a place's own specific category. The analysis page shows how many places were found this way (e.g. “45 · 5 by learned name signals”). **Learning is live and regional**: every city publishes its learned signals to shared country and language buckets, and every analysis merges its own signals with what its country/language have already learned — so a Georgian signal learned in Tbilisi applies to Batumi and Kutaisi immediately, with no waiting for each city to re-learn it (a digest check re-applies signals whenever the regional set changes).
6. **Cache** the City Snapshot (14-day TTL) so switching category costs nothing.
7. **Coverage gate** — cities below 50 places/10k residents are marked sparse: confidence is capped at 60 and every count is explicitly a lower bound.
8. **Market context** — World Bank indicators for the country (cached 7 days) + derived buyer score + transparent startup-cost estimate are attached to each analysis.

### Scoring (deterministic, no LLM involvement)

```
per_10k = count / population × 10,000
benchmark = weighted median of peer per_10k (weights favour similar population)
expected = benchmark × target_population / 10,000
gap = expected − existing

Opportunity Score = 0.60 × supplyGapScore
                  + 0.25 × undersupplyPercentile
                  + 0.15 × marketSizeScore      (log-scaled population)
```

Interpretation: 90+ Exceptional Gap · 80–89 Very Strong · 70–79 Strong · 60–69 Potential · 45–59 Balanced · 30–44 Competitive · 0–29 Saturated.

**Data Confidence** is a separate score covering POI coverage, category validity, Overture/OSM agreement, population availability & recency, boundary quality, peer count and peer consistency. Zero-detected categories are never sold as Blue Ocean — low coverage drops confidence, caps it at 60 for sparse cities, and raises warnings.

### Market context (World Bank, free API)

Real indicators per country, grouped thematically in the UI: **Economy** (GDP PPP, GDP growth, GDP per capita PPP, GNI per capita PPP, inflation, government revenue), **People & workforce** (population, working-age share, labour-force participation, unemployment, urbanisation, life expectancy, inequality/Gini) and **Digital & new business** (internet users, mobile subscriptions, new businesses registered, secondary enrolment). The Doing Business series was archived by the World Bank after 2020, so it is deliberately not shown. Every indicator has a **fallback chain** (e.g. when tax revenue is unpublished, the nearest published revenue series is shown and flagged), so cards rarely show n/a; when a country genuinely doesn't publish a series, the tile says “not published for this country” instead of a bare n/a. A **buyer potential score** (0–100) combines market size, purchasing power, demographics and digital reach with the formula shown. The **startup estimate** gives clearly-labelled estimates for wage/rent/fit-out/equipment with 6 months of working capital included, plus an **estimated payback period** derived from assumed revenue (4× monthly costs) and a 35% operating margin — every assumption is listed in the UI.

## Running it

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # or: pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010
```

This machine has no system Python/Node, so this workspace uses self-contained runtimes in `.tools/` (Python extracted into `.tools/python`, Node into `.tools/node`) with the venv at `backend/.venv`. Delete `.tools` to remove them entirely.

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000 (proxies /api → http://127.0.0.1:8010)
```

`BACKEND_URL` env var overrides the proxy target. First analysis of a city downloads its POI snapshot and peer snapshots — a few minutes. Everything after that is cached (SQLite, per-key TTLs), so repeat analyses are fast.

### Environment variables (all optional)

`BLUEOCEAN_TTL_*` (per-cache TTLs), `BLUEOCEAN_NOMINATIM_URL`, `BLUEOCEAN_WIKidata_URL`, `BLUEOCEAN_OVERPASS_URLS`, `BLUEOCEAN_JOB_WORKERS`, `BLUEOCEAN_NOMINATIM_INTERVAL`, `BACKEND_URL` (frontend).

## API

```
GET  /api/health
GET  /api/countries
GET  /api/cities/search?q=&country=
GET  /api/categories?q= | ?family= | ?popular=true
GET  /api/families
POST /api/jobs                     {kind: resolve_city|snapshot|analyze|opportunities, payload}
GET  /api/jobs/{id}                progress states: resolving → loading → categorizing → peers → analyzing
GET  /api/city/{city_id}
GET  /api/analysis/{analysis_id}
GET  /api/analysis/{id}/export?format=json|csv|xlsx   (includes email column)
GET  /api/opportunities/{city_id}
GET  /api/opportunities/{city_id}/export
GET  /api/market?city_id=&category=&refresh=
```

Job payloads accept `"refresh": true` on `analyze` / `opportunities` to re-fetch the city snapshot (the “Recheck data” button).

## Test cases (verified with real data)

- Tbilisi, Georgia — Pet Grooming → **45 detected (5 by learned Georgian name signals), 0.36/10k** (peers include Batumi, Kutaisi, Rustavi + regional fallbacks; sparse-coverage peers flagged)
- Tbilisi, Georgia — Restaurant / Gym / Hair Salon / Grocery / Bar → distinct, plausible scores (hotels correctly show oversupply)
- Gomel, Belarus — Coworking Space → **0 detected in open data (Overture has zero coworking records for Gomel; Google Maps shows 3 proprietary listings)** → the analysis is flagged `sparse_coverage`, confidence capped at 60, with an explicit cross-check warning instead of an unqualified opportunity
- Batumi, Georgia — Cafe → in-country peers too data-poor, international fallback to similar-size Turkish cities; gap +35, score 66
- London, UK — Gym → in-country + international peers after data-quality filtering
- Discover mode (Tbilisi) → 48 ranked categories; Pet Grooming matches the single-category analysis exactly
- **Live regional learning** — Batumi inherits Tbilisi's Georgian signals (beauty-salon names in Georgian script, hotel/restaurant/cafe signals) immediately on its own analysis

## Deployment (Pre-Prod)

### Frontend (GitHub Pages)

The frontend is deployed automatically via GitHub Actions when you push to the `main` branch:

1. Go to your repository Settings → Pages
2. Set Source to "GitHub Actions"
3. Push to `main` — the workflow will build and deploy
4. Your frontend will be available at: `https://devso3939.github.io/Blue-Ocean/`

**Note**: The frontend requires a running backend. Set the `NEXT_PUBLIC_API_URL` environment variable in the workflow to point to your backend URL.

### Backend (Render.com)

1. Create a free account at [render.com](https://render.com)
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name**: `blue-ocean-api`
   - **Runtime**: Python
   - **Build Command**: `cd backend && pip install -r requirements.txt`
   - **Start Command**: `cd backend && python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - **Environment Variables**:
     - `PYTHON_VERSION`: `3.12`
     - `BLUEOCEAN_DATA_DIR`: `/data`
5. Add a persistent disk:
   - **Name**: `blue-ocean-data`
   - **Mount Path**: `/data`
   - **Size**: 10 GB
6. Deploy — your backend will be at: `https://blue-ocean-api.onrender.com`

### Local Development

```bash
# Backend
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

## Caveats & honesty

- Boundaries are a real administrative polygon when Nominatim provides one, otherwise a widened bounding box (shown in UI, lowers confidence).
- Overpass is unreachable on some networks — the OSM cross-check is best-effort and never blocks an analysis.
- Some peer cities have sparse Overture coverage; they are excluded from benchmarks with an explicit note.
- **Estimated supply gaps are market intelligence, not guaranteed demand.** Purchasing power, behavior, pricing, regulation and POI coverage must be considered before opening anything.

## Roadmap (phase two)

Neighborhood-level gap analysis · demographics/income/tourism overlays · rent & foot-traffic signals · business survival rates · PDF export · manual peer editing.
