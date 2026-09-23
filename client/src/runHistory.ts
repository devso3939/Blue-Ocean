// v6.9.88: run history — every completed run (Analyze Industry / Discover
// Opportunities) is captured with its full result state so clicking it in
// the History view restores the EXACT post-run screen: competition map,
// business table, opportunities, AI analysis, harvest chips — everything.
//
// Storage: localStorage with byte-aware limits. Above SOFT_LIMIT the UI
// suggests cleanup; above HARD_LIMIT the oldest runs are evicted on save
// (always keeping MIN_KEEP) so the store can never silently break quota.

const KEY = 'bo_run_history_v1';
export const HISTORY_SOFT_LIMIT = 2.5 * 1024 * 1024; // suggest cleanup above this
const HISTORY_HARD_LIMIT = 4.5 * 1024 * 1024;        // evict oldest above this
const MIN_KEEP = 5;

// Business/DemandSignal/AIAnalysis types live in clientEngine — history
// stores them structurally (loose) so this module stays import-free and
// avoids a circular dependency. App.tsx casts on restore.
export interface RunRecord {
  id: string;
  kind: 'analyze' | 'discover';
  ts: number;
  version: string;
  city: { name: string; country: string; countryCode: string; lat: number; lon: number; population: number | null; bbox: [number, number, number, number] };
  category: string | null;            // analyze: the scanned category id
  selectedOppCategory: string | null; // which opportunity row was open
  businesses: [string, unknown[]][];
  opportunities: unknown[];
  demandSignals: [string, unknown][];
  aiInsights: string;
  aiAnalysis: unknown | null;
  scanAreaLabel: string;
  rescanNote: string;
  stats: { bizCount: number; anyContactPct: number };
}

interface Store { runs: RunRecord[] }

function load(): Store {
  try { return JSON.parse(localStorage.getItem(KEY) || '{"runs":[]}') as Store; } catch { return { runs: [] }; }
}
function save(s: Store): void {
  // Evict oldest while over the hard limit (never below MIN_KEEP).
  try {
    while (JSON.stringify(s).length > HISTORY_HARD_LIMIT && s.runs.length > MIN_KEEP) s.runs.shift();
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Quota exceeded — drop the oldest half and retry once.
    try { s.runs = s.runs.slice(Math.ceil(s.runs.length / 2)); localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* give up silently */ }
  }
}

export function saveRun(r: RunRecord): void {
  const s = load();
  const i = s.runs.findIndex(x => x.id === r.id);
  if (i >= 0) s.runs[i] = r; else s.runs.push(r);
  save(s);
}
export function listRuns(): RunRecord[] { return load().runs.slice().sort((a, b) => b.ts - a.ts); }
export function loadRun(id: string): RunRecord | null { return load().runs.find(r => r.id === id) || null; }
export function deleteRuns(ids: string[]): void {
  const s = load();
  s.runs = s.runs.filter(r => !ids.includes(r.id));
  save(s);
}
export function clearRuns(): void { try { localStorage.removeItem(KEY); } catch { /* noop */ } }

// v6.9.90: JSON backup — merge imported runs by id (duplicates skipped),
// quota-safe via the same save() eviction path as normal writes.
export function importRuns(incoming: unknown[]): { added: number; skipped: number } {
  const s = load();
  let added = 0, skipped = 0;
  for (const raw of incoming) {
    const r = raw as RunRecord;
    if (!r || typeof r.id !== 'string' || !r.city || !r.stats) { skipped++; continue; }
    if (s.runs.some(x => x.id === r.id)) { skipped++; continue; }
    s.runs.push(r); added++;
  }
  if (added > 0) save(s);
  return { added, skipped };
}
export function historyStats(): { count: number; bytes: number; heavy: boolean } {
  const raw = localStorage.getItem(KEY) || '';
  let count = 0;
  try { count = ((JSON.parse(raw) as Store).runs || []).length; } catch { /* corrupt */ }
  return { count, bytes: raw.length, heavy: raw.length > HISTORY_SOFT_LIMIT || count > 40 };
}
