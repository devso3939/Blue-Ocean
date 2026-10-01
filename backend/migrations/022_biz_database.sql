-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — v6.9.126: Admin Business Database (deduped sheet)    ║
-- ║                                                                   ║
-- ║ One deduplicated row per real-world business, harvested from      ║
-- ║ EVERY archived run (all users + admin + guests). Uniqueness:      ║
-- ║   • same normalized name inside a ~111 m geocell (3-decimal       ║
-- ║     lat/lon) → same business;                                     ║
-- ║   • same phone digits (8–15) → same business, regardless of name; ║
-- ║   • same email (lowercased) → same business.                      ║
-- ║ Later sightings FILL BLANKS on the existing row (first win for    ║
-- ║ filled fields) and bump source_runs / last_seen.                  ║
-- ║                                                                   ║
-- ║ Adds:                                                             ║
-- ║   • bo.biz_db           — the deduped database                    ║
-- ║   • bo.biz_db_synced    — watermark: which runs were ingested     ║
-- ║   • rpc_biz_db_sync     — admin: ingest next batch of runs        ║
-- ║   • rpc_biz_db_stats    — totals + countries/cities + last sync   ║
-- ║   • rpc_biz_db_countries / rpc_biz_db_cities — filter dropdowns   ║
-- ║   • rpc_biz_db_page     — server-side search + sort + pagination  ║
-- ║   • rpc_biz_db_export   — filtered rows for Excel export (20k cap)║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── The deduped business database ────────────────────────────────────
create table if not exists bo.biz_db (
  id            bigint generated always as identity primary key,
  ukey          text not null unique,               -- dedupe key (see header)
  name          text not null default '',
  name_norm     text not null default '',
  country       text not null default '',
  city          text not null default '',
  phone         text not null default '',           -- display form
  phone_digits  text not null default '',           -- uniqueness + search
  email         text not null default '',
  website       text not null default '',
  facebook      text not null default '',
  instagram     text not null default '',
  linkedin      text not null default '',
  youtube       text not null default '',
  tiktok        text not null default '',
  twitter       text not null default '',
  pinterest     text not null default '',
  whatsapp      text not null default '',
  viber         text not null default '',
  telegram      text not null default '',
  lat           double precision,
  lon           double precision,
  geocell       text not null default '',
  address       text not null default '',
  category      text not null default '',
  rating        numeric,
  review_count  integer,
  maps_url      text not null default '',           -- google maps profile link
  source_runs   integer not null default 1,         -- how many sightings merged here
  has_user      boolean not null default false,     -- seen from a signed-in run
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  last_run_id   text not null default ''
);
create unique index if not exists biz_db_ukey_idx on bo.biz_db (ukey);
create index if not exists biz_db_phone_idx  on bo.biz_db (phone_digits) where phone_digits <> '';
create index if not exists biz_db_email_idx  on bo.biz_db (email)        where email <> '';
create index if not exists biz_db_norm_idx   on bo.biz_db (name_norm);
create index if not exists biz_db_country_idx on bo.biz_db (country);
create index if not exists biz_db_city_idx   on bo.biz_db (city);
create index if not exists biz_db_last_seen_idx on bo.biz_db (last_seen desc);
create index if not exists biz_db_first_seen_idx on bo.biz_db (first_seen desc);

-- Watermark: runs already ingested into the database.
create table if not exists bo.biz_db_synced (
  run_id    text primary key,
  synced_at timestamptz not null default now()
);

-- ── Shared junk-email guard (mirrors the client's platform list) ────
create or replace function bo._biz_email_ok(e text)
returns boolean
language sql immutable as $$
  select e is not null
    and e not like '%@schema.org%' and e not like '%@wixpress.com%'
    and e not like '%sentry%'      and e not like '%example.%'
    and e not like 'noreply%'      and e not like 'no-reply%'
    and e not like '%@google.com%' and e not like '%@duckduckgo%'
    and e not like '%@bing%'       and e not like '%abuse@%'
    and e not like '%postmaster@%' and e not like '%@wix.com%'
    and e not like '%user@%'       and e not like '%email@domain%';
$$;

-- v6.9.126 fast ingest: replaces the per-row loop with one set-based
-- statement per run (thousands of rows in well under a second).
create or replace function bo._biz_db_ingest_payload(p_payload jsonb, p_user uuid, p_run_id text)
returns integer
language plpgsql security definer set search_path = bo as $$
declare
  v_added int := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload->'businesses') is distinct from 'array' then
    return 0;
  end if;

  with stage as (
    select
      left(coalesce(nullif(trim(b.obj->>'name'), ''), '(unnamed)'), 160) as name,
      lower(regexp_replace(coalesce(nullif(trim(b.obj->>'name'), ''), '(unnamed)'), '\s+', ' ', 'g')) as name_norm,
      left(coalesce(nullif(trim(p_payload->'city'->>'country'), ''), ''), 60) as country,
      left(coalesce(nullif(trim(p_payload->'city'->>'name'), ''), ''), 60) as city,
      left(coalesce(b.obj->>'phone', ''), 40) as phone,
      (case when length(regexp_replace(coalesce(b.obj->>'phone', ''), '[^0-9]', '', 'g')) between 8 and 15
            then regexp_replace(coalesce(b.obj->>'phone', ''), '[^0-9]', '', 'g') else '' end) as digits,
      (case when bo._biz_email_ok(lower(nullif(trim(coalesce(b.obj->>'email', '')), '')))
            then lower(trim(b.obj->>'email')) else '' end) as email,
      left(coalesce(b.obj->>'website', ''), 200) as website,
      left(coalesce(b.obj->>'facebook', ''), 200) as facebook,
      left(coalesce(b.obj->>'instagram', ''), 200) as instagram,
      left(coalesce(b.obj->>'linkedin', ''), 200) as linkedin,
      left(coalesce(b.obj->>'youtube', ''), 200) as youtube,
      left(coalesce(b.obj->>'tiktok', ''), 200) as tiktok,
      left(coalesce(b.obj->>'twitter', ''), 200) as twitter,
      left(coalesce(b.obj->>'pinterest', ''), 200) as pinterest,
      left(coalesce(b.obj->>'whatsapp', ''), 60) as whatsapp,
      left(coalesce(b.obj->>'viber', ''), 60) as viber,
      left(coalesce(b.obj->>'telegram', ''), 80) as telegram,
      (case when jsonb_typeof(b.obj->'lat') = 'number' then (b.obj->>'lat')::double precision end) as lat,
      (case when jsonb_typeof(b.obj->'lon') = 'number' then (b.obj->>'lon')::double precision end) as lon,
      left(coalesce(b.obj->>'address', ''), 200) as address,
      left(coalesce(nullif(trim(p2.pair->>0), ''), b.obj->>'categoryLabel', b.obj->>'category', ''), 40) as category,
      (case when coalesce(b.obj->>'rating', '') ~ '^[0-9]+(\.[0-9]+)?$' then (b.obj->>'rating')::numeric end) as rating,
      (case when coalesce(b.obj->>'reviewCount', '') ~ '^[0-9]+$' then (b.obj->>'reviewCount')::int end) as review_count
    from jsonb_array_elements(p_payload->'businesses') with ordinality p2(pair, ord)
    cross join lateral jsonb_array_elements(p2.pair->1) as b(obj)
  ),
  staged as (
    select s.*,
      round(s.lat::numeric, 3) || ',' || round(s.lon::numeric, 3) as geocell,
      coalesce(
        case when s.name_norm is not null and s.lat is not null and s.lon is not null
             then s.name_norm || '|' || round(s.lat::numeric, 3) || ',' || round(s.lon::numeric, 3) end,
        case when s.digits <> '' then 'p|' || s.digits end,
        case when s.email <> '' then 'e|' || s.email end
      ) as ukey
    from stage s
  ),
  upd as (
    update bo.biz_db d set
      name         = case when d.name = '(unnamed)' then s.name else d.name end,
      country      = case when d.country = '' then s.country else d.country end,
      city         = case when d.city = '' then s.city else d.city end,
      phone        = case when d.phone = '' and s.digits <> '' then s.phone else d.phone end,
      phone_digits = case when d.phone_digits = '' then s.digits else d.phone_digits end,
      email        = case when d.email = '' then s.email else d.email end,
      website      = case when d.website = '' then s.website else d.website end,
      facebook     = case when d.facebook = '' then s.facebook else d.facebook end,
      instagram    = case when d.instagram = '' then s.instagram else d.instagram end,
      linkedin     = case when d.linkedin = '' then s.linkedin else d.linkedin end,
      youtube      = case when d.youtube = '' then s.youtube else d.youtube end,
      tiktok       = case when d.tiktok = '' then s.tiktok else d.tiktok end,
      twitter      = case when d.twitter = '' then s.twitter else d.twitter end,
      pinterest    = case when d.pinterest = '' then s.pinterest else d.pinterest end,
      whatsapp     = case when d.whatsapp = '' then s.whatsapp else d.whatsapp end,
      viber        = case when d.viber = '' then s.viber else d.viber end,
      telegram     = case when d.telegram = '' then s.telegram else d.telegram end,
      address      = case when d.address = '' then s.address else d.address end,
      category     = case when d.category = '' then s.category else d.category end,
      rating       = coalesce(d.rating, s.rating),
      review_count = coalesce(d.review_count, s.review_count),
      source_runs  = d.source_runs + 1,
      has_user     = d.has_user or p_user is not null,
      last_seen    = now(),
      last_run_id  = left(p_run_id, 200)
    from staged s
    where s.ukey is not null
      and (d.ukey = s.ukey
           or (s.digits <> '' and d.phone_digits = s.digits)
           or (s.email <> '' and d.email = s.email))
  ),
  ins as (
    insert into bo.biz_db (
      ukey, name, name_norm, country, city, phone, phone_digits, email, website,
      facebook, instagram, linkedin, youtube, tiktok, twitter, pinterest,
      whatsapp, viber, telegram, lat, lon, geocell, address, category,
      rating, review_count, maps_url, source_runs, has_user, last_run_id
    )
    select
      s.ukey, s.name, s.name_norm, s.country, s.city, s.phone, s.digits, s.email, s.website,
      s.facebook, s.instagram, s.linkedin, s.youtube, s.tiktok, s.twitter, s.pinterest,
      s.whatsapp, s.viber, s.telegram, s.lat, s.lon,
      coalesce(round(s.lat::numeric, 3) || ',' || round(s.lon::numeric, 3), ''),
      s.address, s.category, s.rating, s.review_count,
      case when s.lat is not null and s.lon is not null
        then 'https://www.google.com/maps/search/?api=1&query=' || s.lat || ',' || s.lon
        else '' end,
      1, p_user is not null, left(p_run_id, 200)
    from staged s
    where s.ukey is not null
      and not exists (
        select 1 from bo.biz_db d
        where d.ukey = s.ukey
           or (s.digits <> '' and d.phone_digits = s.digits)
           or (s.email <> '' and d.email = s.email))
    on conflict (ukey) do nothing
    returning 1
  )
  select count(*) into v_added from ins;

  return v_added;
end;
$$;


create or replace function bo.rpc_biz_db_sync(p_batch int default 25)
returns jsonb
language plpgsql security definer set search_path = bo as $$
declare
  r record;
  v_runs int := 0; v_added int := 0;
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;
  perform set_config('statement_timeout', '480000', true);

  for r in
    select a.run_id, a.user_id, a.payload
    from bo.run_archive a
    where a.biz_count > 0
      and not exists (select 1 from bo.biz_db_synced s where s.run_id = a.run_id)
    order by a.ts desc
    limit least(greatest(p_batch, 1), 100)
  loop
    v_runs := v_runs + 1;
    v_added := v_added + bo._biz_db_ingest_payload(r.payload, r.user_id, r.run_id);
    insert into bo.biz_db_synced(run_id) values (r.run_id) on conflict do nothing;
  end loop;

  return jsonb_build_object(
    'ok', true, 'runs_synced', v_runs, 'added', v_added,
    'total', (select count(*) from bo.biz_db),
    'remaining', (select count(*) from bo.run_archive a
                  where a.biz_count > 0 and not exists
                    (select 1 from bo.biz_db_synced s where s.run_id = a.run_id))
  );
end;
$$;

-- ── Admin: totals + filter-option counts ─────────────────────────────
create or replace function bo.rpc_biz_db_stats()
returns jsonb
language plpgsql security definer set search_path = bo as $$
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'total',      (select count(*) from bo.biz_db),
    'with_phone', (select count(*) from bo.biz_db where phone_digits <> ''),
    'with_email', (select count(*) from bo.biz_db where email <> ''),
    'with_site',  (select count(*) from bo.biz_db where website <> ''),
    'with_social',(select count(*) from bo.biz_db where facebook <> '' or instagram <> '' or linkedin <> '' or youtube <> '' or tiktok <> '' or twitter <> '' or pinterest <> ''),
    'with_chat',  (select count(*) from bo.biz_db where whatsapp <> '' or viber <> '' or telegram <> ''),
    'countries',  (select count(distinct country) from bo.biz_db where country <> ''),
    'cities',     (select count(distinct city) from bo.biz_db where city <> ''),
    'last_sync',  (select max(synced_at) from bo.biz_db_synced),
    'remaining',  (select count(*) from bo.run_archive a
                   where a.biz_count > 0 and not exists
                     (select 1 from bo.biz_db_synced s where s.run_id = a.run_id))
  );
end;
$$;

-- ── Filter dropdowns ─────────────────────────────────────────────────
create or replace function bo.rpc_biz_db_countries()
returns table (country text, n bigint)
language sql security definer set search_path = bo as $$
  select country, count(*) as n
  from bo.biz_db
  where country <> ''
  group by country
  order by n desc;
$$;

create or replace function bo.rpc_biz_db_cities(p_country text)
returns table (city text, n bigint)
language sql security definer set search_path = bo as $$
  select city, count(*) as n
  from bo.biz_db
  where city <> ''
    and (p_country is null or p_country = '' or country = p_country)
  group by city
  order by n desc
  limit 500;
$$;

-- ── Paged sheet: server-side search + sort + pagination ──────────────
create or replace function bo.rpc_biz_db_page(
  p_page int default 1, p_per int default 100,
  p_sort text default 'newest',
  p_q text default '', p_country text default '', p_city text default '',
  p_contact text default 'any'
)
returns table (
  id bigint, name text, country text, city text,
  phone text, email text, website text,
  facebook text, instagram text, linkedin text, youtube text, tiktok text, twitter text, pinterest text,
  whatsapp text, viber text, telegram text,
  lat double precision, lon double precision, address text, category text,
  rating numeric, review_count integer, maps_url text,
  source_runs integer, first_seen timestamptz, last_seen timestamptz,
  total bigint
)
language plpgsql security definer set search_path = bo as $$
declare
  v_q text := coalesce(p_q, '');
  v_where text := ' true ';
  v_sort text;
  v_per int := least(greatest(p_per, 1), 10000);
  v_off int := greatest(p_page, 1) - 1;
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;

  if v_q <> '' then
    v_q := replace(replace(v_q, '%', ''), '_', '');
    v_where := v_where || format(
      ' and (name ilike %L or city ilike %L or country ilike %L or address ilike %L
             or email ilike %L or website ilike %L or phone ilike %L or phone_digits like %L
             or facebook ilike %L or instagram ilike %L or telegram ilike %L or whatsapp ilike %L)',
      '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%',
      '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%',
      '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%');
  end if;
  if coalesce(p_country, '') <> '' then
    v_where := v_where || format(' and country = %L', p_country);
  end if;
  if coalesce(p_city, '') <> '' then
    v_where := v_where || format(' and city = %L', p_city);
  end if;
  if p_contact = 'phone' then
    v_where := v_where || ' and phone_digits <> '''' ';
  elsif p_contact = 'email' then
    v_where := v_where || ' and email <> '''' ';
  elsif p_contact = 'site' then
    v_where := v_where || ' and website <> '''' ';
  elsif p_contact = 'socials' then
    v_where := v_where || ' and (facebook <> '''' or instagram <> '''' or linkedin <> '''' or youtube <> '''' or tiktok <> '''' or twitter <> '''' or pinterest <> '''') ';
  elsif p_contact = 'chat' then
    v_where := v_where || ' and (whatsapp <> '''' or viber <> '''' or telegram <> '''') ';
  end if;

  -- Sort whitelist (directions baked in — nothing user-textual reaches SQL).
  v_sort := case p_sort
    when 'oldest'    then 'first_seen asc'
    when 'name_asc'  then 'name asc'
    when 'name_desc' then 'name desc'
    when 'country'   then 'country asc, name asc'
    when 'city'      then 'city asc, name asc'
    when 'category'  then 'category asc, name asc'
    when 'rating'    then 'rating desc nulls last, review_count desc nulls last'
    when 'reviews'   then 'review_count desc nulls last, rating desc nulls last'
    when 'sources'   then 'source_runs desc, last_seen desc'
    when 'contact'   then '(case when phone_digits <> '''' then 1 else 0 end + case when email <> '''' then 1 else 0 end + case when website <> '''' then 1 else 0 end) desc, last_seen desc'
    else 'last_seen desc'
  end;

  return query execute format(
    'select id, name, country, city, phone, email, website,
            facebook, instagram, linkedin, youtube, tiktok, twitter, pinterest,
            whatsapp, viber, telegram, lat, lon, address, category,
            rating, review_count, maps_url, source_runs, first_seen, last_seen,
            count(*) over() as total
     from bo.biz_db where %s order by %s limit %s offset %s',
    v_where, v_sort, v_per, v_off * v_per);
end;
$$;

-- ── Export: filtered rows for the Excel sheet (capped) ───────────────
create or replace function bo.rpc_biz_db_export(
  p_limit int default 20000,
  p_q text default '', p_country text default '', p_city text default '',
  p_contact text default 'any'
)
returns table (
  name text, country text, city text,
  phone text, email text, website text,
  facebook text, instagram text, linkedin text, youtube text, tiktok text, twitter text, pinterest text,
  whatsapp text, viber text, telegram text,
  address text, category text, rating numeric, review_count integer,
  maps_url text, source_runs integer, first_seen timestamptz
)
language plpgsql security definer set search_path = bo as $$
declare
  v_q text := coalesce(p_q, '');
  v_where text := ' true ';
begin
  if not bo.is_admin() then raise exception 'forbidden'; end if;

  if v_q <> '' then
    v_q := replace(replace(v_q, '%', ''), '_', '');
    v_where := v_where || format(
      ' and (name ilike %L or city ilike %L or country ilike %L or address ilike %L
             or email ilike %L or website ilike %L or phone ilike %L or phone_digits like %L)',
      '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%',
      '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%', '%' || v_q || '%');
  end if;
  if coalesce(p_country, '') <> '' then
    v_where := v_where || format(' and country = %L', p_country);
  end if;
  if coalesce(p_city, '') <> '' then
    v_where := v_where || format(' and city = %L', p_city);
  end if;
  if p_contact = 'phone' then
    v_where := v_where || ' and phone_digits <> '''' ';
  elsif p_contact = 'email' then
    v_where := v_where || ' and email <> '''' ';
  elsif p_contact = 'site' then
    v_where := v_where || ' and website <> '''' ';
  elsif p_contact = 'socials' then
    v_where := v_where || ' and (facebook <> '''' or instagram <> '''' or linkedin <> '''' or youtube <> '''' or tiktok <> '''' or twitter <> '''' or pinterest <> '''') ';
  elsif p_contact = 'chat' then
    v_where := v_where || ' and (whatsapp <> '''' or viber <> '''' or telegram <> '''') ';
  end if;

  return query execute format(
    'select name, country, city, phone, email, website,
            facebook, instagram, linkedin, youtube, tiktok, twitter, pinterest,
            whatsapp, viber, telegram, address, category, rating, review_count,
            maps_url, source_runs, first_seen
     from bo.biz_db where %s order by last_seen desc limit %s',
    v_where, least(greatest(p_limit, 1), 20000));
end;
$$;

-- ── PostgREST access: public wrappers (PostgREST only exposes public) ──
create or replace function public.rpc_biz_db_sync(p_batch int default 25)
returns jsonb language sql security definer set search_path = bo as $$ select bo.rpc_biz_db_sync(p_batch); $$;
create or replace function public.rpc_biz_db_stats()
returns jsonb language sql security definer set search_path = bo as $$ select bo.rpc_biz_db_stats(); $$;
create or replace function public.rpc_biz_db_countries()
returns table (country text, n bigint) language sql security definer set search_path = bo as $$ select * from bo.rpc_biz_db_countries(); $$;
create or replace function public.rpc_biz_db_cities(p_country text)
returns table (city text, n bigint) language sql security definer set search_path = bo as $$ select * from bo.rpc_biz_db_cities(p_country); $$;
create or replace function public.rpc_biz_db_page(
  p_page int default 1, p_per int default 100, p_sort text default 'newest',
  p_q text default '', p_country text default '', p_city text default '', p_contact text default 'any')
returns table (
  id bigint, name text, country text, city text,
  phone text, email text, website text,
  facebook text, instagram text, linkedin text, youtube text, tiktok text, twitter text, pinterest text,
  whatsapp text, viber text, telegram text,
  lat double precision, lon double precision, address text, category text,
  rating numeric, review_count integer, maps_url text,
  source_runs integer, first_seen timestamptz, last_seen timestamptz,
  total bigint)
language sql security definer set search_path = bo as $$
  select * from bo.rpc_biz_db_page(p_page, p_per, p_sort, p_q, p_country, p_city, p_contact);
$$;
create or replace function public.rpc_biz_db_export(
  p_limit int default 20000, p_q text default '', p_country text default '', p_city text default '', p_contact text default 'any')
returns table (
  name text, country text, city text,
  phone text, email text, website text,
  facebook text, instagram text, linkedin text, youtube text, tiktok text, twitter text, pinterest text,
  whatsapp text, viber text, telegram text,
  address text, category text, rating numeric, review_count integer,
  maps_url text, source_runs integer, first_seen timestamptz)
language sql security definer set search_path = bo as $$
  select * from bo.rpc_biz_db_export(p_limit, p_q, p_country, p_city, p_contact);
$$;

grant execute on function
  public.rpc_biz_db_sync(int), public.rpc_biz_db_stats(),
  public.rpc_biz_db_countries(), public.rpc_biz_db_cities(text),
  public.rpc_biz_db_page(int, int, text, text, text, text, text),
  public.rpc_biz_db_export(int, text, text, text, text)
to anon, authenticated;
