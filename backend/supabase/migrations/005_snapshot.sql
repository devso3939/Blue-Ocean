-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 005: Overpass snapshot builder (pg_net)   ║
-- ║ Async HTTP via pg_net (no 5s cap): GET with data= param, mirror  ║
-- ║ rotation, internal polling. Same bo.build_snapshot signature.    ║
-- ╚══════════════════════════════════════════════════════════════════╝

drop function if exists bo.overpass_query(text);

-- ── Overpass fetch: GET data=<query> via pg_net, rotate mirrors ────
create or replace function bo.overpass_fetch(p_q text)
returns jsonb language plpgsql volatile security definer set search_path = bo, net as $$
declare
  mirrors text[] := array[
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  m text; mi int := 0;
  rid bigint;
  st int; body text; terr boolean; emsg text;
  v jsonb;
  deadline timestamptz;
begin
  deadline := now() + interval '4 minutes';
  while mi < array_length(mirrors, 1) loop
    m := mirrors[mi + 1];
    v := null;
    begin
      select net.http_get(m, jsonb_build_object('data', p_q::text), '{}'::jsonb, 120000)
        into rid;
      if rid is null then mi := mi + 1; continue; end if;

      loop
        perform pg_sleep(2);
        select status_code, content, timed_out, coalesce(error_msg,'')
          into st, body, terr, emsg
          from net._http_response where id = rid;
        if found then
          if st = 200 and body like '{%' then
            begin v := body::jsonb; exception when others then v := null; end;
            if v is not null and v ? 'elements' then
              return v;
            end if;
          end if;
          exit; -- this mirror answered but not usable → next mirror
        end if;
        exit when now() > deadline;
      end loop;
    exception when others then
      null; -- network error → next mirror
    end;
    mi := mi + 1;
    exit when now() > deadline;
  end loop;
  return null;
end $$;

-- ── Scan area: real bbox padded 15%, else population-scaled circle ──
create or replace function bo.scan_bbox(p_city bo.cities)
returns jsonb language plpgsql immutable as $$
declare
  s double precision; n double precision; w double precision; e double precision;
  span double precision;
  pad_lat double precision; pad_lon double precision;
  max_span constant double precision := 0.5;
  r double precision;
  lat double precision; lon double precision;
begin
  lat := p_city.center_lat; lon := p_city.center_lon;
  if p_city.bbox is not null and p_city.bbox ? 'min_lat' then
    s := (p_city.bbox->>'min_lat')::double precision;
    n := (p_city.bbox->>'max_lat')::double precision;
    w := (p_city.bbox->>'min_lon')::double precision;
    e := (p_city.bbox->>'max_lon')::double precision;
    if s < n and w < e and (n - s) < 0.9 then
      span := greatest(n - s, e - w);
      pad_lat := (n - s) * 0.15; pad_lon := (e - w) * 0.15;
      s := s - pad_lat; n := n + pad_lat; w := w - pad_lon; e := e + pad_lon;
      if n - s > max_span then
        s := greatest(s, lat - max_span / 2);
        n := least(n, s + max_span);
        if lat < s or lat > n then s := lat - max_span / 2; n := lat + max_span / 2; end if;
      end if;
      if e - w > max_span then
        w := greatest(w, lon - max_span / 2);
        e := least(e, w + max_span);
        if lon < w or lon > e then w := lon - max_span / 2; e := lon + max_span / 2; end if;
      end if;
      return jsonb_build_array(s, w, n, e);
    end if;
  end if;
  -- population-scaled circle: R = 600 * pop^0.25, clamp 6–35 km
  r := 10000.0;
  if p_city.population is not null and p_city.population > 0 then
    r := least(35000.0, greatest(6000.0, 600.0 * power(p_city.population::double precision, 0.25)));
  end if;
  return jsonb_build_array(
    lat - r / 111000.0,
    lon - r / (111000.0 * cos(radians(lat))),
    lat + r / 111000.0,
    lon + r / (111000.0 * cos(radians(lat))));
end $$;

-- ── Multilingual categorizer: OSM tags → category id ──────────────
create or replace function bo.categorize_osm(p_tags jsonb)
returns text language plpgsql immutable as $$
declare
  name text;
  shop text; amenity text; leisure text; tourism text;
  healthcare text; office text; craft text;
begin
  if p_tags is null or jsonb_typeof(p_tags) <> 'object' then return null; end if;
  name := coalesce(p_tags->>'name', '');
  shop := p_tags->>'shop'; amenity := p_tags->>'amenity';
  leisure := p_tags->>'leisure'; tourism := p_tags->>'tourism';
  healthcare := p_tags->>'healthcare'; office := p_tags->>'office';
  craft := p_tags->>'craft';

  -- ── food ──
  if amenity in ('cafe','restaurant','bar','pub','fast_food','food_court','ice_cream','biergarten') then
    return bo.map_food(amenity);
  end if;
  if craft in ('bakery','confectionery','pastry') then return 'bakery'; end if;
  if shop in ('bakery','pastry') then return 'bakery'; end if;
  if shop = 'deli' then return 'supermarket'; end if;

  -- ── health ──
  if amenity in ('pharmacy','hospital','clinic','dentist','doctors') then
    return case amenity
      when 'pharmacy' then 'pharmacy' when 'hospital' then 'hospital'
      when 'dentist' then 'dentist' else 'clinic' end;
  end if;
  if healthcare is not null then
    if healthcare in ('pharmacy','chemist') then return 'pharmacy'; end if;
    if healthcare in ('dentist','orthodontist') then return 'dentist'; end if;
    if healthcare = 'hospital' then return 'hospital'; end if;
    if healthcare = 'veterinary' then return 'veterinary'; end if;
    return 'clinic';
  end if;
  if amenity = 'veterinary' then return 'veterinary'; end if;
  if shop in ('chemist','medical_supply','orthopedic') then return 'pharmacy'; end if;
  if shop in ('optician','eyewear') then return 'optician'; end if;

  -- ── beauty / wellness ──
  if shop in ('hairdresser','wigs','hairdresser_supply') then return 'hair_salon'; end if;
  if shop in ('beauty','cosmetics','beauty_salon') then
    if p_tags->>'beauty' in ('nail','manicure','pedicure') then return 'nail_salon'; end if;
    if name ~* '(nail|manicure|pedicure|маникюр|ネイル|네일|美甲)' then return 'nail_salon'; end if;
    if p_tags->>'beauty' = 'massage' then return 'massage'; end if;
    return 'beauty_salon';
  end if;
  if shop in ('nail_salon','nails') then return 'nail_salon'; end if;
  if amenity in ('spa','sauna','public_bath','tanning_salon') or leisure in ('spa','sauna','tanning_salon') then
    return 'spa';
  end if;
  if amenity = 'massage' or shop = 'massage' then return 'massage'; end if;
  if shop in ('tattoo','tattoo_piercing','piercing') then return 'tattoo'; end if;

  -- ── fitness / sports ──
  if leisure in ('fitness_centre','sports_centre','sports_hall') then
    if name ~* '(yoga|пилатес|йога|ヨガ|요가|瑜伽)' then return 'yoga'; end if;
    if name ~* '(danc|ballet|танц|발레|댄스|舞蹈|バレエ)' then return 'dance'; end if;
    return 'gym';
  end if;
  if (p_tags ? 'sport' and p_tags->>'sport' ~* '(yoga|pilates)') then return 'yoga'; end if;
  if leisure in ('dance','dance_hall') or amenity = 'dancing_school' then return 'dance'; end if;
  if amenity in ('music_school','prep_school') then return 'music_school'; end if;

  -- ── retail ──
  if shop is not null then
    if shop in ('supermarket','greengrocer','cheese','chocolate','coffee','tea','seafood','farm','confectionery') then return 'supermarket'; end if;
    if shop in ('grocery','health_food','organic','nuts','spices','honey','bread','pasta','rice','dairy','eggs','milk','bulk_food','frozen_food','baby_food') then return 'grocery'; end if;
    if shop in ('convenience','kiosk','newsagent','variety_store','general','mini_market','outpost','e-cigarette','alcohol','wine','beer','spirits','beverages','tobacco') then return 'convenience'; end if;
    if shop in ('clothes','fashion','boutique','shoes','kids','baby','children','underwear','lingerie','swimwear','maternity','fabric','wool','accessories','sportswear','workwear','costume','formal','wedding_dress','leather','fur','denim') then return 'clothing'; end if;
    if shop in ('electronics','mobile_phone','computer','hifi','video_games','radiotechnics','appliance','camera','electrical','lighting','solar','hearing_aids') then return 'electronics'; end if;
    if shop in ('furniture','interior_decoration','mattress','curtain','kitchen','bathroom_furnishing','doors','windows','bed','bedding','ceramics','tiles','flooring','houseware','home_accessories','candles','fireplace') then return 'furniture'; end if;
    if shop in ('doityourself','trade','hardware','paint','building_materials','tools','sawmill','locksmith','electrician','glaziery','plumber') then return 'hardware'; end if;
    if shop in ('books','stationery','bookmaker') then return 'bookstore'; end if;
    if shop in ('jewelry','jewellery','watches') then return 'jewelry'; end if;
    if shop in ('sports','outdoor','ski','fishing','hunting','scuba_diving','surf','skateboard','diving') then return 'sports'; end if;
    if shop = 'bicycle' then return 'bicycle'; end if;
    if shop in ('laundry','dry_cleaning') then return 'laundry'; end if;
    if shop = 'florist' or craft = 'florist' then return 'florist'; end if;
    if shop in ('pet','pet_grooming','pet_groomer') then return 'pet_groomer'; end if;
    if shop in ('car_repair','car_parts','tyres','motorcycle','truck_repair','caravan','boat','oil') then return 'car_repair'; end if;
    if shop in ('department_store','mall','wholesale') then return 'department_store'; end if;
    if shop in ('second_hand','charity','antiques') then return 'market'; end if;
    if shop in ('printing','copyshop','print','printer_ink') or craft in ('printing','signmaker') then return 'printing'; end if;
    if shop = 'cleaning' then return 'cleaning'; end if;
    if shop in ('art','frame','gallery','toys','games','musical_instrument','gift','party','collectibles','novelty') then return 'art'; end if;
    if shop in ('travel_agency','ticket') then return 'travel_agency'; end if;
    if shop in ('money_lender','pawnbroker','currency_exchange','financial') then return 'bank'; end if;
    return null;
  end if;

  -- ── offices ──
  if office is not null then
    if office in ('coworking','coworking_space') then return 'coworking'; end if;
    if office in ('it','software','computer','it_company','web_design','web_developer','hosting','game_developer','technology','digital') then return 'software'; end if;
    if office in ('consulting','business_consulting','it_consulting','management_consulting','financial_consulting','employment_agency','staffing') then return 'it_consulting'; end if;
    if office in ('marketing','advertising','advertising_agency','marketing_agency','pr_agency','communications','media','newspaper','publisher','magazine','broadcasting','radio','tv','film','video_production','design','graphic_design') then return 'digital_marketing'; end if;
    if office in ('lawyer','attorney','notary','bailiff','law') then return 'lawyer'; end if;
    if office in ('accountant','tax_advisor','tax','audit','bookkeeping') then return 'accountant'; end if;
    if office in ('estate_agent','real_estate','property_management') then return 'real_estate'; end if;
    if office in ('insurance','insurance_broker') then return 'insurance'; end if;
    if office in ('travel_agent','tour_operator','tourism','guide','tour_guide') then return 'travel_agency'; end if;
    if office in ('courier','logistics','shipping','forwarding','transport','delivery','moving_company') then return 'courier'; end if;
    if office in ('telecommunication','telecom') then return 'web_agency'; end if;
    if office in ('financial','investment','bank','microfinance','money_lender') then return 'bank'; end if;
    if office in ('educational_institution','education','tutoring','tutor','training_institute','research','institute') then return 'school'; end if;
    if office in ('architect','engineer','engineering','surveyor','planner','construction_company','construction') then return 'hardware'; end if;
    if office in ('cleaning','cleaning_company') then return 'cleaning'; end if;
    if office in ('printing','publisher') then return 'printing'; end if;
    if office in ('energy_supplier','utility','water_utility','gas_utility','electric_utility') then return 'fuel'; end if;
    if office in ('ngo','charity','association','foundation','nonprofit') then return 'market'; end if;
    if office in ('company','yes','corporate','private','business','services','enterprise') then return 'software'; end if;
    return null;
  end if;

  -- ── leisure / tourism / civic ──
  if tourism is not null then
    if tourism in ('hotel','motel','apartment','guest_house','bed_and_breakfast','resort','chalet','aparthotel') then return 'hotel'; end if;
    if tourism = 'hostel' then return 'hostel'; end if;
    if tourism in ('museum','gallery','attraction','aquarium','zoo','theme_park') then return 'art'; end if;
    return null;
  end if;
  if amenity = 'bank' or amenity in ('bureau_de_change','money_transfer','microfinance') then return 'bank'; end if;
  if amenity in ('school','college','university','kindergarten','language_school','driving_school','training','childcare') then return 'school'; end if;
  if amenity = 'cinema' then return 'cinema'; end if;
  if amenity in ('nightclub','casino') then return 'night_club'; end if;
  if leisure in ('bowling_alley','escape_game','amusement_arcade','miniature_golf','trampoline_park','water_park') then return 'night_club'; end if;
  if amenity in ('car_rental','boat_rental') then return 'car_rental'; end if;
  if amenity = 'car_wash' then return 'car_wash'; end if;
  if amenity = 'fuel' then return 'fuel'; end if;
  if amenity = 'marketplace' then return 'marketplace'; end if;
  if amenity in ('post_office','post_partner') then return 'post_office'; end if;
  if amenity in ('library','books_mobile') then return 'library'; end if;
  if amenity in ('courier','parcel_pickup','parcel_locker','delivery_company') then return 'courier'; end if;
  if amenity = 'events_venue' then return 'wedding'; end if;
  if amenity = 'coworking_space' then return 'coworking'; end if;
  if amenity = 'internet_cafe' then return 'electronics'; end if;
  return null;
end $$;

-- helper for food amenity mapping
create or replace function bo.map_food(a text)
returns text language sql immutable as $$
  select case a
    when 'cafe' then 'cafe'
    when 'restaurant' then 'restaurant'
    when 'bar' then 'bar'
    when 'biergarten' then 'bar'
    when 'pub' then 'pub'
    when 'fast_food' then 'fast_food'
    when 'food_court' then 'fast_food'
    when 'ice_cream' then 'ice_cream'
    else null end;
$$;

-- ── Snapshot build: fetch + categorize + store ────────────────────
-- One Overpass query with all named POIs in the bbox; categorized at
-- write time with bo.categorize_osm. Polls pg_net internally.
create or replace function bo.build_snapshot(p_city_id text)
returns jsonb language plpgsql volatile security definer set search_path = bo, net as $$
declare
  c bo.cities%rowtype;
  bb jsonb;
  q text;
  v jsonb;
  n int := 0;
  counts jsonb;
  places jsonb;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then raise exception 'city not found: %', p_city_id using errcode='P0002'; end if;

  bb := bo.scan_bbox(c);

  q := '[out:json][timeout:100];' ||
    format('(node(%s,%s,%s,%s)["name"];way(%s,%s,%s,%s)["name"];);',
           bb->>0, bb->>1, bb->>2, bb->>3, bb->>0, bb->>1, bb->>2, bb->>3) ||
    'out body center 20000;';

  v := bo.overpass_fetch(q);
  if v is null then
    raise exception 'All Overpass mirrors failed for %', p_city_id using errcode='P0001';
  end if;

  -- set-based categorize + aggregate
  with e as (
    select jsonb_array_elements(v->'elements') el
  ),
  p as (
    select
      el->>'type' as typ, el->>'id' as oid,
      coalesce((el->>'lat')::double precision, (el->'center'->>'lat')::double precision) as lat,
      coalesce((el->>'lon')::double precision, (el->'center'->>'lon')::double precision) as lon,
      coalesce(el->'tags', '{}'::jsonb) as tags
    from e
  ),
  ok as (
    select p.*, bo.categorize_osm(tags) as cat
    from p
    where lat is not null and lon is not null
      and coalesce(tags->>'name','') <> ''
  )
  select
    (select count(*)::int from ok),
    (select coalesce(jsonb_object_agg(cat, cn), '{}'::jsonb)
       from (select cat, count(*) as cn from ok where cat is not null group by cat) z),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'id', typ || '/' || oid, 'name', tags->>'name',
              'lat', lat, 'lon', lon, 'cat', cat)), '[]'::jsonb)
       from (select * from ok limit 15000) l)
  into n, counts, places;

  insert into bo.snapshots (city_id, release, total_places, places, category_counts, source_quality)
  values (p_city_id, 'overpass', n, places, counts,
          jsonb_build_object('query_bbox', bb, 'built_by', 'supabase-pg17-pgnet'))
  on conflict (city_id, release) do update set
    built_at = now(), total_places = excluded.total_places,
    places = excluded.places, category_counts = excluded.category_counts,
    source_quality = excluded.source_quality;

  return jsonb_build_object('city_id', p_city_id, 'total_places', n, 'category_counts', counts);
end $$;
