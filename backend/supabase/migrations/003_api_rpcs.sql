-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 003: public API RPCs                      ║
-- ║ Mirrors the FastAPI surface so frontend/lib/api.ts keeps working ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── health / config ───────────────────────────────────────────────
create or replace function bo.api_health()
returns jsonb language sql stable security definer set search_path = bo as $$
  select jsonb_build_object('status','ok','backend','supabase-pg17','time',now());
$$;

create or replace function bo.api_config()
returns jsonb language sql stable security definer set search_path = bo as $$
  select jsonb_build_object(
    'backend', 'supabase-pg17',
    'provider', 'overpass',
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

-- ── taxonomy ──────────────────────────────────────────────────────
create or replace function bo.api_countries()
returns jsonb language sql stable security definer set search_path = bo as $$
  select coalesce(jsonb_agg(jsonb_build_object('name',name,'cca2',cca2,'region',region) order by name), '[]'::jsonb)
  from bo.countries;
$$;

create or replace function bo.api_families()
returns jsonb language sql stable security definer set search_path = bo as $$
  select coalesce(jsonb_agg(j order by sort_order), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', f.id, 'label', f.label, 'description', f.description,
      'categories', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', c.id, 'label', c.label, 'family', c.family,
                 'family_label', f.label, 'aliases', c.aliases,
                 'popular', c.popular, 'discovered', true) order by c.label)
        from bo.categories c where c.family = f.id
      ), '[]'::jsonb)
    ) j, f.sort_order
    from bo.families f
  ) s;
$$;

create or replace function bo.api_categories(q text default null, family text default null, popular boolean default null)
returns jsonb language plpgsql stable security definer set search_path = bo as $$
declare v jsonb; v_q text := q; v_family text := family; v_pop boolean := popular;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'label', c.label, 'family', c.family,
           'family_label', f.label, 'aliases', c.aliases,
           'popular', c.popular, 'discovered', true) order by c.label), '[]'::jsonb)
  into v
  from bo.categories c join bo.families f on f.id = c.family
  where (v_family is null or c.family = v_family)
    and (v_pop is null or c.popular = v_pop)
    and (v_q is null or c.id ilike '%'||v_q||'%' or c.label ilike '%'||v_q||'%'
         or exists (select 1 from unnest(c.aliases) a where a ilike '%'||v_q||'%'));
  return v;
end $$;

-- ── city + opportunities reads ────────────────────────────────────
create or replace function bo.api_city(p_city_id text)
returns jsonb language plpgsql stable security definer set search_path = bo as $$
declare c bo.cities%rowtype;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then raise exception 'city not found: %', p_city_id using errcode='P0002'; end if;
  return to_jsonb(c) - 'created_at';
end $$;

create or replace function bo.api_opportunities(p_city_id text)
returns jsonb language plpgsql stable security definer set search_path = bo as $$
declare
  c bo.cities%rowtype;
  s bo.snapshots%rowtype;
  peers jsonb;
  opps jsonb;
  warns jsonb;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then raise exception 'city not found: %', p_city_id using errcode='P0002'; end if;
  select * into s from bo.snapshots where city_id = p_city_id order by built_at desc limit 1;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'peer_city_id', peer_city_id, 'name', name,
           'country_code', country_code, 'population', population,
           'weight', weight, 'snapshot_ready', snapshot_ready,
           'total_places', total_places, 'category_count', category_count)), '[]'::jsonb)
    into peers from bo.peer_cities where city_id = p_city_id;

  select bo.compute_opportunities(p_city_id) into opps;
  select coalesce(jsonb_agg(w), '[]'::jsonb) into warns
    from bo.anomaly_warnings(p_city_id) w;

  return jsonb_build_object(
    'city', jsonb_set(to_jsonb(c) - 'created_at', '{boundary}', coalesce(c.boundary,'null'::jsonb)),
    'snapshot', jsonb_build_object('built_at', s.built_at, 'total_places', s.total_places),
    'peers', peers,
    'opportunities', opps,
    'anomaly_warnings', warns,
    'generated_at', now()
  );
end $$;

-- CSV export (mirrors /api/opportunities/{city_id}/export)
create or replace function bo.api_opportunities_export(p_city_id text)
returns text language plpgsql stable security definer set search_path = bo as $$
declare v jsonb; line text; out text;
begin
  select bo.api_opportunities(p_city_id) into v;
  if v is null then return 'rank,opportunity,family,existing,per_10k,expected,gap,gap_pct,score,confidence'; end if;
  out := 'rank,opportunity,family,existing,per_10k,expected,gap,gap_pct,score,confidence' || chr(10);
  for line in
    select concat_ws(',', (row_number() over (order by (o->>'score')::int desc))::text,
      '"' || replace(coalesce(o->>'label',''), '"', '""') || '"',
      '"' || replace(coalesce(o->>'family_label',''), '"', '""') || '"',
      coalesce(o->>'count','0'), coalesce(o->>'per_10k',''), coalesce(o->>'expected',''),
      coalesce(o->>'gap',''), coalesce(o->>'gap_pct',''),
      coalesce(o->>'score',''), coalesce(o->>'confidence',''))
    from jsonb_array_elements(v->'opportunities') o
  loop
    out := out || line || chr(10);
  end loop;
  return out;
end $$;
