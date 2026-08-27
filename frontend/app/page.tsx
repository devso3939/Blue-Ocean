"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BarChart3,
  Compass,
  Database,
  Globe2,
  Layers,
  LineChart,
  Map,
  Radar,
  Scale,
  Search,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import type { CityCandidate, FamilyInfo, JobStatus } from "@/lib/types";
import { CountrySelect } from "@/components/country-select";
import { CitySelect } from "@/components/city-select";
import { CategorySelect } from "@/components/category-select";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const CAPABILITIES = [
  {
    icon: Target,
    title: "Market Gap Analysis",
    desc: "Detected supply vs a peer benchmark, with an estimated gap in real business counts.",
  },
  {
    icon: Users,
    title: "Peer City Benchmarking",
    desc: "Comparable cities found automatically by population and region.",
  },
  {
    icon: Map,
    title: "Competition Mapping",
    desc: "Every business as a real point — clustered, with density and the city boundary.",
  },
  {
    icon: Scale,
    title: "Per-Capita Supply",
    desc: "Businesses per 10,000 residents, so any city size is judged fairly.",
  },
  {
    icon: Radar,
    title: "Opportunity Scoring",
    desc: "Deterministic 0–100 score from supply gap, undersupply and market size.",
  },
  {
    icon: Globe2,
    title: "Global Coverage",
    desc: "Any city on Earth — open data only, no API keys required.",
  },
];

export default function Home() {
  const router = useRouter();
  const [country, setCountry] = React.useState<string | null>(null);
  const [countryCca2, setCountryCca2] = React.useState<string>("");
  const [countryList, setCountryList] = React.useState<{ name: string; cca2: string }[]>([]);
  const [city, setCity] = React.useState<CityCandidate | null>(null);
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<JobStatus | null>(null);
  const [jobKind, setJobKind] = React.useState("analyze");
  const [busy, setBusy] = React.useState(false);
  const [families, setFamilies] = React.useState<FamilyInfo[]>([]);
  const [explorerQuery, setExplorerQuery] = React.useState("");
  const [explorerResults, setExplorerResults] = React.useState<{ id: string; label: string; family_label: string }[] | null>(null);

  React.useEffect(() => {
    api.families().then(setFamilies).catch(() => {});
    api.countries().then((cs) => setCountryList(cs)).catch(() => {});
  }, []);

  const cityId = city?.name || null;

  function onCountry(name: string, cca2: string) {
    setCountry(name);
    setCountryCca2(cca2);
    setCity(null);
  }

  function cca2For(name: string): string {
    const found = countryList.find((c) => c.name === name);
    return found?.cca2 || "";
  }

  async function startJob(kind: string) {
    if (!country || !city) return;
    setBusy(true);
    // JobProgress keys its hint off the backend job kind; the discovery flow
    // runs an "opportunities" job even though the button passes "discover".
    setJobKind(kind === "discover" ? "opportunities" : kind);
    setJob({} as JobStatus);
    try {
      // 1. resolve the city
      const cityMeta = await api.runJob<{ city_id: string }>("resolve_city", {
        country,
        city: city.name,
      }, (r) => setJob({ ...r, status: r.status } as unknown as JobStatus));
      // 2. run the main analysis
      if (kind === "analyze") {
        if (!categoryId) {
          setBusy(false);
          return;
        }
        const analysis = await api.runJob<{ analysis_id: string }>(
          "analyze",
          { city_id: cityMeta.city_id, category_id: categoryId },
          (r) => setJob({ ...r, status: r.status } as unknown as JobStatus),
        );
        router.push(`/analyze/${analysis.analysis_id}`);
      } else {
        const result = await api.runJob<{ city: { city_id: string } }>(
          "opportunities",
          { city_id: cityMeta.city_id },
          (r) => setJob({ ...r, status: r.status } as unknown as JobStatus),
        );
        router.push(`/discover/${result.city.city_id}`);
      }
    } catch (e) {
      setJob({
        job_id: "",
        kind,
        status: "error",
        stage: "error",
        progress: 1,
        error: e instanceof Error ? e.message : "Request failed",
        created_at: "",
        updated_at: "",
      });
    } finally {
      setBusy(false);
    }
  }

  function onExplorerSearch(q: string) {
    setExplorerQuery(q);
  }

  // Debounced explorer search (CategorySelect-style 300ms), avoids one API
  // call per keystroke.
  React.useEffect(() => {
    if (explorerQuery.trim().length === 0) {
      setExplorerResults(null);
      return;
    }
    const h = setTimeout(() => {
      api.categories({ q: explorerQuery }).then((d) => {
        if (Array.isArray(d)) setExplorerResults(d.map((c) => ({ id: c.id, label: c.label, family_label: c.family_label })));
      });
    }, 300);
    return () => clearTimeout(h);
  }, [explorerQuery]);

  return (
    <div>
      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-60 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]" />
        <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-3xl" />
        <div className="pointer-events-none absolute -right-40 top-40 h-80 w-80 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-20 sm:px-6 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="secondary" className="mb-5">
              <Sparkles className="h-3 w-3" /> Built on Overture Maps · Wikidata · OpenStreetMap
            </Badge>
            <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
              Find What Your City <span className="text-gradient">Is Missing</span>.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
              Underserved industries, real business counts, peer-city benchmarks — for cities anywhere in the world.
            </p>
          </div>

          {/* CONTROLS */}
          <Card className="relative mx-auto mt-10 max-w-3xl shadow-glow">
            <CardContent className="p-4 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-[1fr_1.2fr_1.2fr]">
                <div>
                  <Label>Country</Label>
                  <CountrySelect value={country} onChange={onCountry} />
                </div>
                <div>
                  <Label>City</Label>
                  <CitySelect country={country} value={cityId} onChange={setCity} disabled={!country} />
                </div>
                <div>
                  <Label>Industry</Label>
                  <CategorySelect value={categoryId} onChange={setCategoryId} />
                </div>
              </div>
              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={busy || !country || !city || !categoryId}
                  onClick={() => startJob("analyze")}
                >
                  <Zap className="h-4 w-4" />
                  Analyze Industry
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="flex-1"
                  disabled={busy || !country}
                  onClick={() => {
                    if (!country) return;
                    if (city) {
                      startJob("discover");
                    } else {
                      router.push(`/discover/country/${countryCca2 || cca2For(country)}`);
                    }
                  }}
                >
                  <Compass className="h-4 w-4" />
                  {city ? "Discover Opportunities" : "Compare cities in this country"}
                </Button>
              </div>
              {busy && (
                <div className="mt-6 border-t border-border pt-5">
                  <JobProgress
                    job={job && (job as unknown as JobStatus)}
                    kind={jobKind}
                  />
                </div>
              )}
              {!busy && country && !city && (
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Country selected — pick a city for a single-industry analysis, or{" "}
                  <span className="font-medium text-foreground">compare all cities in {country}</span> with the
                  button above.
                </p>
              )}
              {!busy && city && (
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Analyzing <span className="font-medium text-foreground">{city.name}</span> in{" "}
                  <span className="font-medium text-foreground">{country}</span>
                  {categoryId ? " · industry selected" : " · industry optional for discovery mode"}
                </p>
              )}
            </CardContent>
          </Card>

          {/* quick examples */}
          <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-2">
            <span className="text-xs text-muted-foreground">Try:</span>
            {[
              ["Tbilisi · Pet Grooming", "Georgia", "Tbilisi", "pet_groomer"],
              ["Batumi · Cafes", "Georgia", "Batumi", "cafe"],
              ["London · Gyms", "United Kingdom", "London", "gym"],
              ["Warsaw · Beauty Salons", "Poland", "Warsaw", "beauty_salon"],
            ].map(([label, ctry, cty, cat]) => (
              <button
                key={label}
                type="button"
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                onClick={() => {
                  setCountry(ctry);
                  setCity({ name: cty, country_code: "", display_name: `${cty}` });
                  setCategoryId(cat);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* CAPABILITIES */}
      <section className="border-t border-border/60 bg-secondary/30">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
            Business intelligence for anywhere in the world
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-muted-foreground">
            Not “127 restaurants” — how many per capita, how that compares with similar cities, and what the gap means.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <Card key={c.title} className="transition-colors hover:border-primary/40">
                <CardHeader className="flex-row items-start gap-3 space-y-0">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <c.icon className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />
                  </span>
                  <div>
                    <CardTitle>{c.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">{c.desc}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CATEGORY EXPLORER */}
      <section id="explorer" className="scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Browse the business taxonomy</h2>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                Hundreds of real categories from Overture Maps, grouped into families.
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={explorerQuery}
                onChange={(e) => onExplorerSearch(e.target.value)}
                placeholder="Search categories…"
                className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          {explorerResults ? (
            <div className="mt-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {explorerResults.map((c) => (
                <Link
                  key={c.id}
                  href="/#"
                  className="group flex items-center justify-between rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/50"
                  onClick={(e) => {
                    e.preventDefault();
                    setCategoryId(c.id);
                    document.getElementById("explorer")?.scrollIntoView();
                  }}
                >
                  <span>
                    <span className="block text-sm font-medium">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">{c.family_label}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {families.map((f) => (
                <div key={f.id} className="rounded-xl border border-border bg-card p-5">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Layers className="h-4 w-4 text-primary" />
                    {f.label}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(f.categories || []).slice(0, 8).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setCategoryId(c.id)}
                        className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                      >
                        {c.label}
                      </button>
                    ))}
                    {((f.categories || []).length > 8) && (
                      <span className="px-1 text-xs text-muted-foreground/60">
                        +{(f.categories || []).length - 8} more
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* METHODOLOGY */}
      <section id="methodology" className="scroll-mt-20 border-t border-border/60 bg-secondary/30">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">How is this calculated?</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Everything is deterministic and derived from the numbers — you can verify every step of a score.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Database,
                title: "1 · Existing supply",
                desc: "Overture places, filtered to the city, deduplicated, permanently-closed removed.",
              },
              {
                icon: Scale,
                title: "2 · Normalization",
                desc: "count ÷ population × 10,000. Population from Wikidata, year shown.",
              },
              {
                icon: Users,
                title: "3 · Peer selection",
                desc: "Same-country cities at 0.5–2× population, then regional cities of similar size — always shown.",
              },
              {
                icon: LineChart,
                title: "4 · Expected supply",
                desc: "Weighted median of peer per-10k values × target population.",
              },
              {
                icon: TrendingUp,
                title: "5 · Opportunity Score",
                desc: "60% supply gap + 25% undersupply + 15% market size, deterministically.",
              },
              {
                icon: BarChart3,
                title: "6 · Data Confidence",
                desc: "Separate 0–100 score for coverage, agreement, population, boundary and peers.",
              },
            ].map((m) => (
              <Card key={m.title}>
                <CardHeader className="flex-row items-start gap-3 space-y-0">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <m.icon className="h-4 w-4" />
                  </span>
                  <CardTitle>{m.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">{m.desc}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="mt-8 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Statistical safeguards: categories are never called a Blue Ocean just because zero businesses were found —
            if coverage looks missing, Data Confidence drops and a warning appears instead. Estimated supply gaps are
            market intelligence, not guaranteed demand.
          </p>
        </div>
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{children}</span>
  );
}
