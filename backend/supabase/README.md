# Blue Ocean — Supabase Backend (Postgres-native API)

The FastAPI/Fly.io backend has been **fully migrated into Supabase**.
The entire API surface now lives in Postgres 17: reference data reads,
job queue, async workers, and analysis/scoring logic — all as SQL.

## Architecture

```
Browser ──PostgREST RPC──▶ public.api_* (thin wrappers)
                              │
                              ▼
                          bo.* schema (tables + logic)
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        pg_cron worker   pg_net (async)   extensions.http
        (every 5 s)      Overpass fetch   Wikidata/Nominatim/
        resolve/score    (no 5 s cap)     World Bank calls
```

**Modern platform features used:**
- **Postgres 17.6** — all business logic in PL/pgSQL
- **pg_cron** — 5-second job dispatcher + response poller + nightly cleanup
- **pg_net** — async HTTP with real timeouts (Overpass scans take 60s+,
  impossible with the sync `http` extension's 5s cap)
- **PostgREST 14** — the public REST API (zero application servers)
- **Job queue on Postgres** — `FOR UPDATE SKIP LOCKED` pattern replaces
  the SQLite JobManager
- **World Bank market context** fetched live from inside Postgres

## API surface (PostgREST RPCs)

| FastAPI endpoint | Supabase RPC |
|---|---|
| `GET /api/health` | `rpc api_health` |
| `GET /api/config` | `rpc api_config` |
| `GET /api/countries` | `rpc api_countries` |
| `GET /api/families` | `rpc api_families` |
| `GET /api/categories` | `rpc api_categories` |
| `GET /api/city/{id}` | `rpc api_city` |
| `GET /api/opportunities/{id}` | `rpc api_opportunities` |
| `GET /api/opportunities/{id}/export` | `rpc api_opportunities_export` |
| `GET /api/analysis/{id}` | `rpc api_analysis` |
| `GET /api/analysis/{id}/export` | `rpc api_analysis_export` |
| `GET /api/market` | `rpc api_market` |
| `POST /api/jobs` | `rpc submit_job` |
| `GET /api/jobs/{id}` | `rpc api_job` |

Job kinds: `resolve_city`, `snapshot`, `opportunities`, `analyze`.

## Migrations (apply in order)

`psql` files in `migrations/` — 001 schema → 010 cleanup → 011 analyses/market.
Helpers used to apply them: `backend/db_tool.py "<sql>"` (uses `backend/.env`).

Seed data: `seed.py` (taxonomy + countries), `seed_peers.py` (99-city peer pool).

## Environment

- `backend/.env` — `SUPABASE_URL`, service `SECRET_KEY` (gitignored)
- `frontend/.env.local` — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Security model

- **anon/authenticated**: execute on `public.api_*` RPCs + read on reference tables
- **service_role**: full access; only used for migrations/seeding
- The publishable key in the browser can **submit jobs and read results** but
  cannot mutate reference data (RLS-enforced)

## Verified end-to-end (2026-09-09)

- Tbilisi: 68 ranked opportunities, 5 live peers, 8 anomaly warnings
- Batumi (fresh city): resolve 5s → snapshot 72s (Overpass via pg_net) →
  68 opportunities in 15s
- `analyze` stores a full `MarketAnalysis` (626 cafes, density grid, World
  Bank market context, score + label) retrievable by `analysis_id`
