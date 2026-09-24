-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.105: Cross-scan Brave QUERY RESULT CACHE        ║
-- ║ The key pool fixed WHO pays; this fixes HOW OFTEN anyone pays.    ║
-- ║ A Brave query costs quota only the FIRST time any device runs it. ║
-- ║ Results are normalized-query keyed and shared across every scan   ║
-- ║ and device: the retry ladder's duplicate re-searches, rescans of  ║
-- ║ the same city/category, and fresh browser profiles all become     ║
-- ║ zero-quota cache hits.                                            ║
-- ║   • TTL 14 days (client-enforced on read; rows refresh on put)    ║
-- ║   • rows are tiny (~2-4 KB each); ≤350 unique queries per scan    ║
-- ║   • access ONLY through the RPCs (RLS on, no direct table grants) ║
-- ╚══════════════════════════════════════════════════════════════════╝

create table if not exists public._brave_qcache (
  q_norm     text primary key,        -- lowercased, whitespace-collapsed query
  results    jsonb not null,          -- [{title,url,description},...]
  n_results  int    not null,
  fetched_at timestamptz not null default now(),
  hits       int    not null default 0  -- telemetry: cache payoff counter
);
alter table public._brave_qcache enable row level security;

-- ── GET: null = miss/stale (caller goes live and backfills via PUT) ──
create or replace function public.rpc_brave_cache_get(p_q text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_norm text;
  v_row  public._brave_qcache%rowtype;
begin
  if p_q is null or length(btrim(p_q)) = 0 then return null; end if;
  v_norm := lower(btrim(regexp_replace(p_q, '\s+', ' ', 'g')));
  select * into v_row from public._brave_qcache where q_norm = v_norm limit 1;
  if not found then return null; end if;
  -- 14-day TTL: business contact pages drift slowly; anything older is
  -- treated as a miss and refreshed by the next live search.
  if v_row.fetched_at < now() - interval '14 days' then return null; end if;
  update public._brave_qcache set hits = hits + 1 where q_norm = v_norm;
  return jsonb_build_object('results', v_row.results, 'fetched_at', v_row.fetched_at);
end $$;

-- ── PUT: upsert after a LIVE search (returns text 'ok' — PostgREST
--    scalar-void responses break the client's res.json(); see v6.9.92b) ──
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
  insert into public._brave_qcache (q_norm, results, n_results, fetched_at)
  values (v_norm, p_results, jsonb_array_length(p_results), now())
  on conflict (q_norm) do update
    set results    = excluded.results,
        n_results  = excluded.n_results,
        fetched_at = now();
  return 'ok';
end $$;

revoke all on function public.rpc_brave_cache_get(text) from public;
grant execute on function public.rpc_brave_cache_get(text) to anon, authenticated;
revoke all on function public.rpc_brave_cache_put(text, jsonb) from public;
grant execute on function public.rpc_brave_cache_put(text, jsonb) to anon, authenticated;
