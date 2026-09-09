-- Migration 010: extend cleanup to purge pg_net response history
create or replace function bo.job_cleanup() returns void
language plpgsql security definer set search_path = bo, net as $$
begin
  delete from bo.jobs where created_at < now() - interval '24 hours';
  delete from net._http_response where created < now() - interval '2 hours';
end;
$$;
