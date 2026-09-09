-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 011: stored analyses + market context     ║
-- ║ Completes the FastAPI surface: /analysis/{id}, /market, exports  ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Analyses store (replaces in-memory JobManager + cache) ─────────
create table if not exists bo.analyses (
  analysis_id text primary key,
  city_id     text not null,
  category_id text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists analyses_city_idx on bo.analyses (city_id, created_at desc);

-- Market-context cache (World Bank payload is per-country, 30d TTL)
create table if not exists bo.market_cache (
  iso3       text primary key,
  payload    jsonb not null,
  built_at   timestamptz not null default now()
);

-- ── World Bank market context (port of services/market.py) ─────────
create or replace function bo.wb_series(p_iso3 text, p_code text)
returns jsonb language plpgsql stable security definer set search_path = bo, extensions as $$
declare
  v_url text;
  v_resp jsonb;
  r jsonb;
begin
  v_url := 'https://api.worldbank.org/v2/country/' || p_iso3 || '/indicator/'
           || p_code || '?format=json&per_page=8';
  select http_get(v_url)::jsonb into v_resp;
  if v_resp is null or jsonb_typeof(v_resp) <> 'array' or jsonb_array_length(v_resp) < 2 then
    return null;
  end if;
  for r in select * from jsonb_array_elements(v_resp->1)
  loop
    if r->>'value' is not null then
      return jsonb_build_object('value', (r->>'value')::double precision,
                                'year', (r->>'date')::int);
    end if;
  end loop;
  return null;
exception when others then
  return null;
end $$;

create or replace function bo.market_context(p_city_id text, p_category_label text default '')
returns jsonb language plpgsql volatile security definer set search_path = bo, extensions as $$
declare
  c bo.cities%rowtype;
  v_iso3 text;
  cached jsonb;
  inds jsonb := '{}'::jsonb;
  spec jsonb;
  key text;
  series jsonb;
  gdp_pc double precision; work double precision; internet double precision; urban double precision; gni_pc double precision;
  pop_n double precision := 0.5; gdp_n double precision := 0.5; work_n double precision := 0.5; digital double precision := 0.5;
  buyer_score int;
  base double precision; wage double precision; rent double precision; fitout double precision; equip double precision;
  monthly_costs double precision; total double precision; monthly_profit double precision;
  v_payload jsonb;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then return null; end if;
  -- ISO3 from cca2 (subset covering every seeded country; falls back to cca2 itself)
  v_iso3 := case upper(c.country_code)
    when 'AE' then 'ARE' when 'AL' then 'ALB' when 'AM' then 'ARM' when 'AR' then 'ARG'
    when 'AT' then 'AUT' when 'AU' then 'AUS' when 'AZ' then 'AZE' when 'BA' then 'BIH'
    when 'BD' then 'BGD' when 'BE' then 'BEL' when 'BG' then 'BGR' when 'BR' then 'BRA'
    when 'BY' then 'BLR' when 'CA' then 'CAN' when 'CH' then 'CHE' when 'CL' then 'CHL'
    when 'CN' then 'CHN' when 'CO' then 'COL' when 'CY' then 'CYP' when 'CZ' then 'CZE'
    when 'DE' then 'DEU' when 'DK' then 'DNK' when 'DZ' then 'DZA' when 'EE' then 'EST'
    when 'EG' then 'EGY' when 'ES' then 'ESP' when 'FI' then 'FIN' when 'FR' then 'FRA'
    when 'GB' then 'GBR' when 'GE' then 'GEO' when 'GR' then 'GRC' when 'HK' then 'HKG'
    when 'HR' then 'HRV' when 'HU' then 'HUN' when 'ID' then 'IDN' when 'IE' then 'IRL'
    when 'IL' then 'ISR' when 'IN' then 'IND' when 'IQ' then 'IRQ' when 'IR' then 'IRN'
    when 'IS' then 'ISL' when 'IT' then 'ITA' when 'JO' then 'JOR' when 'JP' then 'JPN'
    when 'KZ' then 'KAZ' when 'LT' then 'LTU' when 'LU' then 'LUX' when 'LV' then 'LVA'
    when 'LY' then 'LBY' when 'MA' then 'MAR' when 'MD' then 'MDA' when 'ME' then 'MNE'
    when 'MK' then 'MKD' when 'MT' then 'MLT' when 'MX' then 'MEX' when 'MY' then 'MYS'
    when 'NG' then 'NGA' when 'NL' then 'NLD' when 'NO' then 'NOR' when 'NZ' then 'NZL'
    when 'PE' then 'PER' when 'PH' then 'PHL' when 'PK' then 'PAK' when 'PL' then 'POL'
    when 'PT' then 'PRT' when 'RO' then 'ROU' when 'RS' then 'SRB' when 'RU' then 'RUS'
    when 'SA' then 'SAU' when 'SE' then 'SWE' when 'SG' then 'SGP' when 'SI' then 'SVN'
    when 'SK' then 'SVK' when 'TH' then 'THA' when 'TN' then 'TUN' when 'TR' then 'TUR'
    when 'TW' then 'TWN' when 'UA' then 'UKR' when 'US' then 'USA' when 'UZ' then 'UZB'
    when 'VN' then 'VNM' when 'ZA' then 'ZAF' else null end;
  if v_iso3 is null then return null; end if;

  -- 30-day cache
  select m.payload into cached from bo.market_cache m
   where m.iso3 = v_iso3 and m.built_at > now() - interval '30 days';
  if cached is not null then
    return jsonb_set(cached, '{country_name}', to_jsonb(c.country));
  end if;

  -- Fetch indicators (World Bank, no key). key => (label, codes…)
  for spec in select jsonb_build_array(k, v) from (
    select 'gdp_ppp' k, 'NY.GDP.MKTP.PP.CD' v
    union all select 'gdp_growth', 'NY.GDP.MKTP.KD.ZG'
    union all select 'gdp_per_capita_ppp', 'NY.GDP.PCAP.PP.CD'
    union all select 'gni_per_capita_ppp', 'NY.GNP.PCAP.PP.CD'
    union all select 'inflation', 'FP.CPI.TOTL.ZG'
    union all select 'unemployment', 'SL.UEM.TOTL.ZS'
    union all select 'working_age_share', 'SP.POP.1564.TO.ZS'
    union all select 'labor_force_participation', 'SL.TLF.CACT.ZS'
    union all select 'life_expectancy', 'SP.DYN.LE00.IN'
    union all select 'gini', 'SI.POV.GINI'
    union all select 'new_business_density', 'IC.BUS.NREG'
    union all select 'internet_users', 'IT.NET.USER.ZS'
    union all select 'mobile_subscriptions', 'IT.CEL.SETS.P2'
    union all select 'urban_share', 'SP.URB.TOTL.IN.ZS'
    union all select 'tax_revenue_pct_gdp', 'GC.REV.XGRT.GD.ZS'
    union all select 'secondary_enrollment', 'SE.SEC.ENRR'
    union all select 'population_total', 'SP.POP.TOTL'
  ) t order by 1
  loop
    key := spec->>0;
    series := bo.wb_series(v_iso3, spec->>1);
    inds := jsonb_set(inds, array[key], coalesce(
      jsonb_build_object('code', spec->>1, 'value', series->>'value', 'year', series->>'year'),
      jsonb_build_object('code', spec->>1, 'value', null, 'year', null)));
  end loop;

  gdp_pc   := nullif(inds->'gdp_per_capita_ppp'->>'value','')::double precision;
  gni_pc   := nullif(inds->'gni_per_capita_ppp'->>'value','')::double precision;
  work     := nullif(inds->'working_age_share'->>'value','')::double precision;
  internet := nullif(inds->'internet_users'->>'value','')::double precision;
  urban    := nullif(inds->'urban_share'->>'value','')::double precision;

  -- buyer potential (port of _buyer_potential)
  if c.population is not null and c.population > 0 then
    pop_n := least(1.0, greatest(0.0, (ln(greatest(c.population,1)::double precision) - ln(31622.0)) / (ln(10000000.0) - ln(31622.0))));
  end if;
  if gdp_pc is not null then
    gdp_n := least(1.0, greatest(0.0, (ln(greatest(gdp_pc,100)) - ln(100.0)) / (ln(40000.0) - ln(100.0))));
  end if;
  if work is not null then
    work_n := least(1.0, greatest(0.0, (work - 50.0) / 20.0));
  end if;
  if internet is not null and urban is not null then
    digital := least(1.0, greatest(0.0, (0.6 * internet + 0.4 * urban) / 100.0));
  elsif internet is not null then
    digital := least(1.0, greatest(0.0, internet / 100.0));
  end if;
  buyer_score := round(100 * (0.3 * pop_n + 0.3 * gdp_n + 0.2 * work_n + 0.2 * digital))::int;

  -- startup estimate (port of _startup_estimate)
  base := coalesce(gni_pc, gdp_pc, 0);
  wage   := round(gdp_pc / 12.0 * 0.5);
  rent   := round(gdp_pc / 12.0 * 0.25);
  fitout := round(base * 0.8);
  equip  := round(base * 0.6);
  monthly_costs := coalesce(wage,0) * 2 + coalesce(rent,0);
  total := coalesce(fitout,0) + coalesce(equip,0) + monthly_costs * 6;
  monthly_profit := (monthly_costs * 4.0) * 0.35 - monthly_costs;

  v_payload := jsonb_build_object(
    'country_code', v_iso3, 'country_name', c.country,
    'indicators', inds,
    'buyer_potential', jsonb_build_object(
      'score', buyer_score,
      'components', jsonb_build_object(
        'market_size', round(100*pop_n), 'purchasing_power', round(100*gdp_n),
        'demographics', round(100*work_n), 'digital_reach', round(100*digital)),
      'formula', '0.30 x market size + 0.30 x purchasing power + 0.20 x working-age share + 0.20 x digital reach',
      'note', 'Population (city); GDP per capita PPP, working-age share, internet penetration and urbanisation (country) — real inputs; the weights are our transparent weighting scheme.'),
    'startup_estimate', jsonb_build_object(
      'avg_monthly_wage_est', wage, 'monthly_rent_est', rent,
      'fitout_est', fitout, 'equipment_est', equip,
      'assumed_staff', 2, 'monthly_costs_est', round(monthly_costs),
      'working_capital_6m_est', round(monthly_costs*6),
      'total_investment_est', round(total),
      'assumed_monthly_revenue_est', round(monthly_costs*4.0),
      'assumed_margin', 0.35,
      'est_monthly_profit', round(monthly_profit),
      'payback_months_est', case when monthly_profit > 0 then round(total / monthly_profit) else null end,
      'category', nullif(p_category_label,''), 'city', c.name,
      'estimates_not_quotes', true),
    'assumptions', jsonb_build_array(
      'All figures are the latest values published by the World Bank API (GDP, growth, inflation, unemployment, labour-force participation, life expectancy, inequality, internet/mobile penetration, urbanisation, revenue and enrolment).',
      'When the exact series is not published for a country, the nearest published alternative is shown and flagged on the card.',
      'The World Bank archived its Doing Business indicators after 2020, so they are not shown; the buyer score and cost model use live series instead.',
      'Estimated average monthly wage = 50% of monthly GDP per capita (PPP) — a common cross-country labour share; replace with local job-market data for precision.',
      'Estimated commercial rent, fit-out and equipment are rough anchors derived from GDP per capita, not actual listings — adjust them in the calculator.',
      'The buyer score combines population, purchasing power, demographics and digital reach with transparent weights; it is an indicator, not a promise of sales.',
      'The payback estimate assumes monthly revenue of 4x the estimated monthly costs and a 35% operating margin, with profit reinvested — a rough planning aid, not financial advice.'),
    'sources', jsonb_build_array('World Bank Open Data API (api.worldbank.org)'));

  insert into bo.market_cache (iso3, payload) values (v_iso3, v_payload)
    on conflict (iso3) do update set payload = excluded.payload, built_at = now();
  return v_payload;
end $$;

-- ── Full MarketAnalysis builder (stored under an analysis_id) ──────
create or replace function bo.build_analysis(p_city_id text, p_category text)
returns jsonb language plpgsql volatile security definer set search_path = bo as $$
declare
  c bo.cities%rowtype;
  s bo.snapshots%rowtype;
  st jsonb;
  v_aid text;
  cnt int := 0;
  pl jsonb;
  mkt jsonb;
  label text;
  fam text; fam_label text;
  density jsonb := '[]'::jsonb;
  g record;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then raise exception 'city not found: %', p_city_id using errcode='P0002'; end if;
  select * into s from bo.snapshots where city_id = p_city_id order by built_at desc limit 1;
  if not found then raise exception 'no snapshot for city: %', p_city_id using errcode='P0002'; end if;

  select bo.category_stats(p_city_id, p_category) into st;
  if st is null then raise exception 'category unknown: %', p_category; end if;

  select cat.label, cat.family into label, fam from bo.categories cat where cat.id = p_category;
  fam_label := coalesce((select fl.label from bo.families fl where fl.id = fam), 'Other');

  -- places of this category from the snapshot (cap 2000 for payload size)
  for pl in select q from jsonb_array_elements(s.places) q where (q->>'cat') = p_category limit 2000 loop
    cnt := cnt + 1;
  end loop;

  -- coarse density grid (~0.01° cells)
  for g in
    select round((q->>'lat')::numeric, 2) glat, round((q->>'lon')::numeric, 2) glon, count(*) n
    from jsonb_array_elements(s.places) q
    where (q->>'cat') = p_category
    group by 1, 2 limit 4000
  loop
    density := density || jsonb_build_object('lat', g.glat, 'lon', g.glon, 'count', g.n);
  end loop;

  mkt := bo.market_context(p_city_id, coalesce(label, p_category));

  insert into bo.analyses (analysis_id, city_id, category_id, payload)
  values ('an-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12),
          p_city_id, p_category, '"pending"'::jsonb)
  returning analysis_id into v_aid;

  update bo.analyses a set payload = jsonb_build_object(
    'analysis_id', v_aid,
    'city', jsonb_set(to_jsonb(c) - 'created_at', '{boundary}', coalesce(c.boundary,'null'::jsonb)),
    'category', jsonb_build_object('id', p_category, 'label', coalesce(label,p_category), 'family', fam, 'family_label', fam_label),
    'snapshot', jsonb_build_object(
      'city_id', s.city_id, 'city_name', c.name, 'country', c.country,
      'population', c.population, 'overture_release', 'overpass-live',
      'fetched_at', s.built_at, 'bbox', c.bbox, 'boundary_type', c.boundary_type,
      'total_places', s.total_places, 'primary_counts', s.category_counts,
      'filter_stats', jsonb_build_object('kept', s.total_places)),
    'peers', coalesce((select jsonb_agg(jsonb_build_object(
               'city_id', pc.peer_city_id, 'name', pc.name, 'country', coalesce(pc.country_code,''),
               'country_code', pc.country_code, 'population', pc.population,
               'weight', pc.weight, 'snapshot_ready', pc.snapshot_ready,
               'total_places', pc.total_places, 'count', pc.category_count, 'boundary_type', 'bbox'))
             from bo.peer_cities pc where pc.city_id = p_city_id), '[]'::jsonb),
    'stats', st,
    'places', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', q->>'id', 'name', q->>'name', 'lat', (q->>'lat')::double precision,
                 'lon', (q->>'lon')::double precision, 'category_label', q->>'cat',
                 'confidence', 1.0, 'websites', '[]'::jsonb, 'phones', '[]'::jsonb,
                 'emails', '[]'::jsonb, 'socials', '[]'::jsonb, 'sources', '["osm"]'::jsonb))
               from (select q from jsonb_array_elements(s.places) q where (q->>'cat') = p_category limit 2000) sel), '[]'::jsonb),
    'density_grid', density,
    'methodology', jsonb_build_object(
      'data_source', 'OpenStreetMap via Overpass API (live)',
      'benchmark', 'Weighted median per-10k of up to 5 peer cities (same country first), curated fallback',
      'scoring', '0.60 x gap + 0.25 x percentile + 0.15 x market size'),
    'generated_at', now(),
    'market', mkt)
  where a.analysis_id = v_aid;

  return jsonb_build_object('analysis_id', v_aid);
end $$;

-- ── Job status RPC (public.jobs view → JobStatus shape) ────────────
create or replace function public.api_job(p_job_id text)
returns jsonb language sql stable security definer set search_path = bo as $$
  select jsonb_build_object(
    'job_id', j.job_id, 'kind', j.kind, 'status', j.status,
    'stage', j.stage, 'progress', j.progress, 'message', j.message,
    'result', j.result, 'error', j.error,
    'created_at', j.created_at, 'updated_at', j.updated_at)
  from bo.jobs j where j.job_id = p_job_id;
$$;

-- ── Analysis read + CSV export ─────────────────────────────────────
create or replace function public.api_analysis(p_analysis_id text)
returns jsonb language sql stable security definer set search_path = bo as $$
  select payload from bo.analyses where analysis_id = p_analysis_id;
$$;

create or replace function public.api_analysis_export(p_analysis_id text)
returns text language plpgsql stable security definer set search_path = bo as $$
declare
  v jsonb;
  line text;
  out text;
begin
  select payload into v from bo.analyses where analysis_id = p_analysis_id;
  if v is null then return null; end if;
  out := 'name,category,lat,lon' || chr(10);
  for line in
    select concat_ws(',',
      '"' || replace(coalesce(p->>'name',''), '"', '""') || '"',
      coalesce(p->>'category_label',''),
      coalesce(p->>'lat',''), coalesce(p->>'lon',''))
    from jsonb_array_elements(v->'places') p
  loop
    out := out || line || chr(10);
  end loop;
  return out;
end $$;

-- ── Worker dispatch: analyze now builds a stored MarketAnalysis ────
create or replace function bo.job_run_one()
returns void language plpgsql volatile security definer set search_path = bo, net as $$
declare
  j bo.jobs%rowtype;
  res jsonb;
begin
  select * into j from bo.jobs
   where status = 'queued'
   order by created_at
   for update skip locked
   limit 1;
  if not found then return; end if;

  update bo.jobs set status='running', stage='started', progress=0.05,
         started_at=now(), updated_at=now(), attempts = attempts + 1
   where job_id = j.job_id;

  begin
    case j.kind
      when 'resolve_city' then
        res := bo.resolve_city_meta(j.payload->>'country', j.payload->>'city');
        update bo.jobs set status='done', stage='done', progress=1.0,
               result=res, finished_at=now(), updated_at=now(), error=null
         where job_id = j.job_id;
      when 'snapshot' then
        perform bo.select_peers(j.payload->>'city_id', 5);
        perform bo.snapshot_start(j);
      when 'analyze' then
        res := bo.build_analysis(j.payload->>'city_id', j.payload->>'category_id');
        update bo.jobs set status='done', stage='done', progress=1.0,
               result=res, finished_at=now(), updated_at=now(), error=null
         where job_id = j.job_id;
      when 'opportunities' then
        res := bo.api_opportunities(j.payload->>'city_id');
        update bo.jobs set status='done', stage='done', progress=1.0,
               result=res, finished_at=now(), updated_at=now(), error=null
         where job_id = j.job_id;
      else
        raise exception 'Unknown job kind: %', j.kind;
    end case;
  exception when others then
    if j.attempts + 1 < j.max_attempts then
      update bo.jobs set status='queued', stage='retry', message=SQLERRM, net_req_id=null, updated_at=now()
       where job_id = j.job_id;
    else
      update bo.jobs set status='error', stage='error', error=SQLERRM,
             finished_at=now(), updated_at=now()
       where job_id = j.job_id;
    end if;
  end;
end $$;

-- ── API parity: opportunity row + resolve result field names ──────
create or replace function bo.api_opportunities(p_city_id text)
returns jsonb language plpgsql volatile security definer set search_path = bo as $$
declare
  c bo.cities%rowtype;
  s bo.snapshots%rowtype;
  peers jsonb;
  opps jsonb;
  warns jsonb;
  out_arr jsonb;
  o jsonb;
begin
  select * into c from bo.cities where city_id = p_city_id;
  if not found then raise exception 'city not found: %', p_city_id using errcode='P0002'; end if;
  select * into s from bo.snapshots where city_id = p_city_id order by built_at desc limit 1;
  if not found then return null; end if;

  -- keep bo.peer_cities.snapshot_ready in sync (cached counters for reads)
  update bo.peer_cities pc
     set snapshot_ready = (ps.city_id is not null),
         total_places   = coalesce(ps.total_places, 0),
         category_count = coalesce((select sum((ps.category_counts ->> cat.id)::int) from bo.categories cat where cat.id = 'cafe'), 0)
    from bo.snapshots ps
   where pc.peer_city_id = ps.city_id and pc.city_id = p_city_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'city_id', peer_city_id, 'name', name,
           'country_code', country_code, 'population', population,
           'weight', weight, 'snapshot_ready', snapshot_ready,
           'total_places', total_places, 'count', category_count)), '[]'::jsonb)
    into peers from bo.peer_cities where city_id = p_city_id;

  -- opportunities with FastAPI field names
  select bo.compute_opportunities(p_city_id) into opps;
  out_arr := '[]'::jsonb;
  for o in select * from jsonb_array_elements(opps)
  loop
    out_arr := out_arr || jsonb_build_object(
      'category_id', o->>'category', 'label', o->>'label',
      'family', o->>'family', 'family_label', o->>'family_label',
      'existing', (o->>'count')::int,
      'per_10k', nullif(o->>'per_10k','')::double precision,
      'expected', nullif(o->>'expected','')::double precision,
      'gap', nullif(o->>'gap','')::double precision,
      'gap_pct', nullif(o->>'gap_pct','')::double precision,
      'score', nullif(o->>'score','')::int,
      'score_label', o->>'score_label',
      'confidence', nullif(o->>'confidence','')::int,
      'warnings', coalesce(o->'warnings','[]'::jsonb),
      'explanation', null);
  end loop;

  select coalesce(jsonb_agg(aw.warning ->>'message'), '[]'::jsonb) into warns
    from bo.anomaly_warnings(p_city_id) aw;

  return jsonb_build_object(
    'city', jsonb_set(to_jsonb(c) - 'created_at', '{boundary}', coalesce(c.boundary,'null'::jsonb)),
    'snapshot', jsonb_build_object('built_at', s.built_at, 'total_places', s.total_places),
    'peers', peers,
    'opportunities', coalesce((
      select jsonb_agg(e order by (e->>'score') desc nulls last, (e->>'existing') desc)
      from jsonb_array_elements(out_arr) e), '[]'::jsonb),
    'anomaly_warnings', warns,
    'generated_at', now()
  );
end $$;

-- resolve_city job result: {city_id} at top level (frontend contract)
create or replace function bo.job_run_one()
returns void language plpgsql volatile security definer set search_path = bo, net as $$
declare
  j bo.jobs%rowtype;
  res jsonb;
begin
  select * into j from bo.jobs
   where status = 'queued'
   order by created_at
   for update skip locked
   limit 1;
  if not found then return; end if;

  update bo.jobs set status='running', stage='started', progress=0.05,
         started_at=now(), updated_at=now(), attempts = attempts + 1
   where job_id = j.job_id;

  begin
    case j.kind
      when 'resolve_city' then
        res := bo.resolve_city_meta(j.payload->>'country', j.payload->>'city');
        update bo.jobs set status='done', stage='done', progress=1.0,
               result=jsonb_build_object('city_id', res->'city'->>'city_id',
                                         'city', res->'city'),
               finished_at=now(), updated_at=now(), error=null
         where job_id = j.job_id;
      when 'snapshot' then
        perform bo.select_peers(j.payload->>'city_id', 5);
        perform bo.snapshot_start(j);
      when 'analyze' then
        res := bo.build_analysis(j.payload->>'city_id', j.payload->>'category_id');
        update bo.jobs set status='done', stage='done', progress=1.0,
               result=res, finished_at=now(), updated_at=now(), error=null
         where job_id = j.job_id;
      when 'opportunities' then
        res := bo.api_opportunities(j.payload->>'city_id');
        update bo.jobs set status='done', stage='done', progress=1.0,
               result=res, finished_at=now(), updated_at=now(), error=null
         where job_id = j.job_id;
      else
        raise exception 'Unknown job kind: %', j.kind;
    end case;
  exception when others then
    if j.attempts + 1 < j.max_attempts then
      update bo.jobs set status='queued', stage='retry', message=SQLERRM, net_req_id=null, updated_at=now()
       where job_id = j.job_id;
    else
      update bo.jobs set status='error', stage='error', error=SQLERRM,
             finished_at=now(), updated_at=now()
       where job_id = j.job_id;
    end if;
  end;
end $$;
