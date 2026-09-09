-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 002: jobs queue                           ║
-- ╚══════════════════════════════════════════════════════════════════╝

create table if not exists bo.jobs (
  job_id       text primary key default encode(gen_random_bytes(5), 'hex'),
  kind         text not null,                    -- resolve_city | snapshot | analyze | opportunities
  status       text not null default 'queued',   -- queued | running | done | error
  stage        text not null default 'queued',
  progress     double precision not null default 0.0,
  message      text,
  payload      jsonb not null default '{}',
  result       jsonb,
  error        text,
  attempts     int not null default 0,
  max_attempts int not null default 2,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index if not exists jobs_dispatch_idx on bo.jobs (status, created_at);
create index if not exists jobs_kind_idx on bo.jobs (kind, created_at desc);

-- RLS: anonymous clients may create and poll jobs; mutations of state
-- happen only via security-definer functions (service role bypasses RLS).
alter table bo.jobs enable row level security;
drop policy if exists "jobs_insert_anon" on bo.jobs;
create policy "jobs_insert_anon" on bo.jobs
  for insert to anon, authenticated with check (true);
drop policy if exists "jobs_read_anon" on bo.jobs;
create policy "jobs_read_anon" on bo.jobs
  for select to anon, authenticated using (true);

-- Realtime: stream job progress updates to subscribed clients
do $$ begin
  alter publication supabase_realtime add table bo.jobs;
exception when duplicate_object then null; end $$;

-- Submit a job (mirrors POST /api/jobs)
create or replace function bo.submit_job(p_kind text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = bo as $$
declare v_id text;
begin
  if p_kind not in ('resolve_city','snapshot','analyze','opportunities') then
    raise exception 'Unknown job kind: %', p_kind using errcode = 'P0001';
  end if;
  insert into bo.jobs (kind, payload) values (p_kind, coalesce(p_payload,'{}'::jsonb))
  returning job_id into v_id;
  return jsonb_build_object('job_id', v_id, 'status', 'queued');
end $$;
