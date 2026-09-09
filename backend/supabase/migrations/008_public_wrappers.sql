-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 008: public-schema wrappers for PostgREST ║
-- ╚══════════════════════════════════════════════════════════════════╝

create or replace function public.api_health()
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_health(); $$;

create or replace function public.api_config()
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_config(); $$;

create or replace function public.api_countries()
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_countries(); $$;

create or replace function public.api_families()
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_families(); $$;

create or replace function public.api_categories(q text default null, family text default null, popular boolean default null)
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_categories(q, family, popular); $$;

create or replace function public.api_city(p_city_id text)
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_city(p_city_id); $$;

create or replace function public.api_opportunities(p_city_id text)
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.api_opportunities(p_city_id); $$;

create or replace function public.api_opportunities_export(p_city_id text)
returns text language sql stable security definer set search_path = bo as
$$ select bo.api_opportunities_export(p_city_id); $$;

create or replace function public.submit_job(p_kind text, p_payload jsonb default '{}'::jsonb)
returns jsonb language sql volatile security definer set search_path = bo as
$$ select bo.submit_job(p_kind, p_payload); $$;

-- Explicit grants (PostgREST anon/authenticated)
grant execute on function
  public.api_health(), public.api_config(), public.api_countries(),
  public.api_families(), public.api_categories(text,text,boolean),
  public.api_city(text), public.api_opportunities(text),
  public.api_opportunities_export(text), public.submit_job(text, jsonb)
to anon, authenticated, service_role;

-- Read grants on reference tables (direct table API also usable)
grant usage on schema bo to anon, authenticated, service_role;
grant select on bo.countries, bo.families, bo.categories, bo.category_benchmarks to anon, authenticated;
grant select on bo.jobs to anon, authenticated;

-- Migration 011 additions: market context wrapper + grants for new RPCs
create or replace function public.api_market(p_city_id text, p_category_label text default null)
returns jsonb language sql stable security definer set search_path = bo as
$$ select bo.market_context(p_city_id, coalesce(p_category_label,'')); $$;

grant execute on function
  public.api_job(text), public.api_analysis(text), public.api_analysis_export(text),
  public.api_market(text, text)
to anon, authenticated, service_role;
