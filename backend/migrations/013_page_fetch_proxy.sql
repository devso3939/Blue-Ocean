-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.64: generic page-fetch proxy (start/poll)       ║
-- ║ The guaranteed lane: Supabase fetches ANY https page and returns  ║
-- ║ the raw text. Browser CORS, flaky third-party CORS proxies and    ║
-- ║ per-IP rate limits stop touching scans. Safety: https-only,       ║
-- ║ private/loopback hosts refused, 25s server timeout, 2 MB cap.     ║
-- ║ Same pg_net commit rule: start() submits, poll() collects in a    ║
-- ║ SEPARATE transaction.                                             ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Host guard: https + no private/loopback targets ────────────────
create or replace function public._fetch_url_allowed(p_url text)
returns boolean
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_host text;
begin
  if p_url is null then return false; end if;
  if left(p_url, 8) <> 'https://' then return false; end if;
  if length(p_url) > 2000 then return false; end if;
  v_host := lower(substring(p_url from 9 for strpos(substring(p_url from 9) || '/', '/') - 1));
  v_host := split_part(v_host, ':', 1);  -- strip port
  -- refuse localhost / private ranges / non-domain hosts
  if v_host in ('localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254') then
    return false;
  end if;
  if v_host like '10.%' or v_host like '192.168.%' or v_host like '127.%' then
    return false;
  end if;
  if v_host like '172.1_.%' or v_host like '172.2_.%' or v_host like '172.3_.%' then
    return false;
  end if;
  -- must contain at least one dot (real domain)
  return position('.' in v_host) > 0;
end $$;

-- ── Submit a page fetch ────────────────────────────────────────────
-- Returns {rid} or {error}.
create or replace function public.rpc_fetch_start(p_url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rid bigint;
begin
  if not public._fetch_url_allowed(p_url) then
    return jsonb_build_object('error', 'url-not-allowed');
  end if;
  select net.http_get(
      p_url,
      '{}'::jsonb,
      jsonb_build_object(
        'User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language', 'en'
      ),
      25000
    ) into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  return jsonb_build_object('rid', v_rid);
end $$;

revoke all on function public.rpc_fetch_start(text) from public, anon, authenticated;
grant execute on function public.rpc_fetch_start(text) to anon, authenticated;

-- ── Collect the page ───────────────────────────────────────────────
-- {state:'pending'} | {state:'done', text:<body>, status:<code>} | {state:'failed', error}
-- Non-2xx still returns the body with its status (search engines return
-- useful HTML on 4xx pages sometimes; caller decides).
create or replace function public.rpc_fetch_poll(p_rid bigint)
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
  if r.content is null or octet_length(r.content) = 0 then
    return jsonb_build_object('state', 'failed', 'error', 'empty',
                              'status', coalesce(r.status_code, 0));
  end if;
  return jsonb_build_object('state', 'done',
                            'status', r.status_code,
                            'text', left(r.content, 2000000));
end $$;

revoke all on function public.rpc_fetch_poll(bigint) from public, anon, authenticated;
grant execute on function public.rpc_fetch_poll(bigint) to anon, authenticated;
