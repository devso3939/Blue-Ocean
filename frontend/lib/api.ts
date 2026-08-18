import type {
  CategoryInfo,
  CityCandidate,
  Country,
  FamilyInfo,
  JobStatus,
  MarketAnalysis,
  MarketContext,
  OpportunitiesResult,
} from "./types";

const API = process.env.NEXT_PUBLIC_API_URL || "/api";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => json<{ status: string }>(`${API}/health`),

  countries: () => json<Country[]>(`${API}/countries`),

  citiesSearch: (q: string, country = "") =>
    json<CityCandidate[]>(`${API}/cities/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`),

  countryCities: (cca2: string) => json<CountryCitiesResult>(`${API}/country/${encodeURIComponent(cca2)}/cities`),

  families: () => json<FamilyInfo[]>(`${API}/families`),

  categories: (params: { q?: string; family?: string; popular?: boolean } = {}) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (params.family) sp.set("family", params.family);
    if (params.popular) sp.set("popular", "true");
    const qs = sp.toString();
    return json<FamilyInfo | CategoryInfo[]>(`${API}/categories${qs ? `?${qs}` : ""}`);
  },

  startJob: (kind: string, payload: Record<string, unknown>) =>
    json<{ job_id: string; status: string }>(`${API}/jobs`, {
      method: "POST",
      body: JSON.stringify({ kind, payload }),
    }),

  job: (id: string) => json<JobStatus>(`${API}/jobs/${id}`),

  analysis: (id: string) => json<MarketAnalysis>(`${API}/analysis/${id}`),

  analysisExport: (id: string, format: "json" | "csv" | "xlsx") => `${API}/analysis/${id}/export?format=${format}`,

  market: (cityId: string, category = "", refresh = false) =>
    json<MarketContext>(
      `${API}/market?city_id=${encodeURIComponent(cityId)}&category=${encodeURIComponent(category)}&refresh=${refresh}`,
    ),

  opportunities: (cityId: string) => json<OpportunitiesResult>(`${API}/opportunities/${cityId}`),

  opportunitiesExport: (cityId: string, format: "csv" | "xlsx" = "csv") =>
    `${API}/opportunities/${cityId}/export?format=${format}`,

  city: (cityId: string) => json(`${API}/city/${cityId}`),

  runJob: runJobImpl,
};

export interface CountryCitiesResult {
  country_code: string;
  country_name: string;
  cities: {
    city_id: string;
    name: string;
    population?: number | null;
    lat?: number | null;
    lon?: number | null;
    snapshot?: {
      total_places: number;
      density_per_10k?: number | null;
      sparse: boolean;
      fetched_at?: string | null;
    } | null;
    top_opportunities?: { label: string; score?: number | null; gap?: number | null; existing?: number | null }[] | null;
  }[];
}

export interface RunResult<T> {
  jobId: string;
  kind: string;
  status: JobStatus["status"];
  stage: string;
  progress: number;
  message?: string | null;
  result?: T | null;
  error?: string | null;
}

/** Start a job and poll until done/error. */
async function runJobImpl<T>(
  kind: string,
  payload: Record<string, unknown>,
  onUpdate?: (r: RunResult<T>) => void,
  intervalMs = 1500,
): Promise<T> {
  const { job_id } = await api.startJob(kind, payload);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const job = await api.job(job_id);
    const run: RunResult<T> = {
      jobId: job.job_id,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message,
      result: (job.result as T) ?? null,
      error: job.error,
    };
    onUpdate?.(run);
    if (job.status === "done") return run.result as T;
    if (job.status === "error") throw new Error(run.error || "Analysis failed");
  }
}
