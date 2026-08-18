"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowRight, Building2, Compass, Users, BarChart3, TrendingUp } from "lucide-react";
import { api } from "@/lib/api";
import type { CountryCitiesResult } from "@/lib/api";
import { fmtCompact, fmtNum } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScoreRing } from "@/components/score-ring";

export default function CountryCitiesPage({ cca2 }: { cca2: string }) {
  const [data, setData] = React.useState<CountryCitiesResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    api
      .countryCities(cca2)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load cities"));
  }, [cca2]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-xl font-semibold">Couldn't load cities for this country</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
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
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  const cities = data.cities.filter((c) => {
    if (!q.trim()) return true;
    return c.name.toLowerCase().includes(q.toLowerCase());
  });
  const withSnap = data.cities.filter((c) => c.snapshot).length;
  
  // Get top 5 cities by population (for comparison)
  const top5 = data.cities
    .filter((c) => c.population && c.population > 0)
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to start
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Cities in {data.country_name}
            <span className="text-muted-foreground"> · compare before you pick</span>
          </h1>
          <Badge variant="outline">{data.cities.length} cities by population</Badge>
        </div>
        <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
          Population and coordinates come from Wikidata. Cities with map data already scanned show detected businesses,
          coverage density and their top opportunity highlights. Click a city to run (or refresh) its full opportunity scan.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter cities…"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Badge variant="secondary">{withSnap} scanned · {data.cities.length - withSnap} not yet scanned</Badge>
        </div>
      </div>

      {/* Top 5 Cities Comparison */}
      {top5.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" /> Top 5 Cities Comparison
            </CardTitle>
            <CardDescription>
              The largest cities in {data.country_name} — compare population, business density, and opportunities
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {top5.map((city, idx) => {
                const snap = city.snapshot;
                const topOpp = city.top_opportunities?.[0];
                const density = snap?.density_per_10k;
                const sparse = snap?.sparse;
                
                return (
                  <div key={city.city_id} className="rounded-xl border border-border bg-gradient-to-br from-card to-card/80 p-4 transition-all hover:border-primary/40">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
                        {idx + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate">{city.name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {city.population ? fmtCompact(city.population) : "—"} residents
                        </div>
                      </div>
                    </div>
                    
                    {/* Metrics */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Businesses</span>
                        <span className="text-sm font-bold tabular-nums">
                          {snap ? snap.total_places.toLocaleString() : "—"}
                        </span>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Density</span>
                        <div className="flex items-center gap-1">
                          <span className="text-sm font-bold tabular-nums">
                            {density ? `${density}` : "—"}
                          </span>
                          {density && <span className="text-[10px] text-muted-foreground">/10k</span>}
                          {sparse && (
                            <Badge variant="warning" className="text-[8px] ml-1">
                              sparse
                            </Badge>
                          )}
                        </div>
                      </div>
                      
                      {topOpp && (
                        <div className="pt-2 border-t border-border/50">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Top opportunity</div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-primary truncate">{topOpp.label}</span>
                            {topOpp.score != null && (
                              <Badge variant="secondary" className="text-[9px]">
                                {topOpp.score}
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {/* Action */}
                    <div className="mt-3">
                      <Link href={`/discover/${city.city_id}`} className="w-full">
                        <Button variant="outline" size="sm" className="w-full text-xs">
                          <Compass className="h-3 w-3 mr-1" /> 
                          {snap ? "View" : "Scan"}
                        </Button>
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Full Table */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">City</th>
              <th className="px-4 py-3 font-medium">Population</th>
              <th className="px-4 py-3 font-medium">Businesses detected</th>
              <th className="px-4 py-3 font-medium">Coverage density</th>
              <th className="px-4 py-3 font-medium">Top opportunity</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {cities.map((c) => {
              const sparse = c.snapshot?.sparse;
              return (
                <tr key={c.city_id} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                  <td className="px-5 py-3">
                    <div className="font-medium">{c.name}</div>
                    {c.snapshot?.fetched_at && (
                      <div className="text-[10px] text-muted-foreground">scanned {new Date(c.snapshot.fetched_at).toLocaleDateString()}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {c.population ? fmtCompact(c.population) : "—"}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {c.snapshot ? (
                      <span className="font-semibold">{c.snapshot.total_places.toLocaleString()}</span>
                    ) : (
                      <span className="text-muted-foreground">not scanned</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.snapshot?.density_per_10k != null ? (
                      <span className="flex items-center gap-1.5 tabular-nums">
                        {c.snapshot.density_per_10k} /10k
                        {sparse && (
                          <Badge variant="warning" className="text-[9px]">
                            sparse
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="max-w-[260px] px-4 py-3">
                    {c.top_opportunities?.[0] ? (
                      <Link
                        href={`/discover/${c.city_id}`}
                        className="group flex items-center gap-1.5 text-xs text-primary hover:underline"
                      >
                        <span className="truncate">{c.top_opportunities[0].label}</span>
                        {c.top_opportunities[0].score != null && (
                          <Badge variant="secondary" className="text-[9px]">
                            {c.top_opportunities[0].score}
                          </Badge>
                        )}
                        <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/discover/${c.city_id}`}>
                      <Button variant="outline" size="sm">
                        <Compass className="h-3 w-3" /> {c.snapshot ? "View opportunities" : "Scan opportunities"}
                      </Button>
                    </Link>
                  </td>
                </tr>
              );
            })}
            {cities.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-sm text-muted-foreground">
                  No cities match "{q}".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!cities.some((c) => c.snapshot) && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="space-y-1 text-xs text-amber-600 dark:text-amber-400">
            <p className="font-semibold">None of these cities have been scanned yet.</p>
            <p>
              The first scan downloads the city's open map data and benchmarks it against comparable cities — it can take
              a few minutes. Results are cached, so later visits are instant.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        Want a single industry instead? Pick a city here, then choose Country + City + Industry from the start page.
      </div>
    </div>
  );
}
