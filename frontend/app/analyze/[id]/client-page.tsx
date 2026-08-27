"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Building2,
  Calendar,
  CheckCircle2,
  Download,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  Globe,
  Info,
  Landmark,
  Mail,
  MapPin,
  RefreshCw,
  Search,
  Sparkles,
  Store,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { api } from "@/lib/api";
import type { MarketAnalysis, MarketContext } from "@/lib/types";
import { scoreColor, scoreHex } from "@/lib/types";
import { cn, fmtCompact, fmtDate, fmtNum, fmtPct } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScoreRing } from "@/components/score-ring";
import { MapView } from "@/components/map-view";
import { ConfidenceBreakdown, ExistingVsExpected, PerCapitaChart, SupplyPosition } from "@/components/analysis-charts";
import { useRouteParam } from "@/lib/use-route-param";

export default function AnalysisPage({ id }: { id: string }) {
  // Under static export + SPA fallback the root page can be served at a deep
  // URL ('/analyze/<real-id>'); recover the real id from the address bar.
  const realId = useRouteParam(id, /^\/analyze\/([^/]+)/);
  const [analysis, setAnalysis] = React.useState<MarketAnalysis | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [placesExpanded, setPlacesExpanded] = React.useState(false);
  const [bizQuery, setBizQuery] = React.useState("");
  const [rechecking, setRechecking] = React.useState(false);

  React.useEffect(() => {
    if (!realId) return;
    api
      .analysis(realId)
      .then(setAnalysis)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load analysis"));
  }, [realId]);

  const recheck = async () => {
    if (!analysis || rechecking) return;
    setRechecking(true);
    try {
      const res = await api.runJob<MarketAnalysis>("analyze", {
        city_id: analysis.city.city_id,
        category_id: analysis.category.id,
        refresh: true,
      });
      window.location.href = `/analyze/${res.analysis_id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recheck failed");
      setRechecking(false);
    }
  };

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-xl font-semibold">Couldn't load this analysis</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Analyses are cached briefly and the server may have restarted — run the analysis again.
        </p>
        <Link href="/">
          <Button className="mt-6" variant="outline">
            <ArrowLeft className="h-4 w-4" /> Back to start
          </Button>
        </Link>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="mx-auto max-w-7xl animate-pulse space-y-6 px-4 py-10 sm:px-6">
        <div className="h-8 w-2/3 rounded-lg bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-[520px] rounded-xl bg-muted" />
      </div>
    );
  }

  const s = analysis.stats;
  const sc = s.score_components as Record<string, any>;
  const cc = (s.confidence_components || {}) as Record<string, any>;
  const m = analysis.methodology as Record<string, any>;
  const pop = analysis.city.population ?? analysis.snapshot.population;
  const popYear = analysis.city.population_year ?? analysis.snapshot.population_year;
  const gap = s.gap ?? 0;
  const isGap = gap > 0;

  const kpis = [
    {
      label: "Existing Businesses",
      value: fmtNum(s.count),
      sub: `${fmtNum(s.per_10k, 2)} per 10,000 residents${s.name_signal_matches ? ` · ${fmtNum(s.name_signal_matches)} by learned name signals` : ""}`,
      icon: Store,
      tint: "bg-violet-500/15 text-violet-400",
      valueClass: "",
    },
    {
      label: "Peer Benchmark",
      value: s.expected_per_10k !== null && s.expected_per_10k !== undefined ? s.expected_per_10k.toFixed(2) : "—",
      sub: "per 10,000 residents",
      icon: Target,
      tint: "bg-sky-500/15 text-sky-400",
      valueClass: "",
    },
    {
      label: "Expected at Benchmark",
      value: s.expected_count !== null && s.expected_count !== undefined ? fmtNum(Math.round(s.expected_count)) : "—",
      sub: "if matching the peer median",
      icon: Users,
      tint: "bg-teal-500/15 text-teal-400",
      valueClass: "",
    },
    {
      label: "Estimated Supply Gap",
      value: s.gap !== null && s.gap !== undefined ? `${gap > 0 ? "+" : ""}${fmtNum(Math.round(gap))}` : "—",
      sub: s.gap_pct !== null && s.gap_pct !== undefined ? `${fmtPct(s.gap_pct)} vs benchmark` : "market intelligence, not guaranteed demand",
      icon: isGap ? TrendingUp : TrendingDown,
      tint: isGap ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400",
      valueClass: isGap ? "text-emerald-400" : "text-rose-400",
    },
  ];

  const scGap = typeof sc.gap_score === "number" ? sc.gap_score : 0;
  const scPct = typeof sc.undersupply_percentile === "number" ? sc.undersupply_percentile : 0;
  const scMkt = typeof sc.market_size_score === "number" ? sc.market_size_score : 0;

  const filteredPlaces = analysis.places.filter((p) => {
    if (!bizQuery.trim()) return true;
    const q = bizQuery.toLowerCase();
    return [p.name, p.address, p.brand, p.category_label, p.phones.join(" "), p.websites.join(" ")]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(q));
  });
  const displayedPlaces = placesExpanded ? filteredPlaces : filteredPlaces.slice(0, 50);

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 sm:px-6">
      {/* Header */}
      <div>
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to start
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {s.label} in {analysis.city.name}
            <span className="text-muted-foreground">, {analysis.city.country}</span>
          </h1>
          <Badge variant={s.data_confidence && s.data_confidence >= 60 ? "success" : "warning"}>
            Confidence {s.data_confidence}/100
          </Badge>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" />
            {pop ? `~${fmtCompact(pop)} residents` : "Population unknown"}
            {popYear ? ` (${popYear} estimate)` : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            POI data retrieved {fmtDate(analysis.snapshot.fetched_at)} · Overture release {analysis.snapshot.overture_release}
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {analysis.snapshot.total_places.toLocaleString()} places detected in city
          </span>
        </p>
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={recheck} disabled={rechecking}>
            {rechecking ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {rechecking ? "Rechecking…" : "Recheck data (refresh from source)"}
          </Button>
        </div>
      </div>

      {/* Sparse coverage warning */}
      {analysis.sparse_coverage && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
          <div className="space-y-1 text-sm">
            <p className="font-semibold text-rose-600 dark:text-rose-400">
              This city has sparse map-data coverage — counts are a lower bound
            </p>
            <p className="text-xs leading-relaxed text-rose-600/90 dark:text-rose-400/90">
              {analysis.sparse_coverage_detail}
            </p>
            <p className="text-xs text-rose-600/80 dark:text-rose-400/80">
              The open map data for this city is thin, so some real businesses are missing from the counts above (for
              example, Google Maps may show more). Treat the gap and score as indicative only, and cross-check before
              investing. Press "Recheck data" to pull the latest open data now.
            </p>
          </div>
        </div>
      )}

      {/* Warnings */}
      {s.warnings?.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="space-y-1 text-xs text-amber-600 dark:text-amber-400">
            {s.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="overflow-hidden transition-colors hover:border-primary/40">
            <CardContent className="p-5">
              <div className="flex items-center gap-2.5">
                <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", k.tint)}>
                  <k.icon className="h-4 w-4" />
                </div>
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
              </div>
              <div className={cn("mt-3 text-3xl font-bold tabular-nums tracking-tight", k.valueClass)}>{k.value}</div>
              <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{k.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Opportunity panel */}
      <Card className="overflow-hidden">
        <CardContent className="p-6">
          <div className="grid gap-8 lg:grid-cols-[auto_auto_1fr] lg:items-center">
            <div className="flex items-center gap-8">
              <ScoreRing score={s.opportunity_score} label="Opportunity" size={148} />
              <div className="flex flex-col items-center gap-2.5">
                <ScoreRing score={s.data_confidence} label="Confidence" size={74} />
                <Badge variant="outline" className="text-[10px]">
                  {s.score_label}
                </Badge>
              </div>
            </div>
            <div className="hidden h-40 w-px bg-border lg:block" />
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold">How the score is built</div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="text-[10px]">gap {scGap}</Badge>
                  <Badge variant="secondary" className="text-[10px]">undersupply percentile {scPct}</Badge>
                  <Badge variant="secondary" className="text-[10px]">market size {scMkt}</Badge>
                </div>
              </div>
              <div className="mt-2 font-mono text-xs leading-relaxed text-muted-foreground">
                0.60 × gap <span className="font-semibold text-foreground">{scGap}</span> + 0.25 × percentile{" "}
                <span className="font-semibold text-foreground">{scPct}</span> + 0.15 × market{" "}
                <span className="font-semibold text-foreground">{scMkt}</span> ={" "}
                <span className={cn("font-bold", scoreColor(s.opportunity_score))}>{s.opportunity_score}/100</span>
              </div>
              <SupplyPosition gapPct={s.gap_pct} score={s.opportunity_score} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Map */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Competition map</h2>
          <Badge variant="outline">
            {analysis.places.length.toLocaleString()} points shown
          </Badge>
        </div>
        <MapView
          places={analysis.places}
          boundary={analysis.city.boundary}
          densityGrid={analysis.density_grid}
          center={analysis.city.center}
          height={540}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Existing vs Expected</CardTitle>
            <CardDescription>Detected supply vs the peer-city benchmark applied to this population</CardDescription>
          </CardHeader>
          <CardContent>
            <ExistingVsExpected existing={s.count} expected={s.expected_count} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Similar city comparison</CardTitle>
            <CardDescription>Businesses per 10,000 residents — the highlighted bar is this city</CardDescription>
          </CardHeader>
          <CardContent>
            <PerCapitaChart cityName={analysis.city.name} cityPer10k={s.per_10k} peers={analysis.peers} />
          </CardContent>
        </Card>
      </div>

      {/* Peer list */}
      <Card>
        <CardHeader>
          <CardTitle>Compared with</CardTitle>
          <CardDescription>
            Automatically selected peers — same-country at 0.5–2× population first, then regional cities of similar size.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">City</th>
                  <th className="py-2 pr-4 font-medium">Country</th>
                  <th className="py-2 pr-4 font-medium">Population</th>
                  <th className="py-2 pr-4 font-medium">Detected</th>
                  <th className="py-2 pr-4 font-medium">Weight</th>
                  <th className="py-2 pr-4 font-medium">Per 10k</th>
                  <th className="py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {analysis.peers.map((p) => (
                  <tr key={p.city_id} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pr-4 font-medium">{p.name}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{p.country}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">{p.population ? fmtCompact(p.population) : "—"}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">{p.total_places.toLocaleString()}</td>
                    <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">{p.weight.toFixed(2)}</td>
                    <td className="py-2.5 pr-4 tabular-nums">
                      {p.per_10k !== null && p.per_10k !== undefined ? (
                        <span
                          className={cn(
                            "font-semibold",
                            s.per_10k === null || s.per_10k === undefined
                              ? ""
                              : p.per_10k > s.per_10k
                                ? "text-emerald-400"
                                : p.per_10k < s.per_10k
                                  ? "text-rose-400"
                                  : ""
                          )}
                        >
                          {p.per_10k.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-[240px] py-2.5 text-xs text-muted-foreground">{p.note || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis.peers.some((p) => p.note) && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Peers flagged with a note were excluded from the benchmark (low category count or sparse POI coverage treated
              as missing data). The weighted median uses only qualifying peers.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Explanation */}
      <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-4 w-4 text-primary" /> Why this opportunity exists
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-4xl text-sm leading-relaxed">{s.explanation}</p>
        </CardContent>
      </Card>

      {/* AI analyst brief */}
      {s.ai_insight && (
        <Card className="border-violet-500/30 bg-gradient-to-br from-violet-500/10 to-transparent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-400" /> AI Analyst Brief
              <Badge variant="secondary" className="text-[10px]">
                written from the computed numbers
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-w-4xl space-y-1.5 whitespace-pre-line text-sm leading-relaxed">
              {s.ai_insight.split("\n").map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Demand signals */}
      {m.demand_detection && (
        <DemandCard demand={m.demand_detection as Record<string, any>} />
      )}

      {/* Market context */}
      {analysis.market && (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-primary" /> Market context · {analysis.market.country_name}
              </CardTitle>
              <CardDescription>Country economics (World Bank), buyer potential and a transparent startup-cost estimate.</CardDescription>
            </div>
            <Badge variant="outline" className="shrink-0">
              {analysis.market.country_code}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-6">
            <MarketIndicators market={analysis.market} />
            <div className="grid gap-6 lg:grid-cols-2">
              <BuyerPotential market={analysis.market} />
              <StartupEstimate market={analysis.market} />
            </div>
            <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">Sources & assumptions</p>
              {analysis.market.assumptions.map((a, i) => (
                <p key={i}>· {a}</p>
              ))}
              <p>· {analysis.market.sources.join(", ")}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Individual businesses */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" /> Individual businesses detected
            </CardTitle>
            <CardDescription>
              {analysis.places.length.toLocaleString()} {s.label.toLowerCase()} businesses inside the city boundary
              {bizQuery ? ` · ${filteredPlaces.length} match "${bizQuery}"` : ""}
            </CardDescription>
          </div>
          <div className="relative w-56 shrink-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={bizQuery}
              onChange={(e) => setBizQuery(e.target.value)}
              placeholder="Search name, address, phone…"
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Address</th>
                  <th className="px-4 py-2.5 font-medium">Phone</th>
                  <th className="px-4 py-2.5 font-medium">Website / Social</th>
                  <th className="px-4 py-2.5 font-medium">Maps</th>
                  <th className="px-4 py-2.5 font-medium">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {displayedPlaces.map((p) => (
                  <tr key={p.id} className="border-b border-border/50 last:border-0 hover:bg-muted/40">
                    <td className="px-5 py-2.5">
                      <div className="font-medium">{p.name || <span className="text-muted-foreground">Unnamed</span>}</div>
                      {p.brand && <div className="text-xs text-muted-foreground">{p.brand}</div>}
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-2.5 text-xs text-muted-foreground" title={p.address || ""}>
                      {p.address || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums">
                      {p.phones?.[0] ? (
                        <a href={`tel:${p.phones[0]}`} className="text-primary hover:underline">
                          {p.phones[0]}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {p.websites?.[0] && (
                          <a href={p.websites[0]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-secondary-foreground hover:bg-accent">
                            <ExternalLink className="h-3 w-3" /> site
                          </a>
                        )}
                        {p.socials?.slice(0, 2).map((s, i) => (
                          <a key={i} href={s} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-secondary-foreground hover:bg-accent">
                            <ExternalLink className="h-3 w-3" /> social
                          </a>
                        ))}
                        {p.emails?.slice(0, 2).map((em) => (
                          <a
                            key={em}
                            href={`mailto:${em}`}
                            title={em}
                            className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-md bg-secondary px-2 py-1 font-mono text-[11px] text-secondary-foreground hover:bg-accent"
                          >
                            <Mail className="h-3 w-3 shrink-0" />
                            <span className="truncate">{em}</span>
                          </a>
                        ))}
                        {!p.websites?.length && !p.socials?.length && !p.emails?.length && <span className="text-muted-foreground">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name || ""} ${p.address || ""} ${p.lat},${p.lon}`.trim())}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 font-medium text-secondary-foreground hover:bg-accent"
                        >
                          <MapPin className="h-3 w-3" /> Google
                        </a>
                        <a
                          href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-secondary-foreground hover:bg-accent"
                        >
                          OSM
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn("text-xs font-semibold", p.confidence >= 0.7 ? "text-emerald-400" : p.confidence >= 0.5 ? "text-amber-400" : "text-rose-400")}>
                        {Math.round(p.confidence * 100)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredPlaces.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">No businesses match your search.</div>
          )}
          {filteredPlaces.length > 50 && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => setPlacesExpanded((v) => !v)}>
                {placesExpanded ? "Show fewer" : `Show all ${filteredPlaces.length.toLocaleString()} businesses`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Methodology + Confidence */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>How is this calculated?</CardTitle>
            <CardDescription>Every number above is derived from the data — nothing is invented.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                <span className="font-semibold text-foreground">Existing supply:</span>{" "}
                {s.count} {s.label.toLowerCase()} POIs from Overture Maps ({analysis.snapshot.overture_release}), kept after
                removing permanently closed places, invalid geometry, duplicates and low-confidence records
                ({analysis.snapshot.total_places.toLocaleString()} places in the city overall).
              </p>
              <p>
                <span className="font-semibold text-foreground">Normalization:</span> {s.per_10k ?? "—"} per 10,000 residents
                {pop ? ` (population ${fmtCompact(pop)}${popYear ? `, ${popYear}` : ""})` : ""} — <span className="font-mono">count / population × 10,000</span>.
              </p>
              <p>
                <span className="font-semibold text-foreground">Benchmark:</span> weighted median of peer per-10k values
                ({s.expected_per_10k ?? "—"} per 10k) using {analysis.peers.filter((p) => p.per_10k !== null).length} qualifying peers.
              </p>
              <p>
                <span className="font-semibold text-foreground">Expected supply:</span>{" "}
                {s.expected_count !== null && s.expected_count !== undefined ? Math.round(s.expected_count) : "—"} = benchmark ×
                population / 10,000.
              </p>
              <p>
                <span className="font-semibold text-foreground">Gap:</span> {gap > 0 ? "+" : ""}
                {s.gap !== null && s.gap !== undefined ? Math.round(s.gap) : "—"} businesses ({fmtPct(s.gap_pct)}). This is an
                estimate of supply shortfall — market intelligence, not a guarantee of demand.
              </p>
              <p>
                <span className="font-semibold text-foreground">Score:</span>{" "}
                <span className="font-mono">0.60×gap({sc.gap_score}) + 0.25×percentile({sc.undersupply_percentile}) + 0.15×market({sc.market_size_score})</span>{" "}
                = <span className={cn("font-bold", scoreColor(s.opportunity_score))}>{s.opportunity_score}/100</span> ({s.score_label}).
              </p>
              <p className="pt-1 text-[11px]">
                Sources: Overture Maps Places · Wikidata (population) · OpenStreetMap/Nominatim (boundaries). POI data
                retrieved {fmtDate(analysis.snapshot.fetched_at)}.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Data confidence
            </CardTitle>
            <CardDescription>
              Confidence is independent of opportunity — it measures how much the underlying data can be trusted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex items-center gap-4">
              <ScoreRing score={s.data_confidence} label="Confidence" size={92} />
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>
                  {s.data_confidence !== null && s.data_confidence !== undefined && s.data_confidence >= 70
                    ? "The underlying data supports this comparison reasonably well."
                    : s.data_confidence !== null && s.data_confidence !== undefined && s.data_confidence >= 45
                      ? "Data is usable but has meaningful gaps — treat numbers as indicative."
                      : "Data quality is limited — treat this analysis with caution."}
                </p>
                <p className="text-[11px]">POI coverage · category validity · OSM agreement · population recency · boundary · peers · consistency</p>
              </div>
            </div>
            <ConfidenceBreakdown components={cc} />
          </CardContent>
        </Card>
      </div>

      {/* Export */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Download className="h-4 w-4" />
          Export this analysis — city, population, category, business list, peers, benchmark, gap, scores and source metadata.
        </div>
        <div className="flex gap-2">
          <a href={api.analysisExport(id, "xlsx")} download>
            <Button variant="default" size="sm">
              <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
            </Button>
          </a>
          <a href={api.analysisExport(id, "csv")} download>
            <Button variant="outline" size="sm">
              <FileJson className="h-3.5 w-3.5" /> CSV
            </Button>
          </a>
          <a href={api.analysisExport(id, "json")} download>
            <Button variant="outline" size="sm">
              <FileJson className="h-3.5 w-3.5" /> JSON
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}

type Fmt = (v: number) => string;

type IndicatorItem = {
  key: string;
  label: string;
  fmt: Fmt;
  good?: (v: number) => boolean;
  goodLabel?: string;
  badLabel?: string;
};

type IndicatorGroup = {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
  items: IndicatorItem[];
};

function MarketIndicators({ market }: { market: MarketContext }) {
  const groups: IndicatorGroup[] = [
    {
      title: "Economy",
      icon: Activity,
      tint: "bg-sky-500/15 text-sky-400",
      items: [
        { key: "gdp_ppp", label: "GDP (PPP)", fmt: (v) => `$${fmtCompact(v)}` },
        { key: "gdp_growth", label: "GDP growth", fmt: (v) => `${v.toFixed(1)}%`, good: (v) => v >= 0, goodLabel: "expanding", badLabel: "contracting" },
        { key: "gdp_per_capita_ppp", label: "GDP per capita (PPP)", fmt: (v) => `$${fmtNum(Math.round(v))}` },
        { key: "gni_per_capita_ppp", label: "GNI per capita (PPP)", fmt: (v) => `$${fmtNum(Math.round(v))}` },
        { key: "inflation", label: "Inflation", fmt: (v) => `${v.toFixed(1)}%`, good: (v) => v <= 8, goodLabel: "stable", badLabel: "high" },
        { key: "tax_revenue_pct_gdp", label: "Gov revenue (% of GDP)", fmt: (v) => `${v.toFixed(1)}%` },
      ],
    },
    {
      title: "People & workforce",
      icon: Users,
      tint: "bg-teal-500/15 text-teal-400",
      items: [
        { key: "population_total", label: "Population", fmt: (v) => fmtCompact(v) },
        { key: "working_age_share", label: "Working-age share", fmt: (v) => `${v.toFixed(1)}%`, good: (v) => v >= 60, goodLabel: "favourable", badLabel: "low" },
        { key: "labor_force_participation", label: "Labour force participation", fmt: (v) => `${v.toFixed(1)}%` },
        { key: "unemployment", label: "Unemployment", fmt: (v) => `${v.toFixed(1)}%`, good: (v) => v <= 8, goodLabel: "low", badLabel: "high" },
        { key: "urban_share", label: "Urban population", fmt: (v) => `${v.toFixed(1)}%` },
        { key: "life_expectancy", label: "Life expectancy", fmt: (v) => `${v.toFixed(1)} yrs` },
        { key: "gini", label: "Inequality (Gini)", fmt: (v) => v.toFixed(0) },
      ],
    },
    {
      title: "Digital & new business",
      icon: Globe,
      tint: "bg-violet-500/15 text-violet-400",
      items: [
        { key: "internet_users", label: "Internet users", fmt: (v) => `${v.toFixed(1)}%`, good: (v) => v >= 70, goodLabel: "wide reach", badLabel: "limited" },
        { key: "mobile_subscriptions", label: "Mobile subscriptions /100", fmt: (v) => v.toFixed(0) },
        { key: "new_business_density", label: "New businesses registered (yr)", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
        { key: "secondary_enrollment", label: "Secondary enrolment", fmt: (v) => `${v.toFixed(0)}%` },
      ],
    },
  ];

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="mb-3 flex items-center gap-2">
            <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg", g.tint)}>
              <g.icon className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold tracking-wide text-foreground">{g.title}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-7">
            {g.items.map((it) => {
              const ind = market.indicators[it.key];
              const v = ind?.value;
              const has = v !== null && v !== undefined;
              const isGood = has && it.good ? it.good(v) : null;
              return (
                <div key={it.key} className="rounded-xl border border-border/60 bg-gradient-to-br from-muted/30 to-muted/10 p-3 transition-colors hover:border-border">
                  <div className="flex items-start justify-between gap-1">
                    <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground" title={it.label}>
                      {it.label}
                    </span>
                    {isGood !== null && (
                      <span className={cn("shrink-0 text-[10px] font-bold", isGood ? "text-emerald-400" : "text-rose-400")} title={isGood ? it.goodLabel : it.badLabel}>
                        {isGood ? "▲" : "▼"}
                      </span>
                    )}
                  </div>
                  <div className={cn("mt-2 text-lg font-bold tabular-nums", !has && "text-sm font-normal text-muted-foreground")}>
                    {has ? it.fmt(v) : "—"}
                  </div>
                  <div className={cn("mt-0.5 text-[10px]", has ? "text-muted-foreground" : "italic text-muted-foreground/70")}>
                    {has ? `World Bank ${ind?.year}` : "not published"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function BuyerPotential({ market }: { market: MarketContext }) {
  const bp = market.buyer_potential;
  const comps = (bp.components || {}) as Record<string, number>;

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-card to-card/80 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Potential buyer score</h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{bp.note}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums" style={{ color: scoreHex(bp.score) }}>
              {bp.score}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Buyers</div>
          </div>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {[
          ["Market size", comps.market_size, "from-sky-500 to-sky-400"],
          ["Purchasing power", comps.purchasing_power, "from-violet-500 to-violet-400"],
          ["Demographics", comps.demographics, "from-teal-500 to-teal-400"],
          ["Digital reach", comps.digital_reach, "from-indigo-500 to-indigo-400"],
        ].map(([label, val, colorClass]) => (
          <div key={label as string} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
              <span className="text-[11px] font-bold tabular-nums">{val ?? 0}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/80">
              <div className={cn("h-full rounded-full bg-gradient-to-r transition-all duration-500", colorClass)} style={{ width: `${val ?? 0}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[10px] text-muted-foreground font-mono">{bp.formula}</p>
    </div>
  );
}

function StartupEstimate({ market }: { market: MarketContext }) {
  const se = market.startup_estimate as Record<string, any>;
  
  const costRows = [
    { label: "Avg monthly wage", value: se.avg_monthly_wage_est, icon: "💰" },
    { label: "Monthly rent", value: se.monthly_rent_est, icon: "🏢" },
  ];
  
  const investRows = [
    { label: "Fit-out", value: se.fitout_est, icon: "🔨" },
    { label: "Equipment", value: se.equipment_est, icon: "⚙️" },
    { label: "6-month working capital", value: se.working_capital_6m_est, icon: "💼" },
  ];
  
  const payback = se.payback_months_est != null && se.payback_months_est > 0 ? se.payback_months_est : null;

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-card to-card/80 p-5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/15">
          <Wallet className="h-4 w-4 text-violet-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Startup cost estimate</h3>
          <p className="text-[11px] text-muted-foreground">
            Opening a {se.category || "business"} in {se.city} · estimates, not quotes · 2 staff assumed
          </p>
        </div>
      </div>
      
      {/* Monthly costs */}
      <div className="mt-4 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Monthly costs</div>
        {costRows.map((row) => (
          <div key={row.label} className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm">{row.icon}</span>
              <span className="text-xs text-muted-foreground">{row.label}</span>
            </div>
            <span className="text-xs font-bold tabular-nums">${fmtNum(row.value ?? 0)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between rounded-lg bg-primary/10 px-3 py-2">
          <span className="text-xs font-semibold">Total monthly (2 staff + rent)</span>
          <span className="text-sm font-bold tabular-nums">${fmtNum(se.monthly_costs_est ?? 0)}</span>
        </div>
      </div>
      
      {/* Investment breakdown */}
      <div className="mt-4 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Investment breakdown</div>
        {investRows.map((row) => (
          <div key={row.label} className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm">{row.icon}</span>
              <span className="text-xs text-muted-foreground">{row.label}</span>
            </div>
            <span className="text-xs font-bold tabular-nums">${fmtNum(row.value ?? 0)}</span>
          </div>
        ))}
      </div>
      
      {/* Total and payback */}
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between rounded-lg bg-gradient-to-r from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 px-4 py-3">
          <span className="text-sm font-semibold">Estimated total investment</span>
          <span className="text-lg font-bold tabular-nums">${fmtNum(se.total_investment_est ?? 0)}</span>
        </div>
        {payback !== null && (
          <div className="flex items-center justify-between rounded-lg bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 px-4 py-3">
            <span className="text-sm font-semibold">Estimated payback period</span>
            <span className="text-lg font-bold tabular-nums">≈ {payback} months</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DemandCard({ demand }: { demand: any }) {
  if (!demand) return null;
  return (
    <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-400" /> Demand Signals
          <Badge variant="secondary" className="text-[10px]">from Google Trends, Reddit, Wikipedia</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/20 text-lg font-bold text-emerald-400">
              {demand.score}
            </div>
            <div>
              <p className="text-sm font-medium">Demand Score</p>
              <p className="text-xs text-muted-foreground">{demand.explanation}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            {(demand.normalized?.google_trends ?? 0) > 0 && (
              <div className="rounded-lg bg-muted/50 p-2"><p className="text-muted-foreground">Google Trends</p><p className="font-medium">{demand.normalized.google_trends}/100</p></div>
            )}
            {(demand.normalized?.reddit ?? 0) > 0 && (
              <div className="rounded-lg bg-muted/50 p-2"><p className="text-muted-foreground">Reddit Activity</p><p className="font-medium">{demand.normalized.reddit}/100</p></div>
            )}
            {(demand.normalized?.wikipedia ?? 0) > 0 && (
              <div className="rounded-lg bg-muted/50 p-2"><p className="text-muted-foreground">Knowledge Demand</p><p className="font-medium">{demand.normalized.wikipedia}/100</p></div>
            )}
            {(demand.normalized?.web_density ?? 0) > 0 && (
              <div className="rounded-lg bg-muted/50 p-2"><p className="text-muted-foreground">Web Presence</p><p className="font-medium">{demand.normalized.web_density}/100</p></div>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Sources: {demand.sources?.join(', ') || 'Calculated'} · Demand adds up to 15% to the final opportunity score.</p>
        </div>
      </CardContent>
    </Card>
  );
}
