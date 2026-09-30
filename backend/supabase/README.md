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

## Auth email redirects (GoTrue allow-list)

The client asks GoTrue to return the user to the **exact page** that triggered
an auth email (`email_redirect_to = location.origin + location.pathname`) for:

- password **recovery** links (`/auth/v1/recover`) — the app consumes the
  landing (`#access_token=…&type=recovery`), swaps in a "set a new password"
  form, and scrubs the hash from the address bar;
- **signup confirmation** links (`/auth/v1/signup`) — so confirming lands the
  user back in the app.

GoTrue only honors `email_redirect_to` values that appear in the project's
**Redirect URLs allow-list** (Dashboard → Authentication → URL Configuration →
Redirect URLs). Anything else silently falls back to the **Site URL** default.

**Current state (2026-09-30, FIXED & verified live):** Site URL is
`https://devso3939.github.io/Blue-Ocean/` and the allow-list holds
`https://devso3939.github.io/Blue-Ocean/*` plus
`http://localhost:3199/Blue-Ocean/*`. Probe facts (via `/auth/v1/verify?token=…`):

- requested app path → **honored**; no `redirect_to` param → **Site URL** (app path);
- foreign host → **rejected**, falls back to Site URL;
- **same-host gotcha:** any URL on the Site URL's own host is honored even
  without an allow-list hit — `https://devso3939.github.io/<anything>` passes.
  A request made from a stale tab at the **bare domain** therefore bakes
  `redirect_to=https://devso3939.github.io/` into the email, and that landing
  is a GitHub Pages 404 (no SPA there) with the token stranded in `#hash`.
- stale `http://localhost:3000` links from old emails are now **rejected** →
  GoTrue falls back to the live Site URL, so old emails degrade gracefully to
  an "expired link" panel on the app instead of `ERR_CONNECTION_REFUSED`.

**Bare-root safety net (2026-09-30):** the user-site repo
`devso3939/devso3939.github.io` (Pages at the bare domain) serves a tiny
redirector (`index.html` + `404.html`) that forwards every landing — hash
included — to `/Blue-Ocean/`, where the normal link consumption runs. NOTE:
the forwarder must NOT call `history.replaceState` before `location.replace` —
rewriting the URL first turns the navigation into a same-document no-op and
strands the user (observed in the field; fixed in commit f475636).

**Client hardening (v6.9.119):** `postAuthEmail` detects a bare-root origin
and requests the app path instead, so even a stale tab can no longer bake a
bad redirect into auth emails.

Real-email E2E on the live site (2026-09-30): signup confirmation clicked
from Gmail landed on the live app signed-in; recovery link → set-new-password
panel → old password rejected → new password signs in.

**Required dashboard change** (manual, one-time — no Management API token in
this repo):

1. Supabase Dashboard → project `bfoagnqjkoqhogxvkvkw` →
   **Authentication → URL Configuration → Redirect URLs**.
2. **Add both** `https://devso3939.github.io/Blue-Ocean/` (exact) and
   `https://devso3939.github.io/Blue-Ocean/*` (wildcard — covers the
   query/fragment variants the client requests, e.g. `?recovery` landings).
3. Optionally **remove** `http://localhost:3199` once the above is in place.
4. **Save**, then verify: request a password reset from the live site and
   check the emailed verify link ends with
   `&redirect_to=https://devso3939.github.io/Blue-Ocean/`.

The same list governs magic-link, invite, and (any future) OAuth redirects.

## Local fallback relay (v6.9.118)

When GoTrue cannot honor a link's requested redirect it falls back to the
project **Site URL** — still the default `http://localhost:3000`, which used
to be a dead `ERR_CONNECTION_REFUSED` page. `client/serve_confirm_relay.py`
is a 15-line server that listens on 3000 and 302s every landing (fragment
included, via the browser) to the real app on `http://localhost:3199/Blue-Ocean/`,
where the normal confirmation/recovery consumption runs. Keep it running
alongside `serve_prod.py` whenever auth emails are tested locally:

    python serve_prod.py            # app on :3199
    python serve_confirm_relay.py   # Site-URL fallback relay on :3000

Status as of 2026-09-30: the dashboard fallback no longer points at
localhost (Site URL = the live Pages app), so the relay is only needed when
`redirect_to` explicitly targets `http://localhost:3199/Blue-Ocean/*`. Old
emails with `localhost:3000` links self-heal to the live Site URL (rejected
→ fallback) — no relay required. Keep it running anyway when testing auth
locally so those links keep working offline.
Gotcha discovered en route: GoTrue globs do NOT match across `/`, so a bare
`http://localhost:3199/*` never matches the app's subpath — patterns must be
path-shaped (a stale `http://localhost:3199/*` entry is harmless). The relay
below remains useful whenever a project's Site URL still points at :3000.

## Verified end-to-end (2026-09-09)

- Tbilisi: 68 ranked opportunities, 5 live peers, 8 anomaly warnings
- Batumi (fresh city): resolve 5s → snapshot 72s (Overpass via pg_net) →
  68 opportunities in 15s
- `analyze` stores a full `MarketAnalysis` (626 cafes, density grid, World
  Bank market context, score + label) retrievable by `analysis_id`
