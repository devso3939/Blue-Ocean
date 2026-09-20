-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.70: headless-browser render lane (urlscan.io)   ║
-- ║ CF-challenged chain sites (aversi.ge-class) defeat every plain    ║
-- ║ fetch arm. urlscan.io runs a REAL headless browser: submitting a  ║
-- ║ URL there passes Cloudflare challenges, and the rendered DOM of   ║
-- ║ the passed scan is retrievable afterwards. Both calls run from    ║
-- ║ Supabase with the API key read from Vault — the key never ships   ║
-- ║ in the client bundle. Free tier: ~50 scans/hour, public only.     ║
-- ║ Same pg_net commit rule as the other proxies: start() submits,    ║
-- ║ poll() (rpc_fetch_poll from migration 013) collects in a new      ║
-- ║ transaction.                                                      ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Read the urlscan key from Vault (service-role only) ────────────
create or replace function public._urlscan_api_key()
returns text
language sql
stable
security definer
set search_path = 'public', 'vault'
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'bo_urlscan_api_key'
  limit 1
$$;

-- ── Submit a URL for headless rendering ────────────────────────────
-- Returns {rid} whose poll body is JSON {uuid: "..."} on success —
-- the client feeds that uuid into rpc_urlscan_dom().
create or replace function public.rpc_urlscan_submit(p_url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rid bigint;
  v_key text;
begin
  if p_url is null then
    return jsonb_build_object('error', 'bad-url');
  end if;
  if left(p_url, 8) <> 'https://' or length(p_url) > 500 then
    return jsonb_build_object('error', 'bad-url');
  end if;
  v_key := public._urlscan_api_key();
  if v_key is null then
    return jsonb_build_object('error', 'key-not-configured');
  end if;
  select net.http_post(
      'https://urlscan.io/api/v1/scan/',
      jsonb_build_object('url', p_url, 'visibility', 'public'),
      '{}'::jsonb,
      jsonb_build_object('API-Key', v_key,
                         'Content-Type', 'application/json'),
      20000
    ) into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  return jsonb_build_object('rid', v_rid);
end $$;

revoke all on function public.rpc_urlscan_submit(text) from public, anon, authenticated;
grant execute on function public.rpc_urlscan_submit(text) to anon, authenticated;

-- ── Fetch the rendered DOM of a completed scan ─────────────────────
-- p_uuid is the scan uuid returned by the submission call. The DOM
-- endpoint serves the post-JS-execution HTML of the page urlscan's
-- real browser saw — including pages captured after Cloudflare cleared.
create or replace function public.rpc_urlscan_dom(p_uuid text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rid bigint;
  v_key text;
begin
  -- uuid format guard: urlscan uuids are lowercase hex + dashes
  if p_uuid is null or p_uuid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('error', 'bad-uuid');
  end if;
  v_key := public._urlscan_api_key();
  if v_key is null then
    return jsonb_build_object('error', 'key-not-configured');
  end if;
  select net.http_get(
      'https://urlscan.io/dom/' || p_uuid || '/',
      '{}'::jsonb,
      jsonb_build_object('API-Key', v_key,
                         'Accept', 'text/html,*/*'),
      30000
    ) into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  return jsonb_build_object('rid', v_rid);
end $$;

revoke all on function public.rpc_urlscan_dom(text) from public, anon, authenticated;
grant execute on function public.rpc_urlscan_dom(text) to anon, authenticated;
