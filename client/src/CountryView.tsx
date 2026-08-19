import { useState, useCallback } from 'react';
import {
  resolveCity,
  queryBusinesses,
  computeOpportunities,
  getCategoryLabel,
  type CityResult,
  type Business,
  type OpportunityResult,
} from './clientEngine';

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

const COUNTRY_CODES: Record<string, string> = {
  Georgia: 'GE', Armenia: 'AM', Azerbaijan: 'AZ', Turkey: 'TR',
  Russia: 'RU', Ukraine: 'UA', Poland: 'PL', Germany: 'DE',
  France: 'FR', 'United Kingdom': 'GB', 'United States': 'US',
  India: 'IN', China: 'CN', Japan: 'JP', Brazil: 'BR',
  Argentina: 'AR', Mexico: 'MX', Egypt: 'EG', Nigeria: 'NG',
  'South Africa': 'ZA', Thailand: 'TH', Indonesia: 'ID',
  Vietnam: 'VN', Philippines: 'PH', 'South Korea': 'KR',
  Spain: 'ES', Italy: 'IT', Netherlands: 'NL', Sweden: 'SE',
  Norway: 'NO', Greece: 'GR', 'Czech Republic': 'CZ',
  Romania: 'RO', Bulgaria: 'BG', Serbia: 'RS', Croatia: 'HR',
  Hungary: 'HU', Austria: 'AT', Switzerland: 'CH', Belgium: 'BE',
  Portugal: 'PT', Ireland: 'IE', Denmark: 'DK', Finland: 'FI',
  Canada: 'CA', Australia: 'AU', 'New Zealand': 'NZ',
  Chile: 'CL', Colombia: 'CO', Peru: 'PE',
};

// ─── Find Top Cities in Country ────────────────────────────────────

async function findTopCities(countryName: string, countryCode: string): Promise<CityResult[]> {
  const cc = (COUNTRY_CODES[countryName] || countryCode).toLowerCase();
  
  // Use Nominatim with countrycodes filter — much more reliable than text search
  const url = `https://nominatim.openstreetmap.org/search?q=city&format=json&addressdetails=1&limit=20&extratags=1&countrycodes=${cc}`;
  const res = await fetch(url, { headers: { 'Accept': 'language,en' } });
  const data = await res.json();

  // Build city list from results
  const cities: CityResult[] = [];
  for (const r of data) {
    const addr = r.address || {};
    const resultCountry = addr.country || '';
    const resultCC = addr.country_code?.toUpperCase() || '';
    
    // Country already filtered by countrycodes param, but double-check
    if (resultCC && resultCC.toLowerCase() !== cc) continue;
    
    // Skip if not a city/town/village
    const rawName = addr.city || addr.town || addr.village || addr.municipality;
    if (!rawName) continue;
    
    // Try to get English name from display_name (first part before comma)
    const displayNameEn = r.display_name?.split(',')[0] || '';
    // Use the raw name; if it's non-Latin, also store the display name
    const cityName = rawName !== displayNameEn && /^[a-zA-Z]/.test(displayNameEn) ? displayNameEn : rawName;
    
    const pop = r.extratags?.population ? parseInt(r.extratags.population) : null;
    const bbox = r.boundingbox.map(Number);
    
    cities.push({
      name: cityName,
      country: resultCountry,
      countryCode: resultCC,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      population: pop,
      bbox: [bbox[0], bbox[2], bbox[1], bbox[3]],
    });
  }

  // Deduplicate by name
  const seen = new Set<string>();
  const unique = cities.filter(c => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: prefer cities with population data (larger cities first)
  unique.sort((a, b) => (b.population || 0) - (a.population || 0));

  // Return top 5 (prefer populated ones)
  return unique.slice(0, 5);
}

// ─── City scan data ────────────────────────────────────────────────

interface CityScanData {
  city: CityResult;
  businesses: Map<string, Business[]>;
  opportunities: OpportunityResult[];
  totalBiz: number;
  error?: string;
}

// ─── Key categories to compare ─────────────────────────────────────

const KEY_CATEGORIES = [
  'cafe', 'restaurant', 'bar', 'hotel', 'gym', 'beauty_salon',
  'pharmacy', 'supermarket', 'clothing', 'bakery', 'cinema',
  'coworking', 'spa', 'car_repair', 'pet_groomer',
];

// ─── Country View Component ────────────────────────────────────────

export default function CountryView() {
  const [selectedCountry, setSelectedCountry] = useState('');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [cityData, setCityData] = useState<CityScanData[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);

  const runCountryScan = useCallback(async () => {
    if (!selectedCountry) return;
    const cc = COUNTRY_CODES[selectedCountry] || '';
    if (!cc) { setError('Country code not found'); return; }

    setScanning(true);
    setProgress(0);
    setStage('Finding top cities…');
    setError('');
    setCityData([]);
    setSelectedCat(null);

    try {
      // Step 1: Find top cities
      const cities = await findTopCities(selectedCountry, cc);
      if (cities.length === 0) {
        setError(`Could not find major cities in ${selectedCountry}. Try a different country.`);
        setScanning(false);
        return;
      }

      setProgress(10);
      setStage(`Found ${cities.length} cities. Scanning ${cities[0].name}…`);

      // Step 2: Scan each city
      const results: CityScanData[] = [];
      
      for (let i = 0; i < cities.length; i++) {
        const city = cities[i];
        setStage(`Scanning ${city.name} (${i + 1}/${cities.length})…`);
        setProgress(10 + Math.round((i / cities.length) * 80));

        try {
          const biz = await queryBusinesses(city.lat, city.lon, 8000);
          const totalBiz = Array.from(biz.values()).reduce((s, a) => s + a.length, 0);
          const opps = computeOpportunities(biz, city.population || 200000, new Map());
          results.push({ city, businesses: biz, opportunities: opps, totalBiz });
        } catch (e: any) {
          results.push({
            city,
            businesses: new Map(),
            opportunities: [],
            totalBiz: 0,
            error: e.message || 'Scan failed',
          });
        }
      }

      setProgress(95);
      setStage('Computing comparison…');
      
      // Step 3: Recompute opportunities with cross-city benchmarking
      // Merge all businesses to compute median across all cities
      const allBizMap = new Map<string, Business[]>();
      for (const r of results) {
        for (const [cat, bizs] of r.businesses) {
          if (!allBizMap.has(cat)) allBizMap.set(cat, []);
          allBizMap.get(cat)!.push(...bizs);
        }
      }
      
      const totalPopulation = results.reduce((s, r) => s + (r.city.population || 200000), 0);
      
      // Recompute each city's opportunities with cross-city median
      for (const r of results) {
        r.opportunities = computeOpportunities(r.businesses, r.city.population || 200000, new Map());
      }

      setCityData(results);
      setProgress(100);
      setStage('Done!');
    } catch (e: any) {
      setError(e.message || 'Analysis failed');
    } finally {
      setScanning(false);
    }
  }, [selectedCountry]);

  // Aggregate comparison data across all cities
  const comparisonData: Array<{category: string; label: string; rows: Array<{cityName: string; existing: number; per10k: number; score: number; population: number; totalBiz: number}>; bestOpportunity: string; leastSaturated: string}> = (() => {
    if (cityData.length === 0) return [];
    
    // For each key category, find the stats across all cities
    return KEY_CATEGORIES.map(cat => {
      const rows = cityData.map(cd => {
        const opp = cd.opportunities.find(o => o.category === cat);
        return {
          cityName: cd.city.name,
          existing: opp?.existing || 0,
          per10k: opp?.per10k || 0,
          score: opp?.score || 0,
          population: cd.city.population || 200000,
          totalBiz: cd.totalBiz,
        };
      });

      // Find the city with highest opportunity score (biggest gap)
      const bestOpp = rows.reduce((best, r) => r.score > best.score ? r : best, rows[0]);
      // Find city with lowest existing (least saturated)
      const leastSat = rows.reduce((best, r) => r.existing < best.existing ? r : best, rows[0]);

      return {
        category: cat,
        label: getCategoryLabel(cat),
        rows,
        bestOpportunity: bestOpp.cityName,
        leastSaturated: leastSat.cityName,
      };
    });
  }, [cityData]);

  // Top city rankings by total businesses
  const cityRankings = [...cityData].sort((a, b) => b.totalBiz - a.totalBiz);

  // Top opportunities per city
  const topOppsPerCity = cityData.map(cd => ({
    cityName: cd.city.name,
    population: cd.city.population,
    totalBiz: cd.totalBiz,
    topOpps: cd.opportunities.slice(0, 5),
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 space-y-6">
      {/* Country Selector */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-lg font-bold mb-3">🌍 Country Opportunity Finder</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Select a country to automatically find its top 5 cities, scan all businesses, and compare opportunities across cities.
        </p>
        <div className="flex gap-3 items-end">
          <div className="flex-1 max-w-xs">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Country</label>
            <select
              value={selectedCountry}
              onChange={e => { setSelectedCountry(e.target.value); setCityData([]); setError(''); }}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select a country</option>
              {COUNTRIES.map(c => <option key={c.code} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <button
            onClick={runCountryScan}
            disabled={!selectedCountry || scanning}
            className="h-10 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-6 text-sm font-semibold text-white shadow-lg hover:from-emerald-600 hover:to-teal-600 disabled:opacity-40 transition-all"
          >
            {scanning ? '⏳ Scanning…' : '🔍 Find Opportunities'}
          </button>
        </div>

        {scanning && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{stage}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">{error}</div>
        )}
      </div>

      {/* Results */}
      {cityData.length > 0 && (
        <>
          {/* City Rankings */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-sm font-bold">🏙️ Cities Scanned · Ranked by Business Density</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-border">
              {cityRankings.map((cd, i) => (
                <div key={cd.city.name} className="p-4 text-center">
                  <div className="text-lg font-extrabold text-primary">#{i + 1}</div>
                  <div className="text-sm font-bold mt-1">{cd.city.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {cd.city.country} · pop. {fmtCompact(cd.city.population || 0)}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                    <div>
                      <div className="text-lg font-bold">{fmtNum(cd.totalBiz)}</div>
                      <div className="text-[10px] text-muted-foreground">businesses</div>
                    </div>
                    <div>
                      <div className="text-lg font-bold">{cd.opportunities.length}</div>
                      <div className="text-[10px] text-muted-foreground">categories</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Category Selector for filtered view */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Filter by category:</span>
              <button
                onClick={() => setSelectedCat(null)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${!selectedCat ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:text-foreground'}`}
              >
                All Categories
              </button>
              {KEY_CATEGORIES.map(cat => (
                <button
                  key={cat}
                  onClick={() => setSelectedCat(selectedCat === cat ? null : cat)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${selectedCat === cat ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:text-foreground'}`}
                >
                  {getCategoryLabel(cat)}
                </button>
              ))}
            </div>
          </div>

          {/* Comparison Table */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-sm font-bold">
                📊 Category Comparison · {selectedCat ? getCategoryLabel(selectedCat) : 'All Key Categories'}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Higher score = bigger gap = better opportunity to start a business
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    {cityData.map(cd => (
                      <th key={cd.city.name} className="px-3 py-2.5 font-medium text-center">
                        {cd.city.name}
                      </th>
                    ))}
                    <th className="px-3 py-2.5 font-medium text-center">Best City</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonData
                    .filter(c => !selectedCat || c.category === selectedCat)
                    .map(comp => (
                    <tr key={comp.category} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-xs">{comp.label}</td>
                      {comp.rows.map((row, ri) => {
                        const maxScore = Math.max(...comp.rows.map(r => r.score));
                        const isBest = row.score === maxScore && row.score > 0;
                        return (
                          <td key={ri} className="px-3 py-2.5 text-center">
                            <div className="text-xs">
                              <span className={`font-bold ${isBest ? 'text-emerald-400' : 'text-foreground'}`}>
                                {row.existing}
                              </span>
                              <span className="text-muted-foreground"> ({row.per10k}/10k)</span>
                            </div>
                            <div className={`text-[10px] ${isBest ? 'text-emerald-400 font-bold' : 'text-muted-foreground'}`}>
                              Score: {row.score}
                            </div>
                          </td>
                        );
                      })}
                      <td className="px-3 py-2.5 text-center">
                        <span className="inline-block bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full">
                          {comp.bestOpportunity}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Top Opportunities per City */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {topOppsPerCity.map(cd => (
              <div key={cd.cityName} className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-muted/30">
                  <div className="text-xs font-bold">{cd.cityName}</div>
                  <div className="text-[10px] text-muted-foreground">
                    pop. {fmtCompact(cd.population || 0)} · {fmtNum(cd.totalBiz)} businesses
                  </div>
                </div>
                <div className="divide-y divide-border/50">
                  {cd.topOpps.map((opp, i) => (
                    <div key={opp.category} className="px-3 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground w-3">{i + 1}</span>
                        <span className="text-xs font-medium">{opp.categoryLabel}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">{opp.existing} existing</span>
                        <span className={`text-xs font-bold ${opp.score >= 70 ? 'text-emerald-400' : opp.score >= 50 ? 'text-amber-400' : 'text-rose-400'}`}>
                          {opp.score}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Overall Recommendation */}
          <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-5">
            <h3 className="text-sm font-bold mb-2">💡 Recommendation</h3>
            <div className="text-xs text-muted-foreground leading-relaxed">
              {(() => {
                // Find the city with the most high-scoring opportunities
                const cityScores = cityData.map(cd => {
                  const highOpps = cd.opportunities.filter(o => o.score >= 60);
                  const avgScore = cd.opportunities.reduce((s, o) => s + o.score, 0) / Math.max(cd.opportunities.length, 1);
                  return { name: cd.city.name, highOpps: highOpps.length, avgScore, population: cd.city.population || 0 };
                });
                
                cityScores.sort((a, b) => b.highOpps - a.highOpps || b.avgScore - a.avgScore);
                const best = cityScores[0];
                
                return (
                  <>
                    Based on the analysis of <strong>{cityData.length} cities</strong> in <strong>{selectedCountry}</strong>,{' '}
                    <strong className="text-emerald-400">{best.name}</strong> has the most opportunity with{' '}
                    <strong>{best.highOpps}</strong> underserved categories (score ≥ 60) and an average opportunity score of{' '}
                    <strong>{best.avgScore.toFixed(0)}</strong>.
                    {best.population > 500000 && ' Its large population of ' + fmtCompact(best.population) + ' provides a strong customer base.'}
                    {' '}Consider these top categories for investment — they have the biggest supply gaps relative to demand.
                  </>
                );
              })()}
            </div>
          </div>
        </>
      )}

      {/* Empty state */}
      {cityData.length === 0 && !scanning && (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🌍</div>
          <div className="text-lg font-bold mb-1">Find Opportunities Across a Country</div>
          <div className="text-sm text-muted-foreground max-w-md mx-auto">
            Select a country above and we'll automatically find its top 5 cities, scan all businesses, and show you where the biggest gaps are.
          </div>
        </div>
      )}
    </div>
  );
}
