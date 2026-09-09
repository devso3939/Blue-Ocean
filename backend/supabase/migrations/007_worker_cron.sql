-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 007: job worker + pg_cron dispatcher      ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ── Execute one queued job (called by cron every 5 seconds) ────────
create or replace function bo.job_run_one()
returns void language plpgsql volatile security definer set search_path = bo, extensions as $$
declare
  j bo.jobs%rowtype;
  res jsonb;
begin
  -- claim exactly one queued job (atomic)
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
      when 'snapshot' then
        perform bo.select_peers(j.payload->>'city_id', 5);
        res := bo.build_snapshot(j.payload->>'city_id');
      when 'analyze' then
        res := bo.category_stats(j.payload->>'city_id', j.payload->>'category_id');
      when 'opportunities' then
        res := bo.api_opportunities(j.payload->>'city_id');
      else
        raise exception 'Unknown job kind: %', j.kind;
    end case;

    update bo.jobs set status='done', stage='done', progress=1.0,
           result=res, finished_at=now(), updated_at=now(), error=null
     where job_id = j.job_id;

  exception when others then
    if j.attempts + 1 < j.max_attempts then
      update bo.jobs set status='queued', stage='retry', message=SQLERRM, updated_at=now()
       where job_id = j.job_id;
    else
      update bo.jobs set status='error', stage='error', error=SQLERRM,
             finished_at=now(), updated_at=now()
       where job_id = j.job_id;
    end if;
  end;
end $$;

-- ── Cleanup: purge jobs older than 24h (daily at 03:00 UTC) ────────
create or replace function bo.job_cleanup()
returns void language sql volatile security definer set search_path = bo as $$
  delete from bo.jobs where created_at < now() - interval '24 hours';
$$;

-- ── Cron schedules (idempotent) ────────────────────────────────────
select cron.unschedule('blueocean-worker') where exists
  (select 1 from cron.job where jobname='blueocean-worker');
select cron.schedule('blueocean-worker', '5 seconds', $$select bo.job_run_one()$$);

select cron.unschedule('blueocean-cleanup') where exists
  (select 1 from cron.job where jobname='blueocean-cleanup');
select cron.schedule('blueocean-cleanup', '0 3 * * *', $$select bo.job_cleanup()$$);
