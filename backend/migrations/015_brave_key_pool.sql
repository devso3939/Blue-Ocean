-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.102: Brave key POOL in Vault                    ║
-- ║ The free tier is 1 query/second, 2,000/month PER KEY. A single    ║
-- ║ key hard-stops the whole search-driven discovery lane when its    ║
-- ║ monthly quota dies (http-402). Vault now holds up to 6 keys       ║
-- ║ (bo_brave_api_key, bo_brave_api_key_2 … bo_brave_api_key_6):      ║
-- ║ rpc_brave_start picks the first key whose probe isn't marked      ║
-- ║ dead, and rpc_brave_poll marks a key dead FOR THE SESSION when    ║
-- ║ Brave answers 402 (quota exhausted — nothing recovers it until    ║
-- ║ the provider resets). 429 keeps the key alive (per-second limit,  ║
-- ║ transient). The legacy single-key name stays first so existing    ║
-- ║ Vault installs keep working unchanged.                            ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Session-scoped dead-key memory (survives until the DB session ends) ──
-- Postgres session = one Supabase pooler connection; the client opens fresh
-- connections per RPC so we scope deadness by time instead: a key proven
-- quota-dead is skipped for 24h (longer than Brave's monthly window matters
-- day-to-day, short enough to self-heal after a provider reset).
create table if not exists public._brave_key_health (
  key_name   text primary key,
  dead_until timestamptz not null default to_timestamp(0),
  last_error text,
  updated_at timestamptz not null default now()
);
grant all on public._brave_key_health to anon, authenticated;
-- Public reads are fine (no secrets in this table — only names + timestamps).

-- ── Key picker: first living key from the pool ─────────────────────
create or replace function public._brave_key_for(p_name text)
returns text
language sql
stable
security definer
set search_path = 'public', 'vault'
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1
$$;

create or replace function public._brave_pick_key()
returns text
language plpgsql
volatile
security definer
set search_path = 'public', 'vault'
as $$
declare
  r record;
  v_is_dead boolean;
begin
  for r in
    select pool.key_name from (values
      ('bo_brave_api_key'),
      ('bo_brave_api_key_2'),
      ('bo_brave_api_key_3'),
      ('bo_brave_api_key_4'),
      ('bo_brave_api_key_5'),
      ('bo_brave_api_key_6')
    ) as pool(key_name)
    where exists (select 1 from vault.decrypted_secrets ds where ds.name = pool.key_name)
    order by array_position(array['bo_brave_api_key','bo_brave_api_key_2','bo_brave_api_key_3','bo_brave_api_key_4','bo_brave_api_key_5','bo_brave_api_key_6'], pool.key_name)
  loop
    select dead_until > now() into v_is_dead from public._brave_key_health where key_name = r.key_name;
    if coalesce(v_is_dead, false) then
      continue;   -- skip keys currently marked quota-dead
    end if;
    return r.key_name;
  end loop;
  return null;
end $$;

-- ── Dead-key marker: called from poll when Brave says 402 ──────────
-- We can't know WHICH key was used from the rid alone, so start() records
-- the key name alongside the rid in the same table.
alter table public._brave_key_health add column if not exists last_rid bigint;

create or replace function public._brave_mark_key(p_key_name text, p_dead boolean, p_rid bigint default null, p_err text default null)
returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
begin
  insert into public._brave_key_health (key_name, dead_until, last_error, updated_at, last_rid)
  values (p_key_name, case when p_dead then now() + interval '24 hours' else to_timestamp(0) end, p_err, now(), p_rid)
  on conflict (key_name) do update
    set dead_until = excluded.dead_until,
        last_error = excluded.last_error,
        updated_at = now(),
        last_rid   = coalesce(excluded.last_rid, public._brave_key_health.last_rid);
end $$;

-- ── Rewritten start(): pick a living key, remember which one ───────
create or replace function public.rpc_brave_start(p_query text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rid bigint;
  v_key text;
  v_key_name text;
begin
  if p_query is null or length(btrim(p_query)) = 0 or length(p_query) > 400 then
    return jsonb_build_object('error', 'bad-query');
  end if;
  -- pick key + remember its name (walk the pool manually here so we know
  -- exactly which name goes with the key we used)
  for v_key_name in
    select pool.key_name from (values
      ('bo_brave_api_key'),
      ('bo_brave_api_key_2'),
      ('bo_brave_api_key_3'),
      ('bo_brave_api_key_4'),
      ('bo_brave_api_key_5'),
      ('bo_brave_api_key_6')
    ) as pool(key_name)
    where exists (select 1 from vault.decrypted_secrets ds where ds.name = pool.key_name)
    order by array_position(array['bo_brave_api_key','bo_brave_api_key_2','bo_brave_api_key_3','bo_brave_api_key_4','bo_brave_api_key_5','bo_brave_api_key_6'], pool.key_name)
  loop
    if not coalesce((select (dead_until > now()) from public._brave_key_health where key_name = v_key_name), false) then
      v_key := public._brave_key_for(v_key_name);
      exit when v_key is not null;
    end if;
  end loop;
  if v_key is null then
    return jsonb_build_object('error', 'key-not-configured');
  end if;
  select net.http_get(
      'https://api.search.brave.com/res/v1/web/search',
      jsonb_build_object('q', p_query, 'count', '15', 'result_filter', 'web'),
      jsonb_build_object('Accept', 'application/json',
                         'X-Subscription-Token', v_key),
      20000
    ) into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  perform public._brave_mark_key(v_key_name, false, v_rid, null);
  return jsonb_build_object('rid', v_rid);
end $$;

revoke all on function public.rpc_brave_start(text) from public, anon, authenticated;
grant execute on function public.rpc_brave_start(text) to anon, authenticated;

-- ── Rewritten poll(): on 402, mark the submitting key dead ─────────
create or replace function public.rpc_brave_poll(p_rid bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rec record;
  v_key_name text;
begin
  select status_code, content, error_msg
    into v_rec
  from net._http_response
  where id = p_rid
  limit 1;

  if v_rec.status_code is null and v_rec.content is null then
    return jsonb_build_object('state', 'pending');
  end if;

  if v_rec.status_code >= 200 and v_rec.status_code < 300 then
    begin
      return jsonb_build_object('state', 'done', 'data', v_rec.content::jsonb);
    exception when others then
      return jsonb_build_object('state', 'failed', 'error', 'bad-json');
    end;
  end if;

  -- Quota death: mark whichever key submitted this rid so the pool
  -- rotates to the next one on the following call.
  if v_rec.status_code = 402 then
    select key_name into v_key_name from public._brave_key_health where last_rid = p_rid limit 1;
    if v_key_name is not null then
      perform public._brave_mark_key(v_key_name, true, null, 'http-402 quota');
    end if;
  end if;

  return jsonb_build_object('state', 'failed',
                            'error', 'http-' || coalesce(v_rec.status_code, 0));
end $$;

revoke all on function public.rpc_brave_poll(bigint) from public, anon, authenticated;
grant execute on function public.rpc_brave_poll(bigint) to anon, authenticated;
