-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.31: public Overpass proxy (server-side) v2      ║
-- ║ Root cause of the hang: pg_net workers only SEE a request after   ║
-- ║ the calling transaction COMMITS. bo.overpass_fetch fired          ║
-- ║ net.http_get then polled net._http_response INSIDE THE SAME       ║
-- ║ transaction — the worker could never pick the request up, so the  ║
-- ║ poll loop spun until the deadline. Fix: poll AFTER the request's  ║
-- ║ own transaction has committed, using a fresh autonomous txn per   ║
-- ║ poll iteration (commit-and-reopen pattern via dblink-free trick:  ║
-- ║ call net.http_collect_response + read in NEW statements with      ║
-- ║ explicit txn control from a wrapper that commits between steps).  ║
-- ║ Simpler + robust: fire N requests for the first mirror ACROSS    ║
-- ║ commits using DO-less single-statement flow: the public RPC runs  ║
-- ║ ONE statement that submits the job and returns the request id; a  ║
-- ║ SECOND public RPC polls/collects it (PostgREST calls are separate ║
-- ║ transactions, so the worker sees the request between the two).    ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Step 1: submit a server-side Overpass request ──────────────────
-- Fires net.http_get for ONE mirror and returns {rid, mirror}.
-- The commit that ends THIS rpc call lets the pg_net worker start.
create or replace function public.rpc_overpass_start(p_q text, p_mirror int default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'bo', 'net', 'public'
as $$
declare
  v_mirrors text[] := array[
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.ch/api/interpreter'
  ];
  v_url text;
  v_rid bigint;
begin
  v_url := v_mirrors[ least(greatest(p_mirror,0), array_length(v_mirrors,1)) + 1 ];
  select net.http_get(v_url, jsonb_build_object('data', p_q::text), '{}'::jsonb, 150000)
    into v_rid;
  if v_rid is null then
    return jsonb_build_object('error', 'submit-failed');
  end if;
  return jsonb_build_object('rid', v_rid, 'mirror', v_url);
end $$;

grant execute on function public.rpc_overpass_start(text, int) to anon, authenticated;

-- ── Step 2: collect the response (fresh transaction → sees results) ─
-- Returns {state:'pending'} until the worker has written the response.
-- When done: {state:'done', data:<overpass json>} or {state:'failed', status, error}.
create or replace function public.rpc_overpass_poll(p_rid bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'bo', 'net', 'public'
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
  if r.content is null or r.content !~ '^\s*\{' then
    return jsonb_build_object('state', 'failed', 'status', r.status_code, 'error', 'non-json');
  end if;
  begin
    if (r.content::jsonb) ? 'remark' then
      -- Overpass partial (query timed out server-side) — treat as failure
      return jsonb_build_object('state', 'failed', 'status', 200, 'error', 'remark');
    end if;
    if not (r.content::jsonb) ? 'elements' then
      return jsonb_build_object('state', 'failed', 'status', 200, 'error', 'no-elements');
    end if;
    return jsonb_build_object('state', 'done', 'data', r.content::jsonb);
  exception when others then
    return jsonb_build_object('state', 'failed', 'status', 200, 'error', 'bad-json');
  end;
end $$;

grant execute on function public.rpc_overpass_poll(bigint) to anon, authenticated;

-- ── Mirror health (server-side truth, for the client indicator) ─────
create or replace function public.rpc_overpass_mirrors()
returns jsonb
language plpgsql
stable
security definer
set search_path = 'net', 'public'
as $$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'url',    u.url,
           'ok',     (u.ok_count > 0),
           'lastOk', u.last_ok
         ) order by u.url), '[]'::jsonb)
    into v_rows
    from (
      select r.url as url,
             count(*) filter (where r.status_code = 200) as ok_count,
             max(r.created) filter (where r.status_code = 200) as last_ok
        from net._http_response r
       where r.url like '%/api/interpreter%'
         and r.created > now() - interval '6 hours'
       group by r.url
    ) u;
  return jsonb_build_object('mirrors', v_rows, 'time', now());
end $$;

grant execute on function public.rpc_overpass_mirrors() to anon, authenticated;

-- The v1 wrappers are superseded — drop so no one calls the dead path.
drop function if exists public.rpc_overpass_fetch(text);
