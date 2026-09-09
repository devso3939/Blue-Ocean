-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 004: city resolution (Wikidata+Nominatim) ║
-- ╚══════════════════════════════════════════════════════════════════╝

create or replace function bo.slugify(s text)
returns text language sql immutable as $$
  select coalesce(nullif(regexp_replace(lower(trim(s)), '[^a-z0-9\u0080-\uffff]+', '-', 'g'), '-'), 'city');
$$;

-- RFC 3986 percent-encoding (UTF-8 aware)
create or replace function bo.urlencode(s text)
returns text language plpgsql immutable as $$
declare
  i int; ch text; res text := ''; b bytea; j int; byte int;
begin
  if s is null then return ''; end if;
  for i in 1..length(s) loop
    ch := substr(s, i, 1);
    if ch ~ '[A-Za-z0-9\-_.~]' then
      res := res || ch;
    else
      b := convert_to(ch, 'UTF8');
      for j in 1..octet_length(b) loop
        byte := get_byte(b, j - 1);
        res := res || '%' || lpad(upper(to_hex(byte)), 2, '0');
      end loop;
    end if;
  end loop;
  return res;
end $$;

-- Resolve a city via Wikidata SPARQL (city/town/capital classes,
-- population P1082, coords P625, OSM relation P402, country ISO P297).
create or replace function bo.wikidata_resolve_city(p_country text, p_city text)
returns jsonb language plpgsql volatile security definer set search_path = bo, extensions as $$
declare
  v_cc text;
  v_sparql text;
  v_resp jsonb;
  cand jsonb;
  best jsonb;
  v_score bigint := -1;
  qid text; v_name text; v_country text; v_country_qid text;
  pop bigint; lat numeric; lon numeric; osm_rel bigint;
begin
  select lower(cca2) into v_cc from bo.countries
  where upper(cca2) = upper(p_country) or lower(name) = lower(p_country)
  limit 1;
  if v_cc is null then
    v_cc := lower(nullif(left(trim(coalesce(p_country, '')), 2), ''));
  end if;

  v_sparql :=
    'SELECT ?item ?itemLabel ?countryLabel ?country ?pop ?coord ?osm WHERE { ' ||
    '?item rdfs:label ' || '''' || replace(p_city, '''', '''''') || '''@en . ' ||
    '?item wdt:P1082 ?pop . ' ||
    (case when v_cc is not null then
      '?item wdt:P17 ?country . ?country wdt:P297 ''' || upper(v_cc) || ''' . '
    else '' end) ||
    '{ ?item wdt:P31/wdt:P279* wd:Q515 } UNION { ?item wdt:P31/wdt:P279* wd:Q3957 } ' ||
    'UNION { ?item wdt:P31/wdt:P279* wd:Q5119 } UNION { ?item wdt:P31/wdt:P279* wd:Q1549591 } . ' ||
    'OPTIONAL { ?item wdt:P625 ?coord . } ' ||
    'OPTIONAL { ?item wdt:P402 ?osm . } ' ||
    'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } ' ||
    '} ORDER BY DESC(?pop) LIMIT 5';

  select (extensions.http_get(
    'https://query.wikidata.org/sparql?format=json&query=' || bo.urlencode(v_sparql)
  )).content::jsonb into v_resp;

  if v_resp is null or jsonb_typeof(v_resp->'results'->'bindings') <> 'array'
     or jsonb_array_length(v_resp->'results'->'bindings') = 0 then
    return null;
  end if;

  for cand in select jsonb_array_elements(v_resp->'results'->'bindings') loop
    begin
      pop := nullif(regexp_replace(cand->'pop'->>'value', '[^0-9]', '', 'g'), '')::bigint;
      if pop is not null and pop > v_score then
        v_score := pop;
        best := cand;
      end if;
    exception when others then continue;
    end;
  end loop;
  if best is null then best := v_resp->'results'->'bindings'->0; end if;

  qid := 'Q' || split_part(best->'item'->>'value', 'Q', 2);
  v_name := coalesce(best->'itemLabel'->>'value', p_city);
  v_country := best->'countryLabel'->>'value';
  if best->'country'->>'value' is not null then
    v_country_qid := 'Q' || split_part(best->'country'->>'value', 'Q', 2);
  end if;
  pop := nullif(regexp_replace(coalesce(best->'pop'->>'value',''), '[^0-9]', '', 'g'), '')::bigint;

  if best->'coord'->>'value' is not null then
    begin
      -- Wikidata WKT format: "Point(lon lat)"
      declare
        inner_xy text := trim(split_part(split_part(best->'coord'->>'value', '(', 2), ')', 1));
      begin
        lon := round(split_part(inner_xy, ' ', 1)::numeric, 6);
        lat := round(split_part(inner_xy, ' ', 2)::numeric, 6);
      end;
    exception when others then lat := null; lon := null;
    end;
  end if;
  osm_rel := nullif(regexp_replace(coalesce(best->'osm'->>'value',''), '[^0-9]', '', 'g'), '')::bigint;

  return jsonb_build_object(
    'qid', qid, 'name', v_name, 'country', v_country,
    'country_qid', v_country_qid, 'country_code', v_cc,
    'population', pop, 'lat', lat, 'lon', lon,
    'osm_relation_id', osm_rel);
end $$;

-- Full resolve: cache check → Wikidata core → Nominatim boundary → upsert
create or replace function bo.resolve_city_meta(p_country text, p_city text)
returns jsonb language plpgsql volatile security definer set search_path = bo, extensions as $$
declare
  v_cc text;
  v_cc_name text;
  v_city_id text;
  w jsonb;
  nom jsonb;
  bbox jsonb;
  v_row bo.cities%rowtype;
  v_display text;
  v_pop bigint;
begin
  if p_city is null or length(trim(p_city)) = 0 then
    raise exception 'city is required' using errcode = 'P0001';
  end if;

  select lower(cca2), name into v_cc, v_cc_name from bo.countries
  where upper(cca2) = upper(p_country) or lower(name) = lower(p_country) limit 1;
  if v_cc is null then
    v_cc := lower(nullif(left(trim(coalesce(p_country, '')), 2), ''));
    v_cc_name := upper(v_cc);
  end if;
  v_city_id := bo.slugify(p_city) || '-' || v_cc;

  -- 0) cache hit?
  select * into v_row from bo.cities c where c.city_id = v_city_id;
  if found and v_row.updated_at > now() - interval '90 days' then
    return jsonb_build_object('city',
      jsonb_set(to_jsonb(v_row) - 'created_at', '{boundary}', coalesce(v_row.boundary, 'null'::jsonb)));
  end if;

  -- 1) Wikidata core
  w := bo.wikidata_resolve_city(p_country, p_city);
  if w is null then
    raise exception 'Could not find ''%'' in ''%''. Check the spelling or try a different country.',
      p_city, coalesce(v_cc_name, p_country) using errcode = 'P0001';
  end if;

  -- 2) Nominatim boundary enhancement (politeness sleep)
  if w->>'lat' is not null then
    begin
      perform pg_sleep(1.05);
      nom := (extensions.http_get(
        'https://nominatim.openstreetmap.org/search?format=json&limit=1&polygon_geojson=1&extratags=1&q='
        || bo.urlencode(w->>'name' || ', ' || coalesce(v_cc_name, upper(v_cc)))
      )).content::jsonb;
    exception when others then nom := null;
    end;
  end if;

  if nom is not null and jsonb_typeof(nom) = 'array' and jsonb_array_length(nom) > 0 then
    -- Nominatim boundingbox order: [south, north, west, east]
    bbox := jsonb_build_object(
      'min_lat', (nom->0->'boundingbox'->>0)::double precision,
      'max_lat', (nom->0->'boundingbox'->>1)::double precision,
      'min_lon', (nom->0->'boundingbox'->>2)::double precision,
      'max_lon', (nom->0->'boundingbox'->>3)::double precision);
    w := jsonb_set(w, '{bbox}', bbox, true);

    if jsonb_typeof(nom->0->'geojson') = 'object' then
      w := jsonb_set(w, '{boundary}', nom->0->'geojson', true);
      w := jsonb_set(w, '{boundary_type}', '"polygon"', true);
    else
      w := jsonb_set(w, '{boundary_type}', '"bbox"', true);
    end if;

    if nullif(nom->0->>'osm_id', '') is not null then
      w := jsonb_set(w, '{osm_type}', to_jsonb(coalesce(nullif(nom->0->>'osm_type',''), 'relation')), true);
      w := jsonb_set(w, '{osm_relation_id}', to_jsonb((nom->0->>'osm_id')::bigint), true);
    end if;
  end if;

  v_display := (w->>'name') || ', ' || coalesce(v_cc_name, (w->>'country'), upper(v_cc));
  v_pop := (w->>'population')::bigint;

  insert into bo.cities as c (city_id, name, display_name, country, country_code,
                              country_qid, wikidata_qid, osm_type, osm_id,
                              center_lat, center_lon, bbox, boundary, boundary_type,
                              population, population_source, updated_at)
  values (v_city_id, w->>'name', v_display,
          coalesce(v_cc_name, w->>'country'), v_cc,
          w->>'country_qid', w->>'qid', coalesce(w->>'osm_type', 'relation'),
          (w->>'osm_relation_id')::bigint,
          (w->>'lat')::double precision, (w->>'lon')::double precision,
          w->'bbox', w->'boundary', coalesce(w->>'boundary_type', 'bbox'),
          v_pop, 'wikidata', now())
  on conflict (city_id) do update set
    name = excluded.name, display_name = excluded.display_name,
    country = excluded.country, country_code = excluded.country_code,
    country_qid = excluded.country_qid, wikidata_qid = excluded.wikidata_qid,
    osm_type = excluded.osm_type, osm_id = excluded.osm_id,
    center_lat = excluded.center_lat, center_lon = excluded.center_lon,
    bbox = excluded.bbox, boundary = excluded.boundary,
    boundary_type = excluded.boundary_type,
    population = coalesce(excluded.population, c.population),
    population_source = excluded.population_source, updated_at = now()
  returning * into v_row;

  return jsonb_build_object('city',
    jsonb_set(to_jsonb(v_row) - 'created_at', '{boundary}', coalesce(v_row.boundary, 'null'::jsonb)));
end $$;
