-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 013: server-side run archive               ║
-- ║ Mirrors the on-device History (bo_run_history_v1) into Supabase   ║
-- ║ so runs survive localStorage eviction and restore on any device.  ║
-- ║ Payload is JSONB, size-bounded; restore pulls the full record.    ║
-- ╚══════════════════════════════════════════════════════════════════╝

create table if not exists bo.run_archive (
  id          bigint generated always as identity primary key,
  run_id      text not null unique,               -- client RunRecord.id
  kind        text   not null check (kind in ('analyze','discover')),
  ts          timestamptz not null,
  version     text   not null default '',
  country     text   not null default '',
  city        text   not null default '',
  category    text,                             -- null for discover/all
  biz_count   int    not null default 0,
  any_contact_pct numeric not null default 0,
  payload     jsonb  not null,                  -- full RunRecord
  created_at  timestamptz not null default now()
);
create index if not exists run_archive_list_idx
  on bo.run_archive (ts desc);
create index if not exists run_archive_lookup_idx
  on bo.run_archive (country, city, ts desc);

-- Upsert one full run (client sends its whole RunRecord as JSONB).
create or replace function bo.rpc_run_archive_upsert(
  p_run_id text, p_kind text, p_ts timestamptz, p_version text,
  p_country text, p_city text, p_category text,
  p_biz_count int, p_any_contact_pct numeric,
  p_payload jsonb
) returns text
language plpgsql security definer set search_path = bo as $$
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
    biz_count, any_contact_pct, payload
  ) values (
    left(p_run_id, 200), p_kind, p_ts, left(p_version, 20),
    left(p_country, 60), left(p_city, 60), left(p_category, 40),
    greatest(p_biz_count, 0), greatest(p_any_contact_pct, 0), p_payload
  )
  on conflict (run_id) do update set
    ts = excluded.ts, version = excluded.version,
    biz_count = excluded.biz_count,
    any_contact_pct = excluded.any_contact_pct,
    payload = excluded.payload;
  return 'ok';
end $$;

grant execute on function bo.rpc_run_archive_upsert(
  text, text, timestamptz, text, text, text, text, int, numeric, jsonb
) to anon;

-- List metadata rows (no payloads) — powers the cloud-runs listing.
create or replace function bo.rpc_run_archive_list(
  p_limit int default 100
) returns table (
  run_id text, kind text, ts timestamptz, version text,
  country text, city text, category text,
  biz_count int, any_contact_pct numeric
)
language sql stable security definer set search_path = bo as $$
  select run_id, kind, ts, version, country, city, category,
         biz_count, any_contact_pct
  from bo.run_archive
  order by ts desc
  limit least(greatest(p_limit, 1), 300);
$$;

grant execute on function bo.rpc_run_archive_list(int) to anon;

-- Fetch one full run payload for restore.
create or replace function bo.rpc_run_archive_get(p_run_id text)
returns jsonb
language sql stable security definer set search_path = bo as $$
  select payload from bo.run_archive where run_id = left(p_run_id, 200);
$$;

grant execute on function bo.rpc_run_archive_get(text) to anon;

-- ── public wrappers (PostgREST serves public only) ──────────────────
create or replace function public.rpc_run_archive_upsert(
  p_run_id text, p_kind text, p_ts timestamptz, p_version text,
  p_country text, p_city text, p_category text,
  p_biz_count int, p_any_contact_pct numeric, p_payload jsonb
) returns text language sql volatile security definer set search_path = bo as
$$ select bo.rpc_run_archive_upsert(
  p_run_id, p_kind, p_ts, p_version, p_country, p_city, p_category,
  p_biz_count, p_any_contact_pct, p_payload); $$;

grant execute on function public.rpc_run_archive_upsert(
  text, text, timestamptz, text, text, text, text, int, numeric, jsonb
) to anon;

create or replace function public.rpc_run_archive_list(p_limit int default 100)
returns table (
  run_id text, kind text, ts timestamptz, version text,
  country text, city text, category text,
  biz_count int, any_contact_pct numeric
)
language sql stable security definer set search_path = bo as
$$ select * from bo.rpc_run_archive_list(p_limit); $$;

grant execute on function public.rpc_run_archive_list(int) to anon;

create or replace function public.rpc_run_archive_get(p_run_id text)
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.rpc_run_archive_get(p_run_id); $$;

grant execute on function public.rpc_run_archive_get(text) to anon;
