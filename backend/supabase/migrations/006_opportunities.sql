-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 006: peers, benchmarks, scoring           ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Peer selection: same country first, then region, weight by log- ─
-- population closeness (port of services/peers.py).
create or replace function bo.select_peers(p_city_id text, p_count int default 5)
returns jsonb language plpgsql volatile security definer set search_path = bo as $$
declare
  c bo.cities%rowtype;
  pool jsonb;
  p jsonb;
  w double precision;
  inserted int := 0;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then raise exception 'city not found: %', p_city_id using errcode='P0002'; end if;

  delete from bo.peer_cities where city_id = p_city_id;

  -- candidates: same country first (prefer 3), then same region
  with cand as (
    select * from (
      (select *, 0 as pri from bo.cities
        where country_code = c.country_code and city_id <> c.city_id
          and population between 50000 and 10000000)
      union all
      (select *, 1 as pri from bo.cities
        where country_code <> c.country_code and city_id <> c.city_id
          and population between 150000 and 10000000
        order by abs(ln(population::double precision / greatest(c.population,1)))
        limit 40)
    ) x order by pri, abs(ln(population::double precision / greatest(c.population,1)))
    limit 60
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'city_id', city_id, 'name', name, 'country_code', country_code,
           'population', population, 'pri', pri)), '[]'::jsonb)
  into pool from cand;

  for p in select jsonb_array_elements(pool) loop
    exit when inserted >= p_count;
    w := 1.0 / (1.0 + abs(ln(greatest(p->>'population')::double precision) - ln(greatest(c.population,1)::double precision)));
    insert into bo.peer_cities (city_id, peer_city_id, name, country_code, population, weight)
    values (p_city_id, p->>'city_id', p->>'name', p->>'country_code', (p->>'population')::bigint, w)
    on conflict (city_id, peer_city_id) do nothing;
    inserted := inserted + 1;
  end loop;

  return jsonb_build_object('selected', inserted);
end $$;

-- ── Category statistics + score (port of services/analysis.py) ─────
create or replace function bo.category_stats(p_city_id text, p_category text)
returns jsonb language plpgsql stable security definer set search_path = bo as $$
declare
  c bo.cities%rowtype;
  s bo.snapshots%rowtype;
  counts jsonb;
  city_count int;
  per_10k double precision;
  bench double precision;
  expected double precision;
  gap double precision;
  gap_pct double precision;
  rec record;
  vals double precision[];
  v double precision;
  qualified int := 0;
  total_w double precision := 0;
  cum double precision;
  pv double precision;
  peer_min int;
  percentile double precision;
  market double precision;
  gap_score double precision;
  score double precision;
  conf double precision;
  warns jsonb := '[]'::jsonb;
  label text; fam text; fam_label text;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then return null; end if;
  select * into s from bo.snapshots where city_id = p_city_id order by built_at desc limit 1;
  if not found then return null; end if;

  counts := s.category_counts;
  city_count := coalesce((counts->>p_category)::int, 0);
  per_10k := case when c.population > 0 then city_count::double precision / c.population * 10000 else null end;

  select cat.label, cat.family into label, fam from bo.categories cat where cat.id = p_category;
  fam_label := coalesce((select fl.label from bo.families fl where fl.id = fam), 'Other');

  -- benchmark: weighted median of peer per-10k values (per-category counts
  -- read live from each peer's snapshot; requires a fresh peer snapshot)
  peer_min := least(3, greatest(1, ceil(city_count / 2.0)::int));
  for rec in
    select pc.weight, pc.population,
           coalesce((ps.category_counts ->> p_category)::int, 0) as cat_cnt
    from bo.peer_cities pc
    join bo.snapshots ps on ps.city_id = pc.peer_city_id
    where pc.city_id = p_city_id
      and ps.built_at > now() - interval '30 days'
  loop
    if rec.cat_cnt >= peer_min and rec.population > 0 then
      pv := rec.cat_cnt::double precision / rec.population * 10000;
      vals := vals || pv;
      total_w := total_w + rec.weight;
    end if;
  end loop;

  if array_length(vals, 1) is null then
    -- fall back to curated benchmark
    select cb.per_10k into bench from bo.category_benchmarks cb where cb.category_id = p_category;
  else
    -- weighted median
    cum := 0;
    bench := null;
    for i in 1..array_length(vals,1) loop
      -- weights per value reconstructed approximately by uniform share
      cum := cum + total_w / array_length(vals,1);
      if cum >= total_w / 2 and bench is null then
        bench := vals[i];
      end if;
    end loop;
    if bench is null then bench := vals[array_length(vals,1)]; end if;
  end if;

  expected := case when bench is not null and c.population > 0
                   then bench * c.population / 10000.0 else null end;
  gap := case when expected is not null then expected - city_count else null end;
  gap_pct := case when gap is not null and expected > 0 then gap / expected else null end;

  -- percentile of city among peers
  if per_10k is not null and array_length(vals,1) is not null then
    qualified := array_length(vals,1);
    percentile := 100.0 * (qualified - (select count(*) from unnest(vals) u where u < per_10k)) / greatest(qualified, 1);
    percentile := least(100.0, greatest(0.0, percentile));
  else
    percentile := 50.0;
  end if;

  -- market size score: 15..100 log-scaled vs 250k..10M
  if c.population > 0 then
    market := greatest(15.0, least(100.0,
      100.0 * (0.5 + 0.5 * (ln(greatest(c.population,1)::double precision / 250000.0) / ln(10000000.0 / 250000.0)))));
  else
    market := 40.0;
  end if;

  gap_score := case when gap_pct is null then 50.0
    else 50.0 * (1.0 + tanh(least(2.5, greatest(-1.5, gap_pct)) * 1.4)) end;

  score := round(0.60 * gap_score + 0.25 * percentile + 0.15 * market);

  -- confidence: penalize thin data
  conf := 50.0;
  if city_count > 0 then conf := conf + 15; end if;
  if array_length(vals,1) is not null then conf := conf + 15; end if;
  if bench is not null then conf := conf + 10; end if;
  if c.boundary_type = 'polygon' then conf := conf + 5; end if;
  if c.population is null then conf := conf - 20; end if;
  conf := least(95.0, greatest(10.0, conf));

  if c.population is null then
    warns := warns || to_jsonb('No population known — gap metrics neutralized'::text);
  end if;
  if bench is null then
    warns := warns || to_jsonb('No benchmark data for category ' || p_category::text);
  end if;

  return jsonb_build_object(
    'category', p_category, 'label', coalesce(label, p_category),
    'family', fam, 'family_label', fam_label,
    'count', city_count, 'per_10k', per_10k,
    'benchmark', bench, 'expected', expected, 'gap', gap, 'gap_pct', gap_pct,
    'score', score, 'confidence', conf, 'warnings', warns,
    'peer_n', coalesce(array_length(vals,1), 0),
    'components', jsonb_build_object('gap_score', gap_score, 'undersupply_percentile', percentile, 'market_size_score', market),
    'score_label', case
      when score is null then 'Insufficient Data'
      when score >= 90 then 'Exceptional Opportunity'
      when score >= 80 then 'Very Strong Opportunity'
      when score >= 70 then 'Strong Opportunity'
      when score >= 60 then 'Potential Opportunity'
      when score >= 45 then 'Balanced / Unclear'
      when score >= 30 then 'Competitive'
      else 'Highly Saturated' end);
end $$;

-- ── All-category scan (used by api_opportunities) ──────────────────
create or replace function bo.compute_opportunities(p_city_id text)
returns jsonb language plpgsql stable security definer set search_path = bo as $$
declare
  counts jsonb;
  k text;
  out jsonb := '[]'::jsonb;
  st jsonb;
begin
  select category_counts into counts from bo.snapshots
  where city_id = p_city_id order by built_at desc limit 1;
  if counts is null then return out; end if;

  -- benchmark the categories present in the snapshot + curated list
  for k in select key from jsonb_object_keys(counts) k(key)
           where (counts->>key)::int > 0
           union
           select category_id from bo.category_benchmarks
  loop
    st := bo.category_stats(p_city_id, k);
    if st is not null and (st->>'count')::int >= 0 then
      out := out || st;
    end if;
  end loop;

  return out;
end $$;

-- ── Anomaly warnings (plausibility bands port, abridged) ───────────
create or replace function bo.anomaly_warnings(p_city_id text)
returns table(warning jsonb) language plpgsql stable security definer set search_path = bo as $$
declare
  c bo.cities%rowtype;
  counts jsonb; k text; cnt int; per10k double precision;
  minv double precision; maxv double precision;
  rec record;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found or c.population is null or c.population <= 0 then return; end if;
  select category_counts into counts from bo.snapshots
  where city_id = p_city_id order by built_at desc limit 1;
  if counts is null then return; end if;

  for rec in
    select key, (value->>'min')::double precision as mn, (value->>'max')::double precision as mx
    from jsonb_each(bo.sanity_bands())
  loop
    k := rec.key; minv := rec.mn; maxv := rec.mx;
    cnt := coalesce((counts->>k)::int, 0);
    if cnt = 0 then continue; end if;
    per10k := cnt::double precision / c.population * 10000;
    if per10k < minv then
      warning := jsonb_build_object('category', k, 'type', 'low',
        'per_10k', per10k, 'min', minv,
        'message', format('%s density (%s per 10k) is below the plausible band (%s) — likely missing data, not real undersupply', k, round(per10k::numeric,2), minv));
      return next;
    elsif per10k > maxv then
      warning := jsonb_build_object('category', k, 'type', 'high',
        'per_10k', per10k, 'max', maxv,
        'message', format('%s density (%s per 10k) exceeds the plausible band (%s)', k, round(per10k::numeric,2), maxv));
      return next;
    end if;
  end loop;
end $$;

-- Sanity bands (port of SANITY_BANDS from clientEngine.ts)
create or replace function bo.sanity_bands()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'cafe', jsonb_build_object('min',0.5,'max',40),
    'restaurant', jsonb_build_object('min',0.5,'max',40),
    'fast_food', jsonb_build_object('min',0.2,'max',25),
    'bar', jsonb_build_object('min',0.1,'max',20),
    'convenience', jsonb_build_object('min',1,'max',50),
    'supermarket', jsonb_build_object('min',0.5,'max',12),
    'bakery', jsonb_build_object('min',0.3,'max',15),
    'pharmacy', jsonb_build_object('min',0.4,'max',12),
    'bank', jsonb_build_object('min',0.4,'max',12),
    'hotel', jsonb_build_object('min',0.3,'max',25),
    'hostel', jsonb_build_object('min',0.15,'max',25),
    'beauty_salon', jsonb_build_object('min',0.5,'max',30),
    'clothing', jsonb_build_object('min',0.5,'max',35),
    'electronics', jsonb_build_object('min',0.2,'max',15),
    'furniture', jsonb_build_object('min',0.1,'max',10),
    'hardware', jsonb_build_object('min',0.1,'max',10),
    'car_repair', jsonb_build_object('min',0.3,'max',15),
    'gym', jsonb_build_object('min',0.3,'max',12),
    'school', jsonb_build_object('min',0.8,'max',20),
    'clinic', jsonb_build_object('min',0.5,'max',15),
    'dentist', jsonb_build_object('min',0.3,'max',10),
    'hair_salon', jsonb_build_object('min',0.3,'max',20),
    'software', jsonb_build_object('min',0.5,'max',80),
    'lawyer', jsonb_build_object('min',0.2,'max',25),
    'accountant', jsonb_build_object('min',0.2,'max',20),
    'real_estate', jsonb_build_object('min',0.2,'max',20),
    'travel_agency', jsonb_build_object('min',0.1,'max',8),
    'printing', jsonb_build_object('min',0.15,'max',8),
    'cleaning', jsonb_build_object('min',0.05,'max',8),
    'it_consulting', jsonb_build_object('min',0.2,'max',60),
    'digital_marketing', jsonb_build_object('min',0.1,'max',30),
    'courier', jsonb_build_object('min',0.05,'max',8),
    'coworking', jsonb_build_object('min',0.05,'max',5),
    'nail_salon', jsonb_build_object('min',0.1,'max',15),
    'spa', jsonb_build_object('min',0.05,'max',10),
    'massage', jsonb_build_object('min',0.05,'max',12),
    'dance', jsonb_build_object('min',0.05,'max',8),
    'yoga', jsonb_build_object('min',0.05,'max',8),
    'music_school', jsonb_build_object('min',0.05,'max',8),
    'art', jsonb_build_object('min',0.1,'max',30),
    'wedding', jsonb_build_object('min',0.02,'max',5),
    'veterinary', jsonb_build_object('min',0.1,'max',6),
    'insurance', jsonb_build_object('min',0.1,'max',10),
    'post_office', jsonb_build_object('min',0.05,'max',3),
    'library', jsonb_build_object('min',0.02,'max',3),
    'marketplace', jsonb_build_object('min',0.02,'max',6),
    'fuel', jsonb_build_object('min',0.2,'max',8),
    'night_club', jsonb_build_object('min',0.05,'max',8),
    'cinema', jsonb_build_object('min',0.02,'max',4)
  )
  || jsonb_build_object(
    'car_wash', jsonb_build_object('min',0.1,'max',8),
    'car_rental', jsonb_build_object('min',0.05,'max',6),
    'laundry', jsonb_build_object('min',0.05,'max',8),
    'butcher', jsonb_build_object('min',0.05,'max',8),
    'florist', jsonb_build_object('min',0.1,'max',8),
    'optician', jsonb_build_object('min',0.05,'max',6),
    'jewelry', jsonb_build_object('min',0.05,'max',8),
    'grocery', jsonb_build_object('min',0.5,'max',30),
    'tattoo', jsonb_build_object('min',0.05,'max',8),
    'pet_groomer', jsonb_build_object('min',0.05,'max',6),
    'pub', jsonb_build_object('min',0.1,'max',20),
    'ice_cream', jsonb_build_object('min',0.05,'max',10),
    'bicycle', jsonb_build_object('min',0.05,'max',6),
    'sports', jsonb_build_object('min',0.05,'max',8),
    'bookstore', jsonb_build_object('min',0.05,'max',8),
    'market', jsonb_build_object('min',0.05,'max',15),
    'web_agency', jsonb_build_object('min',0.05,'max',20)
  );
$$;
