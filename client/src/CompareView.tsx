import { useState, useCallback, useEffect, useRef } from 'react';
import {
  resolveCity,
  queryBusinesses,
  computeOpportunities,
  getCategoryLabel,
  type CityResult,
  type Business,
  type DemandSignal,
  type OpportunityResult,
} from './clientEngine';
import { analyzeComparison } from './aiAnalysis';

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

const COUNTRIES = [
  { name: 'Georgia', code: 'GE' }, { name: 'Armenia', code: 'AM' },
  { name: 'Azerbaijan', code: 'AZ' }, { name: 'Turkey', code: 'TR' },
  { name: 'Russia', code: 'RU' }, { name: 'Ukraine', code: 'UA' },
  { name: 'Poland', code: 'PL' }, { name: 'Germany', code: 'DE' },
  { name: 'France', code: 'FR' }, { name: 'United Kingdom', code: 'GB' },
  { name: 'United States', code: 'US' }, { name: 'India', code: 'IN' },
  { name: 'China', code: 'CN' }, { name: 'Japan', code: 'JP' },
  { name: 'Brazil', code: 'BR' }, { name: 'Argentina', code: 'AR' },
  { name: 'Mexico', code: 'MX' }, { name: 'Egypt', code: 'EG' },
  { name: 'Nigeria', code: 'NG' }, { name: 'South Africa', code: 'ZA' },
  { name: 'Thailand', code: 'TH' }, { name: 'Indonesia', code: 'ID' },
  { name: 'Vietnam', code: 'VN' }, { name: 'Philippines', code: 'PH' },
  { name: 'South Korea', code: 'KR' }, { name: 'Spain', code: 'ES' },
  { name: 'Italy', code: 'IT' }, { name: 'Netherlands', code: 'NL' },
  { name: 'Sweden', code: 'SE' }, { name: 'Norway', code: 'NO' },
  { name: 'Greece', code: 'GR' }, { name: 'Czech Republic', code: 'CZ' },
  { name: 'Romania', code: 'RO' }, { name: 'Bulgaria', code: 'BG' },
  { name: 'Serbia', code: 'RS' }, { name: 'Croatia', code: 'HR' },
  { name: 'Hungary', code: 'HU' }, { name: 'Austria', code: 'AT' },
  { name: 'Switzerland', code: 'CH' }, { name: 'Belgium', code: 'BE' },
  { name: 'Portugal', code: 'PT' }, { name: 'Ireland', code: 'IE' },
  { name: 'Denmark', code: 'DK' }, { name: 'Finland', code: 'FI' },
  { name: 'Canada', code: 'CA' }, { name: 'Australia', code: 'AU' },
  { name: 'New Zealand', code: 'NZ' }, { name: 'Chile', code: 'CL' },
  { name: 'Colombia', code: 'CO' }, { name: 'Peru', code: 'PE' },
];

// ─── City Panel ────────────────────────────────────────────────────

interface CityPanelProps {
  label: string;
  color: string;
  onScan: (city: CityResult) => void;
}

function CityPanel({ label, color, onScan }: CityPanelProps) {
  const [country, setCountry] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const [cityResults, setCityResults] = useState<CityResult[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityResult | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!cityQuery.trim() || cityQuery.length < 2) { setCityResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const q = country ? `${cityQuery}, ${country}` : cityQuery;
        const results = await resolveCity(q);
        setCityResults(results.slice(0, 6));
      } catch {}
      setSearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [cityQuery, country]);

  return (
    <div className="rounded-xl border bg-card p-4" style={{ borderColor: color + '33' }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-3 h-3 rounded-full" style={{ background: color }} />
        <span className="text-sm font-bold" style={{ color }}>{label}</span>
      </div>
      <div className="grid gap-2 grid-cols-[1fr_1.5fr]">
        <select
          value={country}
          onChange={e => { setCountry(e.target.value); setSelectedCity(null); setCityQuery(''); setCityResults([]); }}
          className="h-9 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Country</option>
          {COUNTRIES.map(c => <option key={c.code} value={c.name}>{c.name}</option>)}
        </select>
        <div className="relative">
          <input
            value={selectedCity ? `${selectedCity.name}` : cityQuery}
            onChange={e => { setCityQuery(e.target.value); setSelectedCity(null); }}
            placeholder={country ? `City in ${country}` : 'Select country first'}
            disabled={!country}
            className="h-9 w-full rounded-lg border border-border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          {searching && <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">…</div>}
          {cityResults.length > 0 && !selectedCity && (
            <div className="absolute z-50 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-border bg-card shadow-xl">
              {cityResults.map((c, i) => (
                <button
                  key={i}
                  onClick={() => { setSelectedCity(c); setCityResults([]); setCityQuery(''); }}
                  className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted/50 border-b border-border/50 last:border-0"
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-1 text-muted-foreground">{c.country}</span>
                  {c.population && <span className="ml-1 text-[10px] text-muted-foreground">({fmtCompact(c.population)})</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {selectedCity && (
        <div className="mt-2 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            ✅ {selectedCity.name}, {selectedCity.country}
            {selectedCity.population && <span className="ml-1">({fmtCompact(selectedCity.population)})</span>}
          </div>
          <button
            onClick={() => onScan(selectedCity)}
            className="rounded-md px-3 py-1 text-xs font-semibold text-white transition-colors"
            style={{ background: color }}
          >
            Scan
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Compare View ──────────────────────────────────────────────────

interface CityData {
  city: CityResult;
  businesses: Map<string, Business[]>;
  opportunities: OpportunityResult[];
  totalBiz: number;
}

export default function CompareView() {
  const [cityA, setCityA] = useState<CityData | null>(null);
  const [cityB, setCityB] = useState<CityData | null>(null);
  const [scanning, setScanning] = useState<'a' | 'b' | null>(null);
  const [progress, setProgress] = useState(0);
  const [loadingStage, setLoadingStage] = useState('');
  const [error, setError] = useState('');
  const [aiInsight, setAiInsight] = useState('');
  const mapRef = useRef<HTMLDivElement>(null);
  const mapRefB = useRef<HTMLDivElement>(null);
  const mapARef = useRef<any>(null);
  const mapBRef = useRef<any>(null);

  const scanCity = useCallback(async (city: CityResult, which: 'a' | 'b') => {
    setScanning(which);
    setProgress(0);
    setError('');

    try {
      const biz = await queryBusinesses(city.lat, city.lon, 10000, (pct, msg) => {
        setProgress(pct);
        setLoadingStage(msg);
      });
      setProgress(70);

      const totalBiz = Array.from(biz.values()).reduce((s, a) => s + a.length, 0);
      const opps = computeOpportunities(biz, city.population || 500000, new Map());
      setProgress(100);

      // AI comparison analysis when both cities scanned
      if (cityA && which === 'b') {
        try {
          const aiText = await analyzeComparison(
            cityA.city.name, city.name,
            cityA.opportunities, opps,
            cityA.city.population || 500000, city.population || 500000,
            cityA.totalBiz, totalBiz
          );
          setAiInsight(aiText);
        } catch { /* AI unavailable */ }
      } else if (cityB && which === 'a') {
        try {
          const aiText = await analyzeComparison(
            city.name, cityB.city.name,
            opps, cityB.opportunities,
            city.population || 500000, cityB.city.population || 500000,
            totalBiz, cityB.totalBiz
          );
          setAiInsight(aiText);
        } catch { /* AI unavailable */ }
      }

      const data: CityData = { city, businesses: biz, opportunities: opps, totalBiz };
      if (which === 'a') setCityA(data);
      else setCityB(data);
    } catch (e: any) {
      setError(e.message || 'Scan failed');
    } finally {
      setScanning(null);
      setLoadingStage('');
    }
  }, []);

  // Initialize maps when cities are set
  useEffect(() => {
    if (cityA && mapRef.current) {
      if (mapARef.current) {
        const map = mapARef.current;
        map.flyTo({ center: [cityA.city.lon, cityA.city.lat], zoom: 12, duration: 1500 });
        requestAnimationFrame(() => { map.resize(); });
        setTimeout(() => {
          map.resize();
          import('maplibre-gl').then((maplibregl) => addCompareMarkers(map, cityA.businesses, maplibregl));
        }, 500);
        return;
      }
      import('maplibre-gl').then((maplibregl) => {
        if (!mapRef.current) return;
        const map = new maplibregl.Map({
          container: mapRef.current!,
          style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
          center: [cityA.city.lon, cityA.city.lat],
          zoom: 12,
        });
        map.addControl(new maplibregl.NavigationControl());
        mapARef.current = map;
        map.on('load', () => { map.resize(); addCompareMarkers(map, cityA.businesses, maplibregl); });
      });
    }
  }, [cityA]);

  useEffect(() => {
    if (cityB && mapRefB.current) {
      if (mapBRef.current) {
        const map = mapBRef.current;
        map.flyTo({ center: [cityB.city.lon, cityB.city.lat], zoom: 12, duration: 1500 });
        requestAnimationFrame(() => { map.resize(); });
        setTimeout(() => {
          map.resize();
          import('maplibre-gl').then((maplibregl) => addCompareMarkers(map, cityB.businesses, maplibregl));
        }, 500);
        return;
      }
      import('maplibre-gl').then((maplibregl) => {
        if (!mapRefB.current) return;
        const map = new maplibregl.Map({
          container: mapRefB.current!,
          style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
          center: [cityB.city.lon, cityB.city.lat],
          zoom: 12,
        });
        map.addControl(new maplibregl.NavigationControl());
        mapBRef.current = map;
        map.on('load', () => { map.resize(); addCompareMarkers(map, cityB.businesses, maplibregl); });
      });
    }
  }, [cityB]);

  function addCompareMarkers(map: any, businesses: Map<string, Business[]>, maplibregl: any) {
    const allBiz: Business[] = [];
    businesses.forEach(bizs => allBiz.push(...bizs));
    if (allBiz.length === 0) return;
    const markers = allBiz.length > 300 ? allBiz.slice(0, 300) : allBiz;

    markers.forEach(b => {
      const el = document.createElement('div');
      el.style.cssText = `width:7px;height:7px;border-radius:50%;background:#60a5fa;border:1.5px solid rgba(255,255,255,0.8);cursor:pointer;`;
      el.title = b.name || b.categoryLabel;
      new maplibregl.Marker({ element: el })
        .setLngLat([b.lon, b.lat])
        .addTo(map);
    });
  }

  // Comparison metrics
  const topCategories = (() => {
    if (!cityA || !cityB) return [];
    const allCats = new Set([...cityA.opportunities.map(o => o.category), ...cityB.opportunities.map(o => o.category)]);
    const rows: Array<{
      category: string;
      label: string;
      existA: number;
      existB: number;
      per10kA: number;
      per10kB: number;
      scoreA: number;
      scoreB: number;
      winner: 'a' | 'b' | 'tie';
    }> = [];

    for (const cat of allCats) {
      const oppA = cityA.opportunities.find(o => o.category === cat);
      const oppB = cityB.opportunities.find(o => o.category === cat);
      const existA = oppA?.existing || 0;
      const existB = oppB?.existing || 0;
      const per10kA = oppA?.per10k || 0;
      const per10kB = oppB?.per10k || 0;
      const scoreA = oppA?.score || 0;
      const scoreB = oppB?.score || 0;
      // More opportunity = higher score = better city to invest
      const winner = scoreA > scoreB ? 'a' : scoreB > scoreA ? 'b' : 'tie';

      rows.push({
        category: cat,
        label: getCategoryLabel(cat),
        existA,
        existB,
        per10kA,
        per10kB,
        scoreA,
        scoreB,
        winner,
      });
    }

    rows.sort((a, b) => Math.abs(b.scoreA - b.scoreB) - Math.abs(a.scoreA - a.scoreB));
    return rows;
  })();

  // Overall winner
  const overallWinner = (() => {
    if (!cityA || !cityB) return null;
    const avgA = cityA.opportunities.reduce((s, o) => s + o.score, 0) / Math.max(cityA.opportunities.length, 1);
    const avgB = cityB.opportunities.reduce((s, o) => s + o.score, 0) / Math.max(cityB.opportunities.length, 1);
    return avgA > avgB ? 'a' : avgB > avgA ? 'b' : 'tie';
  })();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      {/* City Selectors */}
      <div className="grid gap-4 md:grid-cols-2">
        <CityPanel label="City A" color="#6366f1" onScan={(c) => scanCity(c, 'a')} />
        <CityPanel label="City B" color="#f59e0b" onScan={(c) => scanCity(c, 'b')} />
      </div>

      {/* Progress */}
      {scanning && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{loadingStage || `Scanning ${scanning === 'a' ? cityA?.city.name : cityB?.city.name}…`}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={() => setError('')}
            className="shrink-0 rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Results */}
      {cityA && cityB && topCategories.length > 0 && (
        <>
          {/* Overall Winner */}
          <div className="rounded-xl border border-border bg-card p-5 text-center">
            <div className="text-sm text-muted-foreground mb-2">Overall Market Opportunity Winner</div>
            <div className="text-2xl font-extrabold" style={{ color: overallWinner === 'a' ? '#6366f1' : overallWinner === 'b' ? '#f59e0b' : '#94a3b8' }}>
              {overallWinner === 'a' ? cityA.city.name : overallWinner === 'b' ? cityB.city.name : 'Tie'}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Based on average opportunity scores across {topCategories.length} categories
            </div>
          </div>

          {/* Maps side by side */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                <span className="text-xs font-semibold">{cityA.city.name} · {fmtNum(cityA.totalBiz)} businesses</span>
              </div>
              <div ref={mapRef} className="h-[300px] w-full" />
            </div>
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <span className="text-xs font-semibold">{cityB.city.name} · {fmtNum(cityB.totalBiz)} businesses</span>
              </div>
              <div ref={mapRefB} className="h-[300px] w-full" />
            </div>
          </div>

          {/* Quick Stats */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                <span className="text-sm font-bold text-indigo-400">{cityA.city.name}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-xl font-bold">{fmtNum(cityA.totalBiz)}</div>
                  <div className="text-[10px] text-muted-foreground">Businesses</div>
                </div>
                <div>
                  <div className="text-xl font-bold">{fmtCompact(cityA.city.population || 0)}</div>
                  <div className="text-[10px] text-muted-foreground">Population</div>
                </div>
                <div>
                  <div className="text-xl font-bold">{cityA.opportunities.length}</div>
                  <div className="text-[10px] text-muted-foreground">Categories</div>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <span className="text-sm font-bold text-amber-400">{cityB.city.name}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-xl font-bold">{fmtNum(cityB.totalBiz)}</div>
                  <div className="text-[10px] text-muted-foreground">Businesses</div>
                </div>
                <div>
                  <div className="text-xl font-bold">{fmtCompact(cityB.city.population || 0)}</div>
                  <div className="text-[10px] text-muted-foreground">Population</div>
                </div>
                <div>
                  <div className="text-xl font-bold">{cityB.opportunities.length}</div>
                  <div className="text-[10px] text-muted-foreground">Categories</div>
                </div>
              </div>
            </div>
          </div>

          {/* AI Comparison Insights */}
          {aiInsight && (
            <div className="bg-gradient-to-br from-purple-900/40 to-blue-900/40 border border-purple-500/30 rounded-xl p-5">
              <h4 className="text-sm font-semibold text-purple-300 mb-2">🤖 AI Comparison Analysis</h4>
              <p className="text-sm text-gray-300 whitespace-pre-line">{aiInsight}</p>
            </div>
          )}

          {/* Comparison Table */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-sm font-bold">Category Comparison · {topCategories.length} categories</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Higher opportunity score = bigger gap to fill = better investment chance</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    <th className="px-4 py-2.5 font-medium text-center" style={{ color: '#6366f1' }}>{cityA.city.name}</th>
                    <th className="px-4 py-2.5 font-medium text-center" style={{ color: '#f59e0b' }}>{cityB.city.name}</th>
                    <th className="px-4 py-2.5 font-medium text-center">Gap</th>
                    <th className="px-4 py-2.5 font-medium text-center">Winner</th>
                  </tr>
                </thead>
                <tbody>
                  {topCategories.map(row => (
                    <tr key={row.category} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-xs">{row.label}</td>
                      <td className="px-4 py-2.5 text-center">
                        <div className="text-xs font-bold" style={{ color: row.scoreA >= row.scoreB ? '#6366f1' : '#94a3b8' }}>
                          {row.existA} <span className="text-muted-foreground font-normal">({row.per10kA}/10k)</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">Score: {row.scoreA}</div>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <div className="text-xs font-bold" style={{ color: row.scoreB >= row.scoreA ? '#f59e0b' : '#94a3b8' }}>
                          {row.existB} <span className="text-muted-foreground font-normal">({row.per10kB}/10k)</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">Score: {row.scoreB}</div>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-xs font-bold ${row.scoreA > row.scoreB ? 'text-emerald-400' : row.scoreB > row.scoreA ? 'text-rose-400' : 'text-muted-foreground'}`}>
                          {row.scoreA > row.scoreB ? `+${row.scoreA - row.scoreB}` : row.scoreB > row.scoreA ? `+${row.scoreB - row.scoreA}` : 'Tie'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span
                          className="inline-block w-6 h-6 rounded-full text-white text-[10px] font-bold leading-6"
                          style={{
                            background: row.winner === 'a' ? '#6366f1' : row.winner === 'b' ? '#f59e0b' : '#64748b',
                          }}
                        >
                          {row.winner === 'a' ? 'A' : row.winner === 'b' ? 'B' : '='}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Top Opportunities per City */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-indigo-500/20 bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border">
                <span className="text-xs font-bold text-indigo-400">🏆 Top Opportunities in {cityA.city.name}</span>
              </div>
              <div className="divide-y divide-border/50">
                {cityA.opportunities.slice(0, 10).map((opp, i) => (
                  <div key={opp.category} className="px-4 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                      <span className="text-xs font-medium">{opp.categoryLabel}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{opp.existing} existing</span>
                      <span className={`text-xs font-bold ${opp.score >= 70 ? 'text-emerald-400' : opp.score >= 50 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {opp.score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border">
                <span className="text-xs font-bold text-amber-400">🏆 Top Opportunities in {cityB.city.name}</span>
              </div>
              <div className="divide-y divide-border/50">
                {cityB.opportunities.slice(0, 10).map((opp, i) => (
                  <div key={opp.category} className="px-4 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                      <span className="text-xs font-medium">{opp.categoryLabel}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{opp.existing} existing</span>
                      <span className={`text-xs font-bold ${opp.score >= 70 ? 'text-emerald-400' : opp.score >= 50 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {opp.score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {!cityA && !cityB && (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🏙️</div>
          <div className="text-lg font-bold mb-1">Compare Two Cities</div>
          <div className="text-sm text-muted-foreground">Select and scan two cities above to compare their business landscapes side by side</div>
        </div>
      )}
      {(cityA || cityB) && !(cityA && cityB) && (
        <div className="text-center py-8">
          <div className="text-sm text-muted-foreground">
            {cityA ? `✅ ${cityA.city.name} scanned — now select and scan City B` : `✅ ${cityB?.city.name} scanned — now select and scan City A`}
          </div>
        </div>
      )}
    </div>
  );
}
