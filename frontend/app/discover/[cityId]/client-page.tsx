"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Store,
  TrendingUp,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";
import type { JobStatus, OpportunityRow, OpportunitiesResult } from "@/lib/types";
import { scoreColor, scoreHex } from "@/lib/types";
import { cn, fmtCompact, fmtNum, fmtPct } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JobProgress } from "@/components/job-progress";

const MIN_SCORE_OPTIONS = [0, 50, 60, 70, 80];

export default function DiscoverPage({ cityId }: { cityId: string }) {
  const router = useRouter();
  const [data, setData] = React.useState<OpportunitiesResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [minScore, setMinScore] = React.useState(60);
  const [family, setFamily] = React.useState("all");
  const [minExisting, setMinExisting] = React.useState(0);
  const [analyzing, setAnalyzing] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<JobStatus | null>(null);
  const [rechecking, setRechecking] = React.useState(false);

  React.useEffect(() => {
    api
      .opportunities(cityId)
      .then(setData)
      .catch(async (e) => {
        // No cached opportunities — auto-trigger a scan
        try {
          setJob({
            job_id: "",
            kind: "opportunities",
            status: "running",
            stage: "starting",
            progress: 0,
            message: "Starting opportunity scan…",
            created_at: "",
            updated_at: "",
          });
          const result = await api.runJob<OpportunitiesResult>(
            "opportunities",
            { city_id: cityId },
            (r) => setJob({ ...r, status: r.status } as unknown as JobStatus),
          );
          setData(result);
          setJob(null);
        } catch (scanErr) {
          setError(scanErr instanceof Error ? scanErr.message : "Failed to load or scan opportunities");
        }
      });
  }, [cityId]);

  async function recheck() {
    if (!data || rechecking) return;
    setRechecking(true);
    try {
      const res = await api.runJob<OpportunitiesResult>(
        "opportunities",
        { city_id: data.city.city_id, refresh: true },
        (r) => setJob({ ...r, status: r.status } as unknown as JobStatus),
      );
      setData(res);
      setRechecking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recheck failed");
      setRechecking(false);
    }
  }

  async function openDetail(row: OpportunityRow) {
    if (!data) return;
    setAnalyzing(row.category_id);
    setJob(null);
    try {
      const analysis = await api.runJob<{ analysis_id: string }>(
        "analyze",
        { city_id: data.city.city_id, category_id: row.category_id },
        (r) => setJob({ ...r, status: r.status } as unknown as JobStatus),
      );
      router.push(`/analyze/${analysis.analysis_id}`);
    } catch (e) {
      setJob({
        job_id: "",
        kind: "analyze",
        status: "error",
        stage: "error",
        progress: 1,
        error: e instanceof Error ? e.message : "Analysis failed",
        created_at: "",
        updated_at: "",
      });
      setAnalyzing(null);
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-xl font-semibold">No opportunity scan found</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run <span className="font-medium">Discover Opportunities</span> for this city first — the scan is cached, so this
          usually takes seconds on repeat visits.
        </p>
        <Link href="/">
          <Button className="mt-6" variant="outline">
            <ArrowLeft className="h-4 w-4" /> Back to start
          </Button>
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-7xl animate-pulse space-y-6 px-4 py-10 sm:px-6">
        <div className="h-8 w-2/3 rounded-lg bg-muted" />
        <div className="space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  const families = Array.from(new Set(data.opportunities.map((o) => o.family)));
  const familyLabel = (id: string, rows: OpportunityRow[]) => rows.find((r) => r.family === id)?.family_label || id;
  const filtered = data.opportunities.filter((o) => {
    if (o.score === null || o.score === undefined || o.score < minScore) return false;
    if (family !== "all" && o.family !== family) return false;
    if (o.existing < minExisting) return false;
    if (query && !`${o.label} ${o.family_label}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const showScore = minScore > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-6">
      {/* Header */}
      <div>
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to start
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight sm:text-3xl">
            <Sparkles className="h-6 w-6 shrink-0 text-primary" />
            <span>Best Opportunities in {data.city.name}, <span className="text-muted-foreground">{data.city.country}</span></span>
          </h1>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" />
            {data.city.population ? `~${fmtCompact(data.city.population)} residents` : "Population unknown"}
            {data.city.population_year ? ` (${data.city.population_year})` : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            <Store className="h-3 w-3" />
            {data.snapshot.total_places.toLocaleString()} businesses analyzed across{" "}
            {data.opportunities.length} categories
          </span>
          <span className="inline-flex items-center gap-1">
            <TrendingUp className="h-3 w-3" />
            {data.peers.filter((p) => p.snapshot_ready).length} peer cities compared
          </span>
        </p>
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={recheck} disabled={rechecking}>
            <RefreshCw className={cn("h-3.5 w-3.5", rechecking && "animate-spin")} />
            {rechecking ? "Rechecking…" : "Recheck data (refresh from source)"}
          </Button>
        </div>
      </div>

      {/* Sparse coverage */}
      {data.snapshot.population && data.snapshot.population > 0 &&
        data.snapshot.total_places / data.snapshot.population * 10000 < 50 && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-rose-600 dark:text-rose-400">This city has sparse map-data coverage</p>
              <p className="text-xs leading-relaxed text-rose-600/90 dark:text-rose-400/90">
                Only {(data.snapshot.total_places / data.snapshot.population * 10000).toFixed(1)} places per 10,000 residents
                were found in the open map data — some real businesses are missing, so scores here are a lower bound.
                Cross-check individual categories on Google Maps, and use “Recheck data” to refresh from source.
              </p>
            </div>
          </div>
        )}

      {/* Anomaly warnings */}
      {data.anomaly_warnings?.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="space-y-1 text-xs text-amber-600 dark:text-amber-400">
            {data.anomaly_warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search opportunities…"
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Filter className="h-3.5 w-3.5" />
              Min score
              <select
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {MIN_SCORE_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? "any" : `${v}+`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Family
              <select
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All families</option>
                {families.map((f) => (
                  <option key={f} value={f}>
                    {familyLabel(f, data.opportunities)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Existing ≥
              <select
                value={minExisting}
                onChange={(e) => setMinExisting(Number(e.target.value))}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {[0, 1, 5, 10, 20].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <a href={api.opportunitiesExport(cityId, "xlsx")} download>
              <Button variant="default" size="sm">
                <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
              </Button>
            </a>
            <a href={api.opportunitiesExport(cityId, "csv")} download>
              <Button variant="outline" size="sm">
                <Download className="h-3.5 w-3.5" /> CSV
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Ranked table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>
            {filtered.length} {filtered.length === 1 ? "opportunity" : "opportunities"}
            {showScore ? ` with score ≥ ${minScore}` : ""}
            {family !== "all" ? ` in ${familyLabel(family, data.opportunities)}` : ""}
          </CardTitle>
          <CardDescription>
            Ranked by deterministic Opportunity Score — supply gap (60%) + relative undersupply (25%) + market size (15%).
            Click any row to open its full analysis.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2.5 pl-5 pr-2 font-medium">#</th>
                  <th className="py-2.5 pr-4 font-medium">Opportunity</th>
                  <th className="py-2.5 pr-4 font-medium">Family</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Existing</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Per 10k</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Expected</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Gap</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Gap %</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Confidence</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Score</th>
                  <th className="py-2.5 pr-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((o, i) => (
                  <tr
                    key={o.category_id}
                    onClick={() => openDetail(o)}
                    className="group cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <td className="py-3 pl-5 pr-2 text-xs tabular-nums text-muted-foreground">{i + 1}</td>
                    <td className="py-3 pr-4">
                      <div className="font-medium group-hover:text-primary">{o.label}</div>
                      {o.warnings?.length > 0 && (
                        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-amber-500">
                          <AlertTriangle className="h-2.5 w-2.5" /> {o.warnings[0]}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">{o.family_label}</td>
                    <td className="py-3 pr-4 text-right tabular-nums">{fmtNum(o.existing)}</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{o.per_10k !== null && o.per_10k !== undefined ? o.per_10k.toFixed(2) : "—"}</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{o.expected !== null && o.expected !== undefined ? fmtNum(Math.round(o.expected)) : "—"}</td>
                    <td className="py-3 pr-4 text-right">
                      <span className={cn("font-semibold tabular-nums", (o.gap ?? 0) > 0 ? "text-emerald-400" : "text-rose-400")}>
                        {(o.gap ?? 0) > 0 ? "+" : ""}
                        {o.gap !== null && o.gap !== undefined ? fmtNum(Math.round(o.gap)) : "—"}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{o.gap_pct !== null && o.gap_pct !== undefined ? fmtPct(o.gap_pct) : "—"}</td>
                    <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">{o.confidence ?? "—"}</td>
                    <td className="py-3 pr-4 text-right">
                      <span className="inline-flex items-center gap-1.5 font-bold tabular-nums" style={{ color: scoreHex(o.score) }}>
                        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: scoreHex(o.score) }} />
                        {o.score}
                      </span>
                    </td>
                    <td className="py-3 pr-2">
                      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No opportunities match these filters — try lowering the minimum score.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inline job progress while drilling in */}
      {analyzing && (
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="mb-4 flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Opening detailed analysis…
          </p>
          <JobProgress job={job} kind="analyze" />
        </div>
      )}

      {/* Methodology note */}
      <div className="rounded-xl border border-border bg-card p-5 text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">How the ranking works</p>
        <p className="mt-1">
          Every commercial category in the Overture taxonomy is aggregated for {data.city.name} and its{" "}
          {data.peers.filter((p) => p.snapshot_ready).length} peer cities, then scored identically:{" "}
          <span className="font-mono">0.60 × supply-gap + 0.25 × undersupply-percentile + 0.15 × market-size</span>. Categories
          with near-zero counts everywhere are excluded so missing data is never dressed up as a Blue Ocean. Scores are
          deterministic — the same city always produces the same ranking. Estimated gaps are market intelligence, not
          guaranteed demand.
        </p>
      </div>

      <div className="flex justify-center">
        <Link href="/">
          <Button variant="outline">
            <ArrowRight className="h-4 w-4" /> Analyze another city
          </Button>
        </Link>
      </div>
    </div>
  );
}
