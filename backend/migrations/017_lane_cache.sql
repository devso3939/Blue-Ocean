-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.106: Shared LANE cache (Bing / DDG / geocodes)  ║
-- ║ Companion to the Brave query cache (016): expensive per-scan work ║
-- ║ that repeats across scans/devices is stored once and served for   ║
-- ║ free afterwards. Lanes + TTLs (enforced on read):                 ║
-- ║   bing / ddg — 3 days (search index drift; also caps staleness    ║
-- ║                if an engine served junk before a block lifted)    ║
-- ║   geocode   — 30 days (street addresses are stable)               ║
-- ║ Only NON-EMPTY results are stored (a challenge/block page is not  ║
-- ║ a cacheable answer — same lesson as the v6.9.26 Overpass purge).  ║
-- ╚══════════════════════════════════════════════════════════════════╝

create table if not exists public._lane_cache (
  lane       text not null,
  key_norm   text not null,
  results    jsonb not null,
  n_results  int not null default 0,
  fetched_at timestamptz not null default now(),
  hits       int not null default 0,
  primary key (lane, key_norm)
);
alter table public._lane_cache enable row level security;

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
  v_row  public._lane_cache%rowtype;
begin
  if p_lane is null or p_key is null or length(btrim(p_key)) = 0 then return null; end if;
  v_norm := lower(btrim(regexp_replace(p_key, '\s+', ' ', 'g')));
  v_ttl := case p_lane when 'geocode' then interval '30 days' else interval '3 days' end;
  select * into v_row from public._lane_cache
    where lane = p_lane and key_norm = v_norm limit 1;
  if not found then return null; end if;
  if v_row.fetched_at < now() - v_ttl then return null; end if;
  update public._lane_cache set hits = hits + 1
    where lane = p_lane and key_norm = v_norm;
  return jsonb_build_object('results', v_row.results, 'fetched_at', v_row.fetched_at);
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
  insert into public._lane_cache (lane, key_norm, results, n_results, fetched_at)
  values (p_lane, v_norm, p_results, jsonb_array_length(p_results), now())
  on conflict (lane, key_norm) do update
    set results    = excluded.results,
        n_results  = excluded.n_results,
        fetched_at = now();
  return 'ok';
end $$;

revoke all on function public.rpc_lane_cache_get(text, text) from public;
grant execute on function public.rpc_lane_cache_get(text, text) to anon, authenticated;
revoke all on function public.rpc_lane_cache_put(text, text, jsonb) from public;
grant execute on function public.rpc_lane_cache_put(text, text, jsonb) to anon, authenticated;
