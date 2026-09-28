-- ════════════════════════════════════════════════════════════════════
-- 020 AUTH REDIRECT PROBE (v6.9.114)
-- GoTrue keeps site_url + the redirect-URL allow-list in its own service
-- config — invisible to Postgres and to the PUBLIC /auth/v1/settings
-- (those fields are admin-only). But GET /auth/v1/verify?token=<garbage>
-- &type=recovery&redirect_to=<candidate> answers 302 with a Location
-- header pointing at the URL GOTRUE WOULD SEND THE USER'S BROWSER TO:
--   • redirect_to honored  → Location echoes the candidate (+ error fragment)
--   • redirect_to rejected → Location = the bare Site URL instead
-- So probing a never-allow-listed candidate (e.g. https://x.invalid/)
-- reveals the Site URL, and probing the app's own page reveals whether
-- the allow-list honors it. Verified live 2026-09-29 (curl):
--   no redirect_to            → Location: http://localhost:3000#…   (Site URL!)
--   ?redirect_to=<gh-pages>   → Location: http://localhost:3000#…   (rejected)
--   ?redirect_to=<localhost>  → Location: http://localhost:3199/#…  (honored)
--
-- DESIGN NOTES
-- • The PostgREST API role runs with a ~3 s statement timeout, so the
--   probe is TWO-PHASE (rpc_overpass_start/poll pattern, migration 010):
--   start() fires pg_net requests and returns instantly; poll() waits up
--   to 1.2 s in 50 ms sleeps and returns the raw Location per rid.
-- • Burst submissions to the same host ALL failed with "Couldn't connect
--   to server" (pg_net worker opens parallel fresh TLS connections;
--   ~2 s-spaced solo requests always succeed). The client therefore calls
--   start/poll ONCE PER CANDIDATE, sequentially; this file keeps array
--   support for future batching but no longer assumes parallel arms work.
-- • pg_net FOLLOWS redirects (verified: http://github.com → final 200 HTML),
--   so the 302's Location is never visible. The oracle still works, INVERTED:
--   honored candidate  → follow lands on the REAL page → 200 + that page's HTML;
--   rejected candidate → follow goes to the Site URL → conn-error (unreachable
--   Site URL, e.g. localhost) or 200 with the SITE's HTML (alive Site URL).
--   The client sniffs the final status/content: 200 + its own app marker ⇒
--   honored; 200 + other content ⇒ rejected (alive Site URL); conn-error ⇒
--   rejected (unreachable Site URL).
-- • Verdict comparison lives CLIENT-SIDE (it owns the rid↔candidate map);
--   poll() returns raw status + content snippet per rid.
-- • All requests target ONLY the project's own auth realm with a garbage
--   token — nothing granted, nothing mutated. Rate limit: project-scoped
--   ip()-based; cache results client-side.
-- ════════════════════════════════════════════════════════════════════

create or replace function bo.rpc_auth_redirect_probe_start(p_candidates text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'bo', 'net', 'public'
as $$
declare
  v_base text := 'https://bfoagnqjkoqhogxvkvkw.supabase.co/auth/v1/verify?token=' ||
                 repeat('ab', 32) || '&type=recovery';
  v_rid  bigint;
  v_ids  bigint[];
begin
  if p_candidates is null or array_length(p_candidates, 1) is null
     or array_length(p_candidates, 1) > 8 then
    return jsonb_build_object('error', 'p_candidates must be 1..8 urls');
  end if;

  for v_idx in 1 .. coalesce(array_length(p_candidates, 1), 0) loop
    if btrim(p_candidates[v_idx]) = '' then continue; end if;
    begin
      select net.http_get(v_base || '&redirect_to=' ||
                          replace(replace(replace(replace(replace(replace(
                            btrim(p_candidates[v_idx]),
                            '%', '%25'), '#', '%23'), '&', '%26'), '+', '%2B'), ' ', '%20'), '?', '%3F'),
                          '{}'::jsonb, '{}'::jsonb, 3000)
        into v_rid;
    exception when others then
      v_rid := null;  -- submit failure surfaces as a 'submit-failed' verdict
    end;
    v_ids[v_idx] := v_rid;
  end loop;

  if v_ids[1] is null and coalesce(array_length(p_candidates, 1), 0) > 0
     and btrim(p_candidates[1]) <> '' then
    return jsonb_build_object('error', 'net submit failed');
  end if;
  return jsonb_build_object('rids', to_jsonb(v_ids));
end $$;

revoke all on function bo.rpc_auth_redirect_probe_start(text[]) from public, anon, authenticated;
grant execute on function bo.rpc_auth_redirect_probe_start(text[]) to anon, authenticated;

create or replace function bo.rpc_auth_redirect_probe_poll(p_rids bigint[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = 'bo', 'net', 'public'
as $$
declare
  v_deadline timestamptz := clock_timestamp() + interval '1200 milliseconds';
  v_pending  int := 0;
  r          record;
  v_out      jsonb := '{}'::jsonb;
  v_rid      bigint;
begin
  if p_rids is null or array_length(p_rids, 1) is null then
    return jsonb_build_object('error', 'p_rids required');
  end if;

  -- Wait briefly (1.2 s cap, 50 ms steps) for the responses to land.
  while clock_timestamp() < v_deadline loop
    select count(*) into v_pending
      from unnest(p_rids) u(v) where u.v is not null
        and not exists (select 1 from net._http_response n where n.id = u.v);
    exit when v_pending = 0;
    perform pg_sleep(0.05);
  end loop;

  foreach v_rid in array p_rids loop
    if v_rid is null then continue; end if;
    select * into r from net._http_response where id = v_rid;
    if not found then
      v_out := jsonb_set(v_out, array['_' || v_rid::text],
                         jsonb_build_object('result', 'timeout'), true);
    elsif r.error_msg is not null and r.error_msg <> '' then
      v_out := jsonb_set(v_out, array['_' || v_rid::text],
                         jsonb_build_object('result', 'follow-failed',
                                            'detail', left(r.error_msg, 60)), true);
    else
      -- pg_net followed the redirect; the final response identifies the target.
      v_out := jsonb_set(v_out, array['_' || v_rid::text],
                         jsonb_build_object('result', 'followed',
                                            'status', coalesce(r.status_code::text, '?'),
                                            'content_type', left(coalesce(r.content_type, ''), 40),
                                            'snipt', left(coalesce(r.content, ''), 160)), true);
    end if;
  end loop;

  return jsonb_build_object('responses', v_out);
end $$;

revoke all on function bo.rpc_auth_redirect_probe_poll(bigint[]) from public, anon, authenticated;
grant execute on function bo.rpc_auth_redirect_probe_poll(bigint[]) to anon, authenticated;

-- ── Public wrappers (bo stays private; pattern from migrations 010/013/019) ──
create or replace function public.rpc_auth_redirect_probe_start(p_candidates text[])
returns jsonb language sql volatile security definer
set search_path = 'public'
as $$ select bo.rpc_auth_redirect_probe_start(p_candidates) $$;

create or replace function public.rpc_auth_redirect_probe_poll(p_rids bigint[])
returns jsonb language sql volatile security definer
set search_path = 'public'
as $$ select bo.rpc_auth_redirect_probe_poll(p_rids) $$;

revoke all on function public.rpc_auth_redirect_probe_start(text[]) from public, anon, authenticated;
grant execute on function public.rpc_auth_redirect_probe_start(text[]) to anon, authenticated;
revoke all on function public.rpc_auth_redirect_probe_poll(bigint[]) from public, anon, authenticated;
grant execute on function public.rpc_auth_redirect_probe_poll(bigint[]) to anon, authenticated;
