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

// ─── Supabase (PostgREST) backend ──────────────────────────────────
// The whole API lives in Postgres: reference reads + job submission +
// polling are PostgREST RPC calls; jobs run via pg_cron + pg_net.
const SUPA_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const API = `${SUPA_URL}/rest/v1`;

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    "Content-Type": "application/json",
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    ...(extra || {}),
  };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: authHeaders(init?.headers) });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.message) detail = body.message;
      else if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** Call a PostgREST RPC (public-schema wrapper function). */
async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return json<T>(`${API}/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

/** RPC that returns text — PostgREST may hand back a bare JSON string. */
async function rpcText(name: string, args: Record<string, unknown> = {}): Promise<string | null> {
  const v = await rpc<unknown>(name, args);
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const first = Object.values(rec)[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

/** Trigger a browser download of a text payload. */
function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  health: () => rpc<{ status: string }>("api_health"),

  countries: () => rpc<Country[]>("api_countries"),

  // City autocomplete moved server-side into the resolve_city job; kept
  // for compatibility (returns empty list when not implemented upstream).
  citiesSearch: async (_q: string, _country = ""): Promise<CityCandidate[]> => [],

  countryCities: async (_cca2: string) => {
    throw new Error("countryCities is served by the opportunities job flow");
  },

  families: () => rpc<FamilyInfo[]>("api_families"),

  categories: (params: { q?: string; family?: string; popular?: boolean } = {}) =>
    rpc<CategoryInfo[] | FamilyInfo>("api_categories", {
      q: params.q || null,
      family: params.family || null,
      popular: params.popular ?? null,
    }),

  startJob: (kind: string, payload: Record<string, unknown>) =>
    rpc<{ job_id: string; status: string }>("submit_job", { p_kind: kind, p_payload: payload }),

  job: (id: string) => rpc<JobStatus>("api_job", { p_job_id: id }),

  analysis: (id: string) => rpc<MarketAnalysis>("api_analysis", { p_analysis_id: id }),

  /** Download an analysis export (JSON = raw payload; CSV/Excel = CSV text). */
  analysisExport: async (id: string, format: "json" | "csv" | "xlsx") => {
    if (format === "json") {
      const data = await api.analysis(id);
      downloadText(JSON.stringify(data, null, 2), `analysis-${id}.json`, "application/json");
      return;
    }
    const csv = await rpcText("api_analysis_export", { p_analysis_id: id });
    downloadText(
      csv ?? "",
      `analysis-${id}.${format === "xlsx" ? "xls" : "csv"}`,
      format === "xlsx" ? "application/vnd.ms-excel" : "text/csv",
    );
  },

  market: (cityId: string, category = "", _refresh = false) =>
    rpc<MarketContext>("api_market", { p_city_id: cityId, p_category_label: category }),

  opportunities: (cityId: string) => rpc<OpportunitiesResult>("api_opportunities", { p_city_id: cityId }),

  /** Download the ranked-opportunities CSV for a city. */
  opportunitiesExport: async (cityId: string, format: "csv" | "xlsx" = "csv") => {
    const csv = await rpcText("api_opportunities_export", { p_city_id: cityId });
    downloadText(
      csv ?? "",
      `opportunities-${cityId}.${format === "xlsx" ? "xls" : "csv"}`,
      format === "xlsx" ? "application/vnd.ms-excel" : "text/csv",
    );
  },

  city: (cityId: string) => rpc<Record<string, unknown>>("api_city", { p_city_id: cityId }),

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
