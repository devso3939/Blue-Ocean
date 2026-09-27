-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.108: Drop unread cache telemetry                ║
-- ║ Audit of the v6.9.105/106 caching work found that both counters   ║
-- ║ (hits, n_results) are written on every get/put but read by        ║
-- ║ NOTHING — no RPC, no dashboard, no client. Pure write cost: the   ║
-- ║ gets pay an extra UPDATE per cache HIT (the hottest path) and     ║
-- ║ the puts materialize a derived column on every upsert.            ║
-- ║ Migration 018 removes them and rewrites the 4 RPCs without the    ║
-- ║ dead bookkeeping. Contracts otherwise unchanged:                  ║
-- ║   • gets return jsonb {results, fetched_at} | null                ║
-- ║   • puts return text 'ok' | 'skip' (NOT void — PostgREST          ║
-- ║     scalar-void breaks the client's res.json(); v6.9.92b lesson)  ║
-- ║   • lane put guard, TTLs, RLS and grants all preserved            ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Brave query cache (016) ─────────────────────────────────────────
create or replace function public.rpc_brave_cache_get(p_q text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_norm  text;
  v_res   jsonb;
  v_at    timestamptz;
begin
  if p_q is null or length(btrim(p_q)) = 0 then return null; end if;
  v_norm := lower(btrim(regexp_replace(p_q, '\s+', ' ', 'g')));
  select results, fetched_at into v_res, v_at
    from public._brave_qcache where q_norm = v_norm limit 1;
  if not found then return null; end if;
  -- 14-day TTL: business contact pages drift slowly; anything older is
  -- treated as a miss and refreshed by the next live search.
  if v_at < now() - interval '14 days' then return null; end if;
  return jsonb_build_object('results', v_res, 'fetched_at', v_at);
end $$;

create or replace function public.rpc_brave_cache_put(p_q text, p_results jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_norm text;
begin
  if p_q is null or length(btrim(p_q)) = 0 then return 'skip'; end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array'
     or jsonb_array_length(p_results) = 0 then return 'skip'; end if;
  v_norm := lower(btrim(regexp_replace(p_q, '\s+', ' ', 'g')));
  insert into public._brave_qcache (q_norm, results, fetched_at)
  values (v_norm, p_results, now())
  on conflict (q_norm) do update
    set results    = excluded.results,
        fetched_at = now();
  return 'ok';
end $$;

-- ── Shared lane cache (017) ─────────────────────────────────────────
create or replace function public.rpc_lane_cache_get(p_lane text, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_norm text;
  v_ttl  interval;
  v_res  jsonb;
  v_at   timestamptz;
begin
  if p_lane is null or p_key is null or length(btrim(p_key)) = 0 then return null; end if;
  v_norm := lower(btrim(regexp_replace(p_key, '\s+', ' ', 'g')));
  v_ttl := case p_lane when 'geocode' then interval '30 days' else interval '3 days' end;
  select results, fetched_at into v_res, v_at
    from public._lane_cache
    where lane = p_lane and key_norm = v_norm limit 1;
  if not found then return null; end if;
  if v_at < now() - v_ttl then return null; end if;
  return jsonb_build_object('results', v_res, 'fetched_at', v_at);
end $$;

create or replace function public.rpc_lane_cache_put(p_lane text, p_key text, p_results jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_norm text;
begin
  if p_lane not in ('bing', 'ddg', 'geocode') then return 'skip'; end if;
  if p_key is null or length(btrim(p_key)) = 0 then return 'skip'; end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array'
     or jsonb_array_length(p_results) = 0 then return 'skip'; end if;
  v_norm := lower(btrim(regexp_replace(p_key, '\s+', ' ', 'g')));
  insert into public._lane_cache (lane, key_norm, results, fetched_at)
  values (p_lane, v_norm, p_results, now())
  on conflict (lane, key_norm) do update
    set results    = excluded.results,
        fetched_at = now();
  return 'ok';
end $$;

-- ── Column drops (last: the rewritten functions above no longer      ──
-- ── reference them)                                                  ──
alter table public._brave_qcache
  drop column if exists n_results,
  drop column if exists hits;
alter table public._lane_cache
  drop column if exists n_results,
  drop column if exists hits;

-- ── Grants unchanged (explicit, in case of create-or-replace drift) ──
revoke all on function public.rpc_brave_cache_get(text) from public;
grant execute on function public.rpc_brave_cache_get(text) to anon, authenticated;
revoke all on function public.rpc_brave_cache_put(text, jsonb) from public;
grant execute on function public.rpc_brave_cache_put(text, jsonb) to anon, authenticated;
revoke all on function public.rpc_lane_cache_get(text, text) from public;
grant execute on function public.rpc_lane_cache_get(text, text) to anon, authenticated;
revoke all on function public.rpc_lane_cache_put(text, text, jsonb) from public;
grant execute on function public.rpc_lane_cache_put(text, text, jsonb) to anon, authenticated;
