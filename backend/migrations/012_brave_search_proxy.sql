-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.48: server-side web-search proxy (Brave)        ║
-- ║ Brave's API blocks browser CORS (preflight → 405), so the         ║
-- ║ professional-services supplement calls it from Supabase instead.  ║
-- ║ The subscription token lives encrypted in Vault — it never ships  ║
-- ║ in the client bundle. Same pg_net commit rule as the other        ║
-- ║ proxies: start() submits, poll() collects in a new transaction.   ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Read the Brave token from Vault (service-role only) ────────────
create or replace function public._brave_api_key()
returns text
language sql
stable
security definer
set search_path = 'public', 'vault'
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'bo_brave_api_key'
  limit 1
$$;

-- ── Submit a Brave web search ──────────────────────────────────────
-- p_query: plain search text (NOT the q= URL param — appended here).
-- Returns {rid} or {error}.
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
begin
  if p_query is null or length(btrim(p_query)) = 0 or length(p_query) > 400 then
    return jsonb_build_object('error', 'bad-query');
  end if;
  v_key := public._brave_api_key();
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
  return jsonb_build_object('rid', v_rid);
end $$;

revoke all on function public.rpc_brave_start(text) from public, anon, authenticated;
grant execute on function public.rpc_brave_start(text) to anon, authenticated;

-- ── Collect the Brave response ─────────────────────────────────────
-- {state:'pending'} | {state:'done', data:<parsed json>} | {state:'failed', error}
create or replace function public.rpc_brave_poll(p_rid bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rec record;
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
  return jsonb_build_object('state', 'failed',
                            'error', 'http-' || coalesce(v_rec.status_code, 0));
end $$;

revoke all on function public.rpc_brave_poll(bigint) from public, anon, authenticated;
grant execute on function public.rpc_brave_poll(bigint) to anon, authenticated;
