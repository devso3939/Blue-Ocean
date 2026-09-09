-- ╔══════════════════════════════════════════════════════════════════╗
-- ║ Blue Ocean — migration 001: schemas + reference tables           ║
-- ╚══════════════════════════════════════════════════════════════════╝
create schema if not exists bo;

-- ── Reference tables ──────────────────────────────────────────────
create table if not exists bo.countries (
  cca2   text primary key,
  name   text not null,
  region text not null
);

create table if not exists bo.families (
  id          text primary key,
  label       text not null,
  description text not null default '',
  sort_order  int  not null default 0
);

create table if not exists bo.categories (
  id         text primary key,
  label      text not null,
  family     text not null references bo.families(id),
  aliases    text[] not null default '{}',
  popular    boolean not null default false,
  osm_filter text,
  created_at timestamptz not null default now()
);

-- ── Cities + snapshots ────────────────────────────────────────────
create table if not exists bo.cities (
  city_id           text primary key,
  name              text not null,
  display_name      text not null,
  country           text,
  country_code      text,
  country_qid       text,
  wikidata_qid      text,
  osm_type          text,
  osm_id            bigint,
  center_lat        double precision,
  center_lon        double precision,
  bbox              jsonb,
  boundary          jsonb,
  boundary_type     text not null default 'bbox',
  population        bigint,
  population_source text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists bo.snapshots (
  city_id         text not null,
  release         text not null default 'overpass',
  built_at        timestamptz not null default now(),
  total_places    int not null default 0,
  places          jsonb not null default '[]',
  category_counts jsonb not null default '{}',
  source_quality  jsonb not null default '{}',
  primary key (city_id, release)
);

-- ── Peer cities ───────────────────────────────────────────────────
create table if not exists bo.peer_cities (
  city_id        text not null,
  peer_city_id   text not null,
  name           text not null,
  country_code   text,
  population     bigint,
  weight         double precision not null default 0.1,
  snapshot_ready boolean not null default false,
  total_places   int,
  category_count int,
  built_at       timestamptz,
  primary key (city_id, peer_city_id)
);

-- ── Category benchmarks (per-10k baselines, curated v1) ───────────
create table if not exists bo.category_benchmarks (
  category_id text primary key,
  per_10k     double precision not null,
  sample_n    int not null default 0,
  source      text not null default 'curated-v1',
  updated_at  timestamptz not null default now()
);
