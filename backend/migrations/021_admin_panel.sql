-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.120: Admin panel (traffic, usage, moderation)   ║
-- ║ /Blue-Ocean/admin — login is a REAL Supabase password sign-in;    ║
-- ║ every admin RPC re-checks server-side that auth.uid() maps to the ║
-- ║ hardcoded admin email, so the gate is not client-side only.       ║
-- ║                                                                   ║
-- ║ Adds:                                                             ║
-- ║   • bo.traffic_events — one row per app boot (anon + signed-in)   ║
-- ║   • bo.user_status  — suspension flag per user                    ║
-- ║   • bo.is_admin()   — admin gate from the JWT                     ║
-- ║   • rpc_event_log   — client fire-and-forget boot logging         ║
-- ║   • rpc_user_status_get — client suspension check                 ║
-- ║   • rpc_admin_overview / _traffic / _runs / _users                ║
-- ║   • rpc_admin_set_suspended / rpc_admin_delete_user               ║
-- ║   • run_archive_upsert + user_prefs_put now REJECT suspended users║
-- ║ Usage model: 1 archived run = 1 usage; per-user usage = run count ║
-- ║ + sum(biz_count) (businesses scanned). Guests = user_id IS NULL.  ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Hardcoded admin identity ─────────────────────────────────────────
create or replace function bo.is_admin()
returns boolean
language sql stable security definer set search_path = bo as $$
  select exists (
    select 1 from auth.users
    where id = auth.uid()
      and lower(email) = 'ananiadevsurashvili@gmail.com'
  );
$$;

-- ── Traffic events (lightweight; one row per app boot) ──────────────
create table if not exists bo.traffic_events (
  id         bigint generated always as identity primary key,
  event_type text not null default 'boot',   -- boot | admin | run
  path       text   not null default '',
  session_id text   not null default '',     -- anonymous browser session
  user_id    uuid,                           -- null for guests
  version    text   not null default '',
  created_at timestamptz not null default now()
);
create index if not exists traffic_events_created_idx on bo.traffic_events (created_at desc);
create index if not exists traffic_events_session_idx on bo.traffic_events (session_id, created_at desc);
create index if not exists traffic_events_user_idx    on bo.traffic_events (user_id, created_at desc);

-- ── Suspension flag ──────────────────────────────────────────────────
create table if not exists bo.user_status (
  user_id    uuid primary key,               -- references auth.users(id)
  suspended  boolean not null default false,
  reason     text   not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create or replace function bo.is_suspended(p_user uuid)
returns boolean
language sql stable security definer set search_path = bo as $$
  select coalesce((select suspended from bo.user_status where user_id = p_user), false);
$$;

-- ── Client: fire-and-forget event log ────────────────────────────────
create or replace function bo.rpc_event_log(
  p_event text, p_path text, p_session text, p_version text
) returns text
language plpgsql security definer set search_path = bo as $$
begin
  if p_event is null or length(p_event) = 0 or length(p_event) > 40 then
    return 'skip';
  end if;
  insert into bo.traffic_events (event_type, path, session_id, user_id, version)
  values (left(p_event, 40), left(coalesce(p_path, ''), 200),
          left(coalesce(p_session, ''), 64), auth.uid(),
          left(coalesce(p_version, ''), 20));
  return 'ok';
end $$;

-- ── Client: own suspension check (called on boot when signed in) ────
create or replace function bo.rpc_user_status_get()
returns jsonb
language plpgsql security definer set search_path = bo as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('suspended', false);
  end if;
  if bo.is_suspended(v_user) then
    return jsonb_build_object('suspended', true,
      'reason', coalesce((select reason from bo.user_status where user_id = v_user), ''));
  end if;
  return jsonb_build_object('suspended', false);
end $$;

-- ═══════════════════════ ADMIN DATA RPCs ═══════════════════════

-- Headline numbers for the Overview tab.
create or replace function bo.rpc_admin_overview()
returns jsonb
language plpgsql security definer set search_path = bo as $$
declare
  v jsonb;
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'users_total',     (select count(*) from auth.users),
    'suspended',       (select count(*) from bo.user_status where suspended),
    'runs_total',      (select count(*) from bo.run_archive),
    'guest_runs',      (select count(*) from bo.run_archive where user_id is null),
    'user_runs',       (select count(*) from bo.run_archive where user_id is not null),
    'runs_24h',        (select count(*) from bo.run_archive where ts > now() - interval '24 hours'),
    'biz_total',       (select coalesce(sum(biz_count), 0) from bo.run_archive),
    'events_24h',      (select count(*) from bo.traffic_events
                        where event_type = 'boot' and created_at > now() - interval '24 hours'),
    'uniques_24h',     (select count(distinct coalesce(user_id::text, session_id)) from bo.traffic_events
                        where event_type = 'boot' and created_at > now() - interval '24 hours'),
    'events_7d',       (select count(*) from bo.traffic_events
                        where event_type = 'boot' and created_at > now() - interval '7 days'),
    'uniques_7d',      (select count(distinct coalesce(user_id::text, session_id)) from bo.traffic_events
                        where event_type = 'boot' and created_at > now() - interval '7 days')
  ) into v;
  return v;
end $$;

-- Daily traffic for the last p_hours (default 30 days).
create or replace function bo.rpc_admin_traffic(p_hours int default 720)
returns table (day date, events bigint, uniques bigint, signed_in bigint)
language sql security definer set search_path = bo as $$
  select (created_at at time zone 'utc')::date as day,
         count(*)                                            as events,
         count(distinct coalesce(user_id::text, session_id)) as uniques,
         count(*) filter (where user_id is not null)         as signed_in
  from bo.traffic_events
  where event_type = 'boot'
    and created_at > now() - make_interval(hours => least(greatest(p_hours, 24), 8760))
  group by 1
  order by 1 desc;
$$;

-- Recent runs with owner attribution (scope: all | guests | users).
create or replace function bo.rpc_admin_runs(p_limit int default 100, p_scope text default 'all')
returns table (
  run_id text, kind text, ts timestamptz, version text,
  country text, city text, category text,
  biz_count int, any_contact_pct numeric,
  user_id uuid, email text
)
language sql security definer set search_path = bo as $$
  select a.run_id, a.kind, a.ts, a.version, a.country, a.city, a.category,
         a.biz_count, a.any_contact_pct, a.user_id, u.email
  from bo.run_archive a
  left join auth.users u on u.id = a.user_id
  where (p_scope = 'all')
     or (p_scope = 'guests' and a.user_id is null)
     or (p_scope = 'users'  and a.user_id is not null)
  order by a.ts desc
  limit least(greatest(p_limit, 1), 300);
$$;

-- Registered users with usage: runs, businesses scanned, last activity.
create or replace function bo.rpc_admin_users(p_limit int default 200)
returns table (
  user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  runs bigint, biz bigint, last_run timestamptz, suspended boolean, reason text
)
language sql security definer set search_path = bo as $$
  select u.id, u.email, u.created_at, u.last_sign_in_at,
         coalesce(r.runs, 0), coalesce(r.biz, 0), r.last_run,
         coalesce(s.suspended, false), coalesce(s.reason, '')
  from auth.users u
  left join (
    select user_id, count(*) as runs, sum(biz_count) as biz, max(ts) as last_run
    from bo.run_archive where user_id is not null group by user_id
  ) r on r.user_id = u.id
  left join bo.user_status s on s.user_id = u.id
  order by u.created_at desc
  limit least(greatest(p_limit, 1), 500);
$$;

-- Suspend / un-suspend. Suspending also revokes the user's live sessions.
create or replace function bo.rpc_admin_set_suspended(
  p_user uuid, p_suspended boolean, p_reason text default ''
) returns text
language plpgsql security definer set search_path = bo as $$
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;
  if p_user is null then return 'skip'; end if;
  if p_user = auth.uid() then return 'cannot-suspend-self'; end if;
  insert into bo.user_status (user_id, suspended, reason, updated_at, updated_by)
  values (p_user, p_suspended, left(coalesce(p_reason, ''), 200), now(), auth.uid())
  on conflict (user_id) do update
    set suspended = excluded.suspended, reason = excluded.reason,
        updated_at = now(), updated_by = excluded.updated_by;
  if p_suspended then
    begin
      delete from auth.sessions where user_id = p_user;   -- force sign-out
    exception when undefined_table then null;               -- schema drift safety
    end;
  end if;
  return 'ok';
end $$;

-- Hard delete: runs, prefs, status, then the auth user (cascades sessions).
create or replace function bo.rpc_admin_delete_user(p_user uuid) returns text
language plpgsql security definer set search_path = bo as $$
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;
  if p_user is null then return 'skip'; end if;
  if p_user = auth.uid() then return 'cannot-delete-self'; end if;
  delete from bo.run_archive where user_id = p_user;
  delete from bo.user_prefs  where user_id = p_user;
  delete from bo.user_status where user_id = p_user;
  delete from auth.users     where id      = p_user;
  return 'ok';
end $$;

-- ═══════════════════════ ENFORCEMENT ═══════════════════════
-- Suspended users cannot write runs or sync prefs (server-side reject).

create or replace function bo.rpc_run_archive_upsert(
  p_run_id text, p_kind text, p_ts timestamptz, p_version text,
  p_country text, p_city text, p_category text,
  p_biz_count integer, p_any_contact_pct numeric, p_payload jsonb
) returns text
language plpgsql security definer set search_path = bo as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is not null and bo.is_suspended(v_user) then
    raise exception 'account suspended';
  end if;
  if p_run_id is null or length(p_run_id) = 0 or length(p_run_id) > 200 then
    raise exception 'invalid run_id';
  end if;
  if p_kind not in ('analyze','discover') then
    raise exception 'invalid kind';
  end if;
  if octet_length(p_payload::text) > 800000 then
    raise exception 'payload too large';
  end if;
  insert into bo.run_archive (
    run_id, kind, ts, version, country, city, category,
    biz_count, any_contact_pct, payload, user_id
  ) values (
    left(p_run_id, 200), p_kind, p_ts, left(p_version, 20),
    left(p_country, 60), left(p_city, 60), left(p_category, 40),
    greatest(p_biz_count, 0), greatest(p_any_contact_pct, 0), p_payload,
    v_user
  )
  on conflict (run_id) do update set
    ts = excluded.ts, version = excluded.version,
    biz_count = excluded.biz_count,
    any_contact_pct = excluded.any_contact_pct,
    payload = excluded.payload,
    user_id = coalesce(excluded.user_id, bo.run_archive.user_id);
  return 'ok';
end $$;

create or replace function bo.rpc_user_prefs_put(p_prefs jsonb)
returns text
language plpgsql security definer set search_path = bo as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then return 'skip'; end if;
  if bo.is_suspended(v_user) then return 'suspended'; end if;
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object'
     or octet_length(p_prefs::text) > 32000 then
    return 'skip';
  end if;
  insert into bo.user_prefs (user_id, prefs, updated_at)
  values (v_user, p_prefs, now())
  on conflict (user_id) do update
    set prefs = p_prefs, updated_at = now();
  return 'ok';
end $$;

-- ═════════════════ public wrappers (PostgREST serves public only) ═════════════════

create or replace function public.rpc_event_log(p_event text, p_path text, p_session text, p_version text)
returns text language sql volatile security definer set search_path = bo as
$$ select bo.rpc_event_log(p_event, p_path, p_session, p_version); $$;

create or replace function public.rpc_user_status_get()
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.rpc_user_status_get(); $$;

create or replace function public.rpc_admin_overview()
returns jsonb language sql volatile security definer set search_path = bo as
$$ select bo.rpc_admin_overview(); $$;

create or replace function public.rpc_admin_traffic(p_hours int default 720)
returns table (day date, events bigint, uniques bigint, signed_in bigint)
language sql stable security definer set search_path = bo as
$$ select * from bo.rpc_admin_traffic(p_hours); $$;

create or replace function public.rpc_admin_runs(p_limit int default 100, p_scope text default 'all')
returns table (
  run_id text, kind text, ts timestamptz, version text,
  country text, city text, category text,
  biz_count int, any_contact_pct numeric, user_id uuid, email text
)
language sql stable security definer set search_path = bo as
$$ select * from bo.rpc_admin_runs(p_limit, p_scope); $$;

create or replace function public.rpc_admin_users(p_limit int default 200)
returns table (
  user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz,
  runs bigint, biz bigint, last_run timestamptz, suspended boolean, reason text
)
language sql stable security definer set search_path = bo as
$$ select * from bo.rpc_admin_users(p_limit); $$;

create or replace function public.rpc_admin_set_suspended(p_user uuid, p_suspended boolean, p_reason text default '')
returns text language sql volatile security definer set search_path = bo as
$$ select bo.rpc_admin_set_suspended(p_user, p_suspended, p_reason); $$;

create or replace function public.rpc_admin_delete_user(p_user uuid)
returns text language sql volatile security definer set search_path = bo as
$$ select bo.rpc_admin_delete_user(p_user); $$;

-- Public wrapper for the re-entrant run-archive upsert (same contract).
create or replace function public.rpc_run_archive_upsert(
  p_run_id text, p_kind text, p_ts timestamptz, p_version text,
  p_country text, p_city text, p_category text,
  p_biz_count int, p_any_contact_pct numeric, p_payload jsonb
) returns text language sql volatile security definer set search_path = bo as
$$ select bo.rpc_run_archive_upsert(
  p_run_id, p_kind, p_ts, p_version, p_country, p_city, p_category,
  p_biz_count, p_any_contact_pct, p_payload); $$;

-- Public wrapper for prefs put (suspension-aware re-entrant).
create or replace function public.rpc_user_prefs_put(p_prefs jsonb)
returns text language sql volatile security definer set search_path = bo as
$$ select bo.rpc_user_prefs_put(p_prefs); $$;

-- ── Grants: everyone may call (admin RPCs self-gate on is_admin) ─────
grant execute on function public.rpc_event_log(text, text, text, text) to anon, authenticated;
grant execute on function public.rpc_user_status_get()               to anon, authenticated;
grant execute on function public.rpc_admin_overview()                to anon, authenticated;
grant execute on function public.rpc_admin_traffic(int)              to anon, authenticated;
grant execute on function public.rpc_admin_runs(int, text)           to anon, authenticated;
grant execute on function public.rpc_admin_users(int)                to anon, authenticated;
grant execute on function public.rpc_admin_set_suspended(uuid, boolean, text) to anon, authenticated;
grant execute on function public.rpc_admin_delete_user(uuid)         to anon, authenticated;
grant execute on function public.rpc_run_archive_upsert(text, text, timestamptz, text, text, text, text, int, numeric, jsonb) to anon, authenticated;
grant execute on function public.rpc_user_prefs_put(jsonb)           to anon, authenticated;
