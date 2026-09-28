-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.110: User accounts (Supabase Auth)              ║
-- ║ Email sign-in/sign-up via the built-in auth.users (GoTrue). Adds: ║
-- ║   • bo.user_prefs — per-user JSON preferences (selected country,  ║
-- ║     category, UI choices) synced across devices                   ║
-- ║   • bo.run_archive.user_id — runs stored by a signed-in user are  ║
-- ║     owned by them; list/get are scoped to the caller's JWT,       ║
-- ║     anonymous rows keep working exactly as before                 ║
-- ║ No service changes: the archive table keeps its columns, the anon ║
-- ║ RPCs keep their contracts, everything stays callable by anon.     ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Per-user preferences ────────────────────────────────────────────
create table if not exists bo.user_prefs (
  user_id    uuid primary key,          -- references auth.users(id)
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Run archive gains an optional owner ─────────────────────────────
alter table bo.run_archive add column if not exists user_id uuid;
create index if not exists run_archive_user_ts_idx on bo.run_archive (user_id, ts desc);

-- ── Preferences RPCs (auth enforced server-side from the JWT) ───────
create or replace function bo.rpc_user_prefs_get()
returns jsonb
language plpgsql
security definer
set search_path = 'bo'
as $$
declare
  v_user uuid := auth.uid();
  v_prefs jsonb;
begin
  if v_user is null then return null; end if;   -- anonymous → no prefs
  select prefs into v_prefs from bo.user_prefs where user_id = v_user;
  return coalesce(v_prefs, '{}'::jsonb);
end $$;

create or replace function bo.rpc_user_prefs_put(p_prefs jsonb)
returns text
language plpgsql
security definer
set search_path = 'bo'
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then return 'skip'; end if; -- anonymous → nothing to do
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

-- ── Run archive: user-aware rewrites (same contracts as before) ─────
-- upsert: stamps auth.uid() when the caller is signed in
create or replace function bo.rpc_run_archive_upsert(
  p_run_id text, p_kind text, p_ts timestamptz, p_version text,
  p_country text, p_city text, p_category text,
  p_biz_count integer, p_any_contact_pct numeric, p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = 'bo'
as $$
declare
  v_user uuid := auth.uid();
begin
  if p_run_id is null or length(p_run_id) = 0 or length(p_run_id) > 200 then
    raise exception 'invalid run_id';
  end if;
  if p_kind not in ('analyze','discover') then
    raise exception 'invalid kind';
  end if;
  if octet_length(p_payload::text) > 800000 then   -- ~800 KB per run
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

-- list: signed-in → OWN runs first (or only, see flag); anon → shared pool
create or replace function bo.rpc_run_archive_list(p_limit integer default 100, p_mine_only boolean default false)
returns table(run_id text, kind text, ts timestamptz, version text, country text, city text, category text, biz_count integer, any_contact_pct numeric)
language sql
security definer
set search_path = 'bo'
as $$
  select a.run_id, a.kind, a.ts, a.version, a.country, a.city, a.category,
         a.biz_count, a.any_contact_pct
  from bo.run_archive a
  where (auth.uid() is null and a.user_id is null)      -- anon: shared pool only
     or (auth.uid() is not null and (a.user_id = auth.uid() or not p_mine_only))
  order by a.ts desc
  limit least(greatest(p_limit, 1), 300);
$$;

-- get: a signed-in user fetches own rows always; other rows only when shared
create or replace function bo.rpc_run_archive_get(p_run_id text)
returns jsonb
language plpgsql
security definer
set search_path = 'bo'
as $$
declare
  v_row bo.run_archive%rowtype;
begin
  select * into v_row from bo.run_archive where run_id = left(p_run_id, 200);
  if not found then return null; end if;
  if v_row.user_id is not null and v_row.user_id <> auth.uid() then
    return null;   -- another user's private run is invisible
  end if;
  return v_row.payload;
end $$;

-- ── Grants (keeps anon working exactly as today) ────────────────────
revoke all on function bo.rpc_user_prefs_get() from public;
grant execute on function bo.rpc_user_prefs_get() to anon, authenticated;
revoke all on function bo.rpc_user_prefs_put(jsonb) from public;
grant execute on function bo.rpc_user_prefs_put(jsonb) to anon, authenticated;
revoke all on function bo.rpc_run_archive_list(integer, boolean) from public;
grant execute on function bo.rpc_run_archive_list(integer, boolean) to anon, authenticated;
revoke all on function bo.rpc_run_archive_get(text) from public;
grant execute on function bo.rpc_run_archive_get(text) to anon, authenticated;

-- ── Public wrapper for the re-signed list (old single-arg callers keep
-- working via the default; PostgREST calls the new 2-arg signature) ──
create or replace function public.rpc_run_archive_list(p_limit integer default 100, p_mine_only boolean default false)
returns table(run_id text, kind text, ts timestamptz, version text, country text, city text, category text, biz_count integer, any_contact_pct numeric)
language sql stable security definer set search_path to 'bo'
as $$ select * from bo.rpc_run_archive_list(p_limit, p_mine_only); $$;
revoke all on function public.rpc_run_archive_list(integer, boolean) from public;
grant execute on function public.rpc_run_archive_list(integer, boolean) to anon, authenticated;

-- ── Public wrappers for the new prefs functions ─────────────────────
create or replace function public.rpc_user_prefs_get()
returns jsonb language sql stable security definer set search_path to 'bo'
as $$ select bo.rpc_user_prefs_get(); $$;
create or replace function public.rpc_user_prefs_put(p_prefs jsonb)
returns text language sql volatile security definer set search_path to 'bo'
as $$ select bo.rpc_user_prefs_put(p_prefs); $$;
revoke all on function public.rpc_user_prefs_get() from public;
grant execute on function public.rpc_user_prefs_get() to anon, authenticated;
revoke all on function public.rpc_user_prefs_put(jsonb) from public;
grant execute on function public.rpc_user_prefs_put(jsonb) to anon, authenticated;

-- ── Redirect URL allow-list for the deployed frontend ───────────────
-- (password flows need no redirect config; kept here for completeness)
