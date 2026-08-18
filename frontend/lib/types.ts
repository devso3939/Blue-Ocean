export interface CityMeta {
  city_id: string;
  name: string;
  display_name: string;
  country: string;
  country_code: string;
  country_qid?: string | null;
  wikidata_qid?: string | null;
  osm_type: string;
  osm_id?: number | null;
  center: { lat: number; lon: number };
  bbox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  boundary?: Record<string, unknown> | null;
  boundary_type: string;
  population?: number | null;
  population_year?: number | null;
  population_source?: string | null;
  population_note?: string | null;
  resolved_at?: string | null;
  nominatim_rank?: number | null;
  nominatim_display?: string | null;
  source: string;
}

export interface Place {
  id: string;
  name?: string | null;
  lat: number;
  lon: number;
  primary_category?: string | null;
  category_label?: string | null;
  confidence: number;
  operating_status?: string | null;
  address?: string | null;
  locality?: string | null;
  postcode?: string | null;
  region?: string | null;
  country?: string | null;
  websites: string[];
  phones: string[];
  emails: string[];
  socials: string[];
  brand?: string | null;
  sources: string[];
}

export interface FilterStats {
  in_bbox: number;
  in_boundary: number;
  removed_closed: number;
  removed_no_geometry: number;
  removed_duplicates: number;
  kept: number;
}

export interface SnapshotMeta {
  city_id: string;
  city_name: string;
  country: string;
  population?: number | null;
  population_year?: number | null;
  overture_release: string;
  fetched_at: string;
  bbox: Record<string, number>;
  boundary_type: string;
  total_places: number;
  filter_stats: FilterStats;
  source_quality: Record<string, unknown>;
  primary_counts: Record<string, number>;
  matched_counts: Record<string, number>;
  leaf_counts: Record<string, number>;
  osm_validation?: Record<string, unknown> | null;
}

export interface PeerCity {
  city_id: string;
  name: string;
  country: string;
  country_code: string;
  population?: number | null;
  population_year?: number | null;
  wikidata_qid?: string | null;
  weight: number;
  snapshot_ready: boolean;
  total_places: number;
  count: number;
  per_10k?: number | null;
  boundary_type: string;
  note?: string | null;
}

export interface CategoryStats {
  category_id: string;
  label: string;
  family: string;
  family_label: string;
  count: number;
  per_10k?: number | null;
  expected_per_10k?: number | null;
  expected_count?: number | null;
  gap?: number | null;
  gap_pct?: number | null;
  opportunity_score?: number | null;
  score_label?: string | null;
  score_components: Record<string, unknown>;
  data_confidence?: number | null;
  confidence_components: Record<string, unknown>;
  warnings: string[];
  explanation?: string | null;
  ai_insight?: string | null;
  name_signal_matches?: number | null;
}

export interface MarketIndicator {
  code: string;
  label: string;
  value?: number | null;
  year?: number | null;
}

export interface MarketContext {
  country_code: string;
  country_name: string;
  indicators: Record<string, MarketIndicator>;
  buyer_potential: {
    score: number;
    components: Record<string, number>;
    formula?: string;
    note?: string;
  };
  startup_estimate: Record<string, unknown>;
  assumptions: string[];
  sources: string[];
}

export interface MarketAnalysis {
  analysis_id: string;
  city: CityMeta;
  category: { id: string; label: string; family: string; family_label: string };
  snapshot: SnapshotMeta;
  peers: PeerCity[];
  peer_selection: Record<string, unknown>;
  stats: CategoryStats;
  places: Place[];
  density_grid: { lat: number; lon: number; count: number }[];
  methodology: Record<string, unknown>;
  generated_at: string;
  sparse_coverage?: boolean;
  sparse_coverage_detail?: string | null;
  market?: MarketContext | null;
}

export interface OpportunityRow {
  category_id: string;
  label: string;
  family: string;
  family_label: string;
  existing: number;
  per_10k?: number | null;
  expected?: number | null;
  gap?: number | null;
  gap_pct?: number | null;
  score?: number | null;
  score_label?: string | null;
  confidence?: number | null;
  warnings: string[];
  explanation?: string | null;
}

export interface OpportunitiesResult {
  city: CityMeta;
  snapshot: SnapshotMeta;
  peers: PeerCity[];
  opportunities: OpportunityRow[];
  filters_applied: Record<string, unknown>;
  generated_at: string;
  anomaly_warnings: string[];
}

export interface JobStatus {
  job_id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: number;
  message?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Country {
  name: string;
  cca2: string;
  region: string;
}

export interface CityCandidate {
  name: string;
  country_code: string;
  display_name: string;
  description?: string;
  qid?: string;
  lat?: number;
  lon?: number;
}

export interface CategoryInfo {
  id: string;
  label: string;
  family: string;
  family_label: string;
  aliases: string[];
  popular?: boolean;
}

export interface FamilyInfo {
  id: string;
  label: string;
  description: string;
  categories?: CategoryInfo[];
}

export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-muted-foreground";
  if (score >= 90) return "text-emerald-400";
  if (score >= 80) return "text-emerald-400";
  if (score >= 70) return "text-lime-400";
  if (score >= 60) return "text-amber-400";
  if (score >= 45) return "text-amber-400";
  if (score >= 30) return "text-orange-400";
  return "text-rose-400";
}

export function scoreHex(score: number | null | undefined): string {
  if (score === null || score === undefined) return "#94a3b8";
  if (score >= 80) return "#34d399";
  if (score >= 60) return "#fbbf24";
  if (score >= 45) return "#fbbf24";
  if (score >= 30) return "#fb923c";
  return "#fb7185";
}
