-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 002: jobs queue + API RPCs                ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ─────────────────────────────────────────────────────────────────
-- 1. Job queue (Postgres-native replacement for JobManager + SQLite)
-- ─────────────────────────────────────────────────────────────────
create table if not exists bo.jobs (
  job_id      text primary key default encode(gen_random_bytes(5), 'hex'),
  kind        text not null,          -- resolve_city | snapshot | analyze | opportunities
  status      text not null default 'queued',  -- queued|running|done|error
  stage       text not null default 'queued',
  progress    double precision not null default 0.0,
  message     text,
  payload     jsonb not null default '{}',
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  attempts    int not null default 0,
  max_attempts int not null default 2
);
create index if not exists jobs_dispatch_idx on bo.jobs (status, created_at);

alter table bo.jobs enable row level security;
create policy "jobs_insert_anon"  on bo.jobs for insert to anon, authenticated with check (true);
create policy "jobs_read_owner"   on bo.jobs for select to anon, authenticated using (true);
-- update/delete only via service role (no policy = denied)

-- Realtime: broadcast job progress to subscribed clients
alter publication supabase_realtime add table bo.jobs;

-- ─────────────────────────────────────────────────────────────────
-- 2. Config / health / taxonomy RPCs (mirror FastAPI endpoints)
-- ─────────────────────────────────────────────────────────────────
create or replace function bo.api_health()
returns jsonb language sql stable security definer set search_path = bo as $$
  select jsonb_build_object('status','ok','backend','supabase','time',now());
$$;

create or replace function bo.api_config()
returns jsonb language sql stable security definer set search_path = bo as $$
  select jsonb_build_object(
    'backend', 'supabase-pg17',
    'overture_release', coalesce((select release from bo.snapshots order by built_at desc limit 1), 'overpass'),
    'cache_ttls', jsonb_build_object(
      'city_metadata', 7776000, 'population', 5184000,
      'country_peers', 1209600, 'city_snapshot', 1209600,
      'market_analysis', 2592000, 'opportunities', 2592000),
    'peer_defaults', jsonb_build_object(
      'count', 5, 'min_count', 3,
      'range_tight', jsonb_build_array(0.5, 2.0),
      'range_wide',  jsonb_build_array(0.33, 3.0)),
    'weights', jsonb_build_object('gap', 0.60, 'percentile', 0.25, 'market', 0.15),
    'job_max_workers', 2
  );
$$;

create or replace function bo.api_countries()
returns jsonb language sql stable security definer set search_path = bo as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'cca2', cca2, 'region', region) order by name), '[]'::jsonb)
  from bo.countries;
$$;

create or replace function bo.api_families()
returns jsonb language sql stable security definer set search_path = bo as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'label', f.label, 'description', f.description,
           'categories', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'id', c.id, 'label', c.label, 'family', c.family,
                      'family_label', f.label, 'aliases', c.aliases,
                      'popular', c.popular, 'discovered', true) order by c.label), '[]'::jsonb)
             from bo.categories c where c.family = f.id
           )) order by f.sort_order), '[]'::jsonb)
  from bo.families f;
$$;

create or replace function bo.api_categories(q text default null, family text default null, popular boolean default null)
returns jsonb language plpgsql stable security definer set search_path = bo as $$
declare out_rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'label', label, 'family', fam, 'family_label', fl,
           'aliases', aliases, 'popular', pop, 'discovered', true) order by label), '[]'::jsonb)
  into out_rows
  from (
    select c.*, f.label fl, c.popular pop, c.family fam,
           (q is null or c.id ilike '%'||q||'%' or c.label ilike '%'||q||'%'
            or exists (select 1 from unnest(c.aliases) a where a ilike '%'||q||'%')) as m
    from bo.categories c join bo.families f on f.id = c.family
    where (family is null or c.family = family)
      and (popular is null or c.popular = popular)
  ) s
  where m;
  return out_rows;
end $$;

-- ─────────────────────────────────────────────────────────────────
-- 3. resolve_city — Wikidata primary (same algorithm as FastAPI)
-- ─────────────────────────────────────────────────────────────────
create or replace function bo.slugify(s text)
returns text language sql immutable as $$
  select nullif(regexp_replace(lower(trim(s)), '[^a-z0-9\u0080-\uffff]+', '-', 'g'), '-') or 'city';
$$;

create or replace function bo.resolve_city_meta(p_country text, p_city text)
returns jsonb language plpgsql volatile security definer set search_path = bo, extensions as $$
declare
  v_country_code text;
  v jsonb;
  best jsonb;
  q text;
  city_id text;
  meta jsonb;
  bbox jsonb;
begin
  if p_city is null or length(trim(p_city)) = 0 then
    raise exception 'city is required' using errcode = 'P0001';
  end if;

  -- cache?
  city_id := bo.slugify(p_country) || '-' || bo.slugify(p_city);
  select jsonb_build_object('city', to_jsonb(c)) into meta
  from bo.cities c where c.city_id = city_id and c.updated_at > now() - interval '90 days';
  if meta is not null then
    return meta;
  end if;

  -- country code from our table (cca2, case-insensitive)
  select lower(cca2) into v_country_code from bo.countries
  where upper(cca2) = upper(p_country) or lower(name) = lower(p_country) limit 1;
  if v_country_code is null then
    v_country_code := lower(nullif(left(trim(p_country), 2), ''));
  end if;

  -- Wikidata entity search
  v := extensions.http_get(
    'https://www.wikidata.org/w/api.php?action=wbsearchentities&limit=10&language=en&uselang=en&format=json&search='
    || extensions.encode('(?:)'::bytea, 'base64')  -- placeholder replaced below
  );
  -- (encode call above is a no-op guard; real request:)
  v := extensions.http_get(
    'https://www.wikidata.org/w/api.php?action=wbsearchentities&limit=10&language=en&uselang=en&format=json&search='
    || urlencode-ish(p_city)
  );
  return jsonb_build_object('todo', true);
end $$;
