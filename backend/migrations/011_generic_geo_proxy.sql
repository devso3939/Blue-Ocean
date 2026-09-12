-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.32: generic whitelisted proxy (start/poll pair) ║
-- ║ Extends the Overpass proxy pattern to ANY CORS-restricted geo API ║
-- ║ (Nominatim today, more later). Same pg_net commit rule applies:   ║
-- ║ start() submits, poll() collects in a SEPARATE transaction.       ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Whitelist: only these URL prefixes may be proxied ──────────────
-- Keeps the endpoint from becoming an open relay.
create or replace function public._proxy_url_allowed(p_url text)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select p_url in (
    'https://nominatim.openstreetmap.org/search',
    'https://nominatim.openstreetmap.org/reverse',
    'https://photon.komoot.io/api',
    'https://photon.komoot.io/reverse',
    'https://geocoding-api.open-meteo.com/v1/search'
  )
$$;

-- ── Submit a proxied GET ───────────────────────────────────────────
-- p_params: JSON object of query params (e.g. {"q":"Tbilisi","format":"json"}).
-- Returns {rid} or {error}.
create or replace function public.rpc_proxy_start(p_url text, p_params jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rid bigint;
begin
  if not public._proxy_url_allowed(p_url) then
    return jsonb_build_object('error', 'url-not-allowed');
  end if;
  select net.http_get(
      p_url,
      p_params,
      -- Nominatim policy: identify the app; json accept
      jsonb_build_object('User-Agent', 'BlueOcean/6.9.32 (https://devso3939.github.io/Blue-Ocean; contact@blueocean.app)',
                         'Accept', 'application/json'),
      30000
    ) into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  return jsonb_build_object('rid', v_rid);
end $$;

grant execute on function public.rpc_proxy_start(text, jsonb) to anon, authenticated;

-- ── Collect the proxied response ───────────────────────────────────
-- {state:'pending'} | {state:'done', data:<parsed json>} | {state:'failed', error}
create or replace function public.rpc_proxy_poll(p_rid bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  r record;
begin
  select status_code, content, timed_out, coalesce(error_msg,'') as error_msg
    into r from net._http_response where id = p_rid;
  if not found then
    return jsonb_build_object('state', 'pending');
  end if;
  if r.timed_out then
    return jsonb_build_object('state', 'failed', 'error', 'timeout');
  end if;
  if r.status_code <> 200 then
    return jsonb_build_object('state', 'failed', 'status', r.status_code, 'error', left(r.error_msg, 120));
  end if;
  begin
    return jsonb_build_object('state', 'done', 'data', r.content::jsonb);
  exception when others then
    return jsonb_build_object('state', 'failed', 'error', 'bad-json');
  end;
end $$;

grant execute on function public.rpc_proxy_poll(bigint) to anon, authenticated;
