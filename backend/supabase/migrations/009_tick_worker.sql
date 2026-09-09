-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 009: tick-based async snapshot worker     ║
-- ║ Supavisor enforces statement_timeout=2min and strips SET LOCAL,  ║
-- ║ so no statement may run long. Design:                            ║
-- ║   tick 1 (job_run_one): claim job → submit pg_net GET → store    ║
-- ║        net_req_id → return (fast)                                ║
-- ║   tick 2+ (job_poll_one): check net._http_response → when the    ║
-- ║        response arrived, categorize + store snapshot → done      ║
-- ╚══════════════════════════════════════════════════════════════════╝

alter table bo.jobs add column if not exists net_req_id bigint;

-- ── Overpass mirrors (shared) ──────────────────────────────────────
create or replace function bo.overpass_mirror(p_idx int)
returns text language sql immutable as $$
  select (array[
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ])[1 + (p_idx % 4)];
$$;

-- ── Phase 1: submit the Overpass GET via pg_net (fast statement) ───
create or replace function bo.snapshot_start(p_job bo.jobs)
returns void language plpgsql volatile security definer set search_path = bo, net as $$
declare
  c bo.cities%rowtype;
  bb jsonb;
  q text;
  url text;
  idx int := coalesce((p_job.payload->>'mirror_idx')::int, 0);
  rid bigint;
begin
  select * into c from bo.cities where city_id = p_job.payload->>'city_id';
  if not found then raise exception 'city not found: %', p_job.payload->>'city_id'; end if;

  bb := bo.scan_bbox(c);
  q := '[out:json][timeout:100];' ||
    format('(node(%s,%s,%s,%s)["name"];way(%s,%s,%s,%s)["name"];);',
           bb->>0, bb->>1, bb->>2, bb->>3, bb->>0, bb->>1, bb->>2, bb->>3) ||
    'out body center 20000;';

  url := bo.overpass_mirror(idx);
  rid := net.http_get(url, jsonb_build_object('data', q::text), '{}'::jsonb, 120000);

  update bo.jobs set
    stage = 'fetching', net_req_id = rid,
    payload = p_job.payload || jsonb_build_object('mirror_idx', idx + 1, 'bbox', bb),
    message = 'Overpass request submitted to ' || url,
    updated_at = now()
  where job_id = p_job.job_id;
end $$;

-- ── Phase 2: process the response when it arrives ──────────────────
create or replace function bo.snapshot_finish(p_job bo.jobs)
returns void language plpgsql volatile security definer set search_path = bo, net as $$
declare
  st int; body text; terr boolean;
  v jsonb;
  n int; counts jsonb; places jsonb;
  p_city_id text := p_job.payload->>'city_id';
begin
  select status_code, content, timed_out into st, body, terr
    from net._http_response where id = p_job.net_req_id;
  if not found then return; end if; -- not ready yet

  if st = 200 and body like '{%' then
    begin v := body::jsonb; exception when others then v := null; end;
  end if;

  if v is null or not (v ? 'elements') then
    -- this mirror failed → hand back to queue, next attempt uses next mirror
    update bo.jobs set
      status = case when p_job.attempts >= p_job.max_attempts then 'error' else 'queued' end,
      stage  = case when p_job.attempts >= p_job.max_attempts then 'error' else 'retry' end,
      error  = case when p_job.attempts >= p_job.max_attempts
                    then format('Overpass mirror failed (status %s)', st) else null end,
      message = format('Overpass mirror failed (status %s), rotating mirror', st),
      net_req_id = null,
      finished_at = case when p_job.attempts >= p_job.max_attempts then now() else null end,
      updated_at = now()
    where job_id = p_job.job_id;
    return;
  end if;

  -- categorize + aggregate (set-based, single pass)
  with e as (select jsonb_array_elements(v->'elements') el),
  p as (
    select
      el->>'type' as typ, el->>'id' as oid,
      coalesce((el->>'lat')::double precision, (el->'center'->>'lat')::double precision) as lat,
      coalesce((el->>'lon')::double precision, (el->'center'->>'lon')::double precision) as lon,
      coalesce(el->'tags', '{}'::jsonb) as tags
    from e
  ),
  ok as (
    select p.*, bo.categorize_osm(tags) as cat from p
    where lat is not null and lon is not null and coalesce(tags->>'name','') <> ''
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
          jsonb_build_object('query_bbox', p_job.payload->'bbox', 'built_by', 'supabase-pg17-tick'))
  on conflict (city_id, release) do update set
    built_at = now(), total_places = excluded.total_places,
    places = excluded.places, category_counts = excluded.category_counts,
    source_quality = excluded.source_quality;

  update bo.jobs set status='done', stage='done', progress=1.0,
         result=jsonb_build_object('city_id', p_city_id, 'total_places', n, 'category_counts', counts),
         net_req_id=null, finished_at=now(), updated_at=now(), error=null,
         message = n || ' places'
  where job_id = p_job.job_id;

  -- auto-enqueue snapshot jobs for peers missing a recent snapshot
  -- (max 2 per completion so the queue drains reasonably fast)
  insert into bo.jobs (kind, payload)
  select 'snapshot', jsonb_build_object('city_id', peer_city_id)
  from (
    select pc.peer_city_id
    from bo.peer_cities pc
    left join bo.snapshots s on s.city_id = pc.peer_city_id
      and s.built_at > now() - interval '30 days'
    where pc.city_id = p_city_id and s.city_id is null
    order by pc.weight desc
    limit 2
  ) need
  where not exists (
    select 1 from bo.jobs j2
    where j2.kind = 'snapshot'
      and j2.payload->>'city_id' = need.peer_city_id
      and j2.status in ('queued','running'));
end $$;

-- ── Worker tick 1: dispatch queued jobs ────────────────────────────
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
        res := bo.category_stats(j.payload->>'city_id', j.payload->>'category_id');
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

-- ── Worker tick 2: poll async responses ────────────────────────────
create or replace function bo.job_poll_one()
returns void language plpgsql volatile security definer set search_path = bo, net as $$
declare
  j bo.jobs%rowtype;
begin
  -- one fetching job per tick (cron runs every 5s; plenty of throughput)
  select * into j from bo.jobs
   where status='running' and stage='fetching' and net_req_id is not null
   order by updated_at
   limit 1;
  if not found then return; end if;

  -- stuck guard: > 6 min → fail back to queue or error
  if j.updated_at < now() - interval '6 minutes' then
    update bo.jobs set
      status = case when j.attempts >= j.max_attempts then 'error' else 'queued' end,
      stage  = case when j.attempts >= j.max_attempts then 'error' else 'retry' end,
      error  = case when j.attempts >= j.max_attempts then 'Overpass fetch timed out (6 min)' else null end,
      net_req_id = null, updated_at = now()
    where job_id = j.job_id;
    return;
  end if;

  begin
    perform bo.snapshot_finish(j);
  exception when others then
    update bo.jobs set status='error', stage='error', error=SQLERRM,
           net_req_id=null, finished_at=now(), updated_at=now()
     where job_id = j.job_id;
  end;
end $$;

-- ── Cron schedules (idempotent) ────────────────────────────────────
select cron.unschedule('blueocean-worker') where exists
  (select 1 from cron.job where jobname='blueocean-worker');
select cron.schedule('blueocean-worker', '5 seconds', $$select bo.job_run_one()$$);

select cron.unschedule('blueocean-poller') where exists
  (select 1 from cron.job where jobname='blueocean-poller');
select cron.schedule('blueocean-poller', '5 seconds', $$select bo.job_poll_one()$$);

select cron.unschedule('blueocean-cleanup') where exists
  (select 1 from cron.job where jobname='blueocean-cleanup');
select cron.schedule('blueocean-cleanup', '0 3 * * *', $$select bo.job_cleanup()$$);
