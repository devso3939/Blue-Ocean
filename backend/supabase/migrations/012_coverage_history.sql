-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 012: per-run coverage history              ║
-- ║ Every enrichment run persists its measured contact coverage so    ║
-- ║ the compounding effect (warm render cache, engine learnings) is   ║
-- ║ tracked over time per city + category, and the version/lanes that ║
-- ║ produced each number are recorded next to it.                     ║
-- ╚══════════════════════════════════════════════════════════════════╝

create table if not exists bo.coverage_history (
  id           bigint generated always as identity primary key,
  city         text not null,
  country      text not null,
  category     text not null,
  businesses   int  not null,
  phones       int  not null,
  emails       int  not null,
  websites     int  not null,
  socials      int  not null default 0,
  full_trio    int  not null default 0,
  any_contact_pct numeric not null default 0,
  phone_pct    numeric not null default 0,
  email_pct    numeric not null default 0,
  website_pct  numeric not null default 0,
  render_sites int not null default 0,
  render_contacts int not null default 0,
  app_version  text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists coverage_hist_idx
  on bo.coverage_history (country, city, category, created_at desc);

-- Public ingest: anon can INSERT one row per completed run. Bound the
-- payload so the endpoint can't be abused as a free-form write.
create or replace function bo.rpc_coverage_report(
  p_country text, p_city text, p_category text, p_businesses int,
  p_phones int, p_emails int, p_websites int,
  p_socials int default 0, p_full_trio int default 0,
  p_render_sites int default 0, p_render_contacts int default 0,
  p_app_version text default ''
) returns bigint
language plpgsql security definer set search_path = bo as $$
declare v_id bigint;
begin
  if p_businesses is null or p_businesses < 1 or p_businesses > 100000 then
    raise exception 'invalid businesses';
  end if;
  insert into bo.coverage_history (
    country, city, category, businesses, phones, emails, websites,
    socials, full_trio, any_contact_pct, phone_pct, email_pct, website_pct,
    render_sites, render_contacts, app_version
  ) values (
    left(p_country, 60), left(p_city, 60), left(p_category, 40), p_businesses,
    greatest(p_phones, 0), greatest(p_emails, 0), greatest(p_websites, 0),
    greatest(p_socials, 0), greatest(p_full_trio, 0),
    round(100.0 * (greatest(p_phones, 0) + greatest(p_emails, 0) + greatest(p_websites, 0))
          / nullif(p_businesses * 3, 0), 1),
    round(100.0 * greatest(p_phones, 0) / p_businesses, 1),
    round(100.0 * greatest(p_emails, 0) / p_businesses, 1),
    round(100.0 * greatest(p_websites, 0) / p_businesses, 1),
    greatest(p_render_sites, 0), greatest(p_render_contacts, 0),
    left(p_app_version, 20)
  ) returning id into v_id;
  return v_id;
end $$;

grant execute on function bo.rpc_coverage_report(
  text, text, text, int, int, int, int, int, int, int, int, text
) to anon;

-- Public read: latest N snapshots per city+category (trend queries).
create or replace function bo.rpc_coverage_trend(
  p_country text, p_city text, p_category text, p_limit int default 20
) returns setof bo.coverage_history
language sql stable security definer set search_path = bo as $$
  select * from bo.coverage_history
  where country = p_country and city = p_city and category = p_category
  order by created_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

grant execute on function bo.rpc_coverage_trend(text, text, text, int) to anon;

-- ── v6.9.86b addendum: public-schema wrappers ──────────────────────
-- PostgREST serves `public` only — bo.* functions are invisible to the
-- anon key. Same wrapper pattern as migration 008.
create or replace function public.rpc_coverage_report(
  p_country text, p_city text, p_category text, p_businesses int,
  p_phones int, p_emails int, p_websites int,
  p_socials int default 0, p_full_trio int default 0,
  p_render_sites int default 0, p_render_contacts int default 0,
  p_app_version text default ''
) returns bigint language sql volatile security definer set search_path = bo as
$$ select bo.rpc_coverage_report(
  p_country, p_city, p_category, p_businesses,
  p_phones, p_emails, p_websites,
  p_socials, p_full_trio,
  p_render_sites, p_render_contacts, p_app_version
); $$;

grant execute on function public.rpc_coverage_report(
  text, text, text, int, int, int, int, int, int, int, int, text
) to anon;

create or replace function public.rpc_coverage_trend(
  p_country text, p_city text, p_category text, p_limit int default 20
) returns setof bo.coverage_history language sql stable security definer set search_path = bo as
$$ select * from bo.rpc_coverage_trend(p_country, p_city, p_category, p_limit); $$;

grant execute on function public.rpc_coverage_trend(text, text, text, int) to anon;
