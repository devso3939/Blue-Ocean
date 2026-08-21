import { useState, useCallback, useRef, useEffect } from 'react';
import {
  resolveCity,
  queryBusinesses,
  getDemandSignals,
  computeOpportunities,
  getCategoryLabel,
  getGoogleMapsUrl, getAIAnalysis,
  type CityResult,
  type Business,
  type DemandSignal,
  type OpportunityResult,
} from './clientEngine';
import CompareView from './CompareView';
import CountryView from './CountryView';

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'text-muted-foreground';
  if (score >= 80) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-400';
  if (score >= 45) return 'text-orange-400';
  return 'text-rose-400';
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

const POPULAR_CATEGORIES = [
  { id: 'cafe', label: '☕ Cafe' }, { id: 'restaurant', label: '🍽️ Restaurant' },
  { id: 'bar', label: '🍸 Bar' }, { id: 'hotel', label: '🏨 Hotel' },
  { id: 'gym', label: '💪 Gym / Fitness' }, { id: 'beauty_salon', label: '💄 Beauty Salon' },
  { id: 'hair_salon', label: '💇 Hair Salon' }, { id: 'pharmacy', label: '💊 Pharmacy' },
  { id: 'supermarket', label: '🛒 Supermarket' }, { id: 'clothing', label: '👕 Clothing Store' },
  { id: 'electronics', label: '📱 Electronics Store' }, { id: 'bakery', label: '🥐 Bakery' },
  { id: 'bank', label: '🏦 Bank' }, { id: 'school', label: '📚 School' },
  { id: 'cinema', label: '🎬 Cinema' }, { id: 'car_repair', label: '🔧 Car Repair' },
  { id: 'pet_groomer', label: '🐕 Pet Groomer' }, { id: 'coworking', label: '💻 Coworking Space' },
  { id: 'spa', label: '🧖 Spa' }, { id: 'yoga', label: '🧘 Yoga Studio' },
];

const CAT_COLORS: Record<string, string> = {
  cafe: '#f59e0b', restaurant: '#ef4444', bar: '#8b5cf6', pub: '#a855f7',
  hotel: '#3b82f6', gym: '#10b981', beauty_salon: '#ec4899', hair_salon: '#f472b6',
  pharmacy: '#06b6d4', supermarket: '#22c55e', bank: '#6366f1', clothing: '#a855f7',
  electronics: '#64748b', bakery: '#fbbf24', fast_food: '#f97316', school: '#3b82f6',
  cinema: '#e879f9', car_repair: '#f97316', pet_groomer: '#fb923c', coworking: '#38bdf8',
  spa: '#c084fc', yoga: '#34d399',
  bookstore: '#a78bfa', library: '#2dd4bf', post_office: '#fbbf24',
};

const APP_VERSION = '3.3.1';

export default function App() {
  const [viewMode, setViewMode] = useState<'analysis' | 'compare' | 'country'>('analysis');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const [cityResults, setCityResults] = useState<CityResult[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityResult | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [citySearching, setCitySearching] = useState(false);

  const [businesses, setBusinesses] = useState<Map<string, Business[]>>(new Map());
  const [opportunities, setOpportunities] = useState<OpportunityResult[]>([]);
  const [demandSignals, setDemandSignals] = useState<Map<string, DemandSignal>>(new Map());
  const [selectedOppCategory, setSelectedOppCategory] = useState<string | null>(null);
  const [showAllOpps, setShowAllOpps] = useState(false);
  const [aiInsights, setAiInsights] = useState('');

  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const maplibreRef = useRef<any>(null);
  const mapReadyRef = useRef(false);

  // Search cities
  useEffect(() => {
    if (!cityQuery.trim() || cityQuery.length < 2) { setCityResults([]); return; }
    const timer = setTimeout(async () => {
      setCitySearching(true);
      try {
        const searchQ = selectedCountry ? `${cityQuery}, ${selectedCountry}` : cityQuery;
        const results = await resolveCity(searchQ);
        setCityResults(results.slice(0, 8));
      } catch {}
      setCitySearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [cityQuery, selectedCountry]);

  // ─── Map initialization ─────────────────────────────────────────
  // Initialize map when selectedCity changes
  useEffect(() => {
    if (!selectedCity || !mapRef.current) return;
    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo({ center: [selectedCity.lon, selectedCity.lat], zoom: 12, duration: 1500 });
      return;
    }
    import('maplibre-gl').then((maplibregl) => {
      if (!mapRef.current || mapInstanceRef.current) return;
      maplibreRef.current = maplibregl;
      const map = new maplibregl.Map({
        container: mapRef.current,
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        center: [selectedCity.lon, selectedCity.lat],
        zoom: 12,
      });
      map.addControl(new maplibregl.NavigationControl());
      mapInstanceRef.current = map;

      map.on('load', () => {
        mapReadyRef.current = true;
        // Add GeoJSON source for businesses
        map.addSource('businesses', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Circle layer: always visible, colored dots sized by zoom
        map.addLayer({
          id: 'biz-circles',
          type: 'circle',
          source: 'businesses',
          paint: {
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              8, 8,
              12, 12,
              16, 16,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2.5,
            'circle-stroke-color': 'rgba(255,255,255,0.95)',
            'circle-opacity': 0.92,
          },
        });
        // Text label layer: category initial letter on each circle
        map.addLayer({
          id: 'biz-labels',
          type: 'symbol',
          source: 'businesses',
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          },
          paint: {
            'text-color': '#ffffff',
          },
        });
        // Cursor pointer on hover
        map.on('mouseenter', 'biz-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-circles', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'biz-labels', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-labels', () => { map.getCanvas().style.cursor = ''; });
        // Click handler on either layer
        const showPopup = (e: any) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties;
          const coords = f.geometry.coordinates;
          const gmapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((p.name || '') + ' ' + (p.address || ''));
          const osmUrl = 'https://www.openstreetmap.org/?mlat=' + coords[1] + '&mlon=' + coords[0] + '#map=17/' + coords[1] + '/' + coords[0];
          // Build compact contact info
          const info: string[] = [];
          if (p.phone) info.push('<a href="tel:' + p.phone + '" style="color:#93c5fd;text-decoration:none;font-size:10px">📞 ' + String(p.phone).slice(0, 18) + '</a>');
          if (p.email) info.push('<span style="color:#94a3b8;font-size:10px;word-break:break-all">✉️ ' + String(p.email).slice(0, 30) + '</span>');
          if (p.website) info.push('<a href="' + p.website + '" target="_blank" style="color:#93c5fd;text-decoration:none;font-size:10px">🌐 ' + String(p.website).replace(/^https?:\/\//, '').slice(0, 20) + '</a>');
          if (p.address) info.push('<span style="color:#64748b;font-size:9px">📍 ' + String(p.address).slice(0, 40) + '</span>');
          // Social badges
          const socials: string[] = [];
          if (p.facebook) socials.push('<a href="' + p.facebook + '" target="_blank" style="color:#60a5fa;font-size:8px;text-decoration:none;background:rgba(96,165,250,0.12);padding:1px 4px;border-radius:3px">FB</a>');
          if (p.instagram) socials.push('<a href="' + p.instagram + '" target="_blank" style="color:#e879f9;font-size:8px;text-decoration:none;background:rgba(232,121,249,0.12);padding:1px 4px;border-radius:3px">IG</a>');

          const html = '<div style="padding:8px 10px;max-width:220px;font-family:system-ui,sans-serif;line-height:1.3">'
            + '<div style="font-weight:700;font-size:11px;color:#f1f5f9;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (p.name || '') + '</div>'
            + '<div style="display:inline-block;background:' + (p.color || '#64748b') + '25;color:' + (p.color || '#64748b') + ';font-size:8px;padding:1px 5px;border-radius:99px;margin-bottom:4px">' + (p.categoryLabel || '') + '</div>'
            + info.map(s => '<div style="margin:2px 0">' + s + '</div>').join('')
            + (socials.length ? '<div style="display:flex;gap:3px;margin-top:3px">' + socials.join(' ') + '</div>' : '')
            + '<div style="margin-top:5px;padding-top:4px;border-top:1px solid #1e293b;display:flex;gap:3px">'
            + '<a href="' + gmapsUrl + '" target="_blank" style="background:#1a73e8;color:white;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;text-decoration:none">Maps</a>'
            + '<a href="' + osmUrl + '" target="_blank" style="background:#1e293b;color:#94a3b8;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;text-decoration:none">OSM</a>'
            + '</div></div>';
          new maplibregl.Popup({ maxWidth: '240px', offset: 10, closeButton: true, closeOnClick: true })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(map);
        };
        map.on('click', 'biz-circles', showPopup);
        map.on('click', 'biz-labels', showPopup);
        // If businesses already exist, render them        });
        // If businesses already exist, render them
        if (businesses.size > 0) {
          updateMapData(map, businesses);
        }
      });
    });
  }, [selectedCity, opportunities.length]);

  // Update map data whenever businesses change
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    updateMapData(mapInstanceRef.current, businesses);
  }, [businesses]);

  function updateMapData(map: any, biz: Map<string, Business[]>) {
    const allBiz: Business[] = [];
    biz.forEach(bizs => allBiz.push(...bizs));
    if (allBiz.length === 0) return;

    const CAT_EMOJI: Record<string, string> = {
      cafe: '☕', restaurant: '🍽️', bar: '🍸', pub: '🍺', fast_food: '🍔',
      hotel: '🏨', gym: '💪', beauty_salon: '💄', hair_salon: '💇',
      pharmacy: '💊', supermarket: '🛒', bank: '🏦', clothing: '👗',
      electronics: '📱', bakery: '🥐', cinema: '🎬', car_repair: '🔧',
      pet_groomer: '🐕', coworking: '💻', spa: '🧖', school: '📚',
      clinic: '🏥', hospital: '🏥', dentistry: '🦷', post_office: '📮',
      library: '📖', nightclub: '🎶', car_rental: '🚗', veterinary: '🐾',
      florist: '🌸', optician: '👓', butcher: '🥩', ice_cream: '🍦',
      grocery: '🥬', convenience: '🏪', department_store: '🏬',
      jewelry: '💎', sports: '⚽', books: '📖', fuel: '⛽',
      art: '🎨', bicycle: '🚲', marketplace: '🏪',
    };

    const features = allBiz.slice(0, 500).map(b => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [b.lon, b.lat] },
      properties: {
        name: b.name,
        category: b.category,
        categoryLabel: b.categoryLabel,
        color: (CAT_COLORS as Record<string,string>)[b.category] || '#64748b',
        emoji: (CAT_EMOJI as Record<string,string>)[b.category] || '📍',
        label: (b.categoryLabel || b.name || '•').charAt(0).toUpperCase(),
        phone: b.phone || '',
        email: b.email || '',
        website: b.website || '',
        address: b.address || '',
        facebook: b.facebook || '',
        instagram: b.instagram || '',
      },
    }));

    const geojson = { type: 'FeatureCollection' as const, features };
    const source = map.getSource('businesses');
    if (source) {
      source.setData(geojson);
    }

    // Fit bounds to all markers
    if (allBiz.length > 1) {
      const bounds = new (maplibreRef.current as any).LngLatBounds();
      allBiz.forEach(b => bounds.extend([b.lon, b.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1200 });
    }
  }

  // Discover all opportunities
  const runAnalysis = useCallback(async () => {
    if (!selectedCity) return;
    setLoading(true);
    setError('');
    setBusinesses(new Map());
    setOpportunities([]);
    setDemandSignals(new Map());
    setSelectedOppCategory(null);
    setShowAllOpps(false);

    try {
      const biz = await queryBusinesses(
        selectedCity.lat, selectedCity.lon, 10000,
        (pct, msg) => { setProgress(pct); setLoadingStage(msg); }
      );
      setBusinesses(biz);
      setProgress(40);

      if (biz.size === 0) {
        setError('No businesses found — OpenStreetMap servers may be busy. Click Retry to try again.');
        setLoading(false);
        return;
      }

      setLoadingStage('Analyzing demand signals…');
      const topCats = Array.from(biz.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6)
        .map(([cat]) => cat);

      const signals = new Map<string, DemandSignal>();
      const demResults = await Promise.all(
        topCats.map(cat => getDemandSignals(getCategoryLabel(cat), selectedCity!.name))
      );
      topCats.forEach((cat, i) => signals.set(cat, demResults[i]));
      setDemandSignals(signals);
      setProgress(80);

      setLoadingStage('Computing opportunity scores…');
      const opps = computeOpportunities(biz, selectedCity.population || 500000, signals);
      setOpportunities(opps);
      setProgress(90);

      setLoadingStage('AI analyzing opportunities…');
      try {
        const topOpps = opps.slice(0, 8).map(o => ({
          category: o.category, label: o.categoryLabel,
          existing: o.existing, gap: o.gap, score: o.score,
        }));
        const aiResult = await getAIAnalysis(selectedCity.name, selectedCity.country, topOpps, selectedCity.population || 500000);
        setAiInsights(aiResult);
      } catch {}
      setProgress(100);
    } catch (e: any) {
      setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
      setLoadingStage('');
    }
  }, [selectedCity]);

  // Analyze single industry
  const startAnalyze = useCallback(async () => {
    if (!selectedCity || !selectedCategory) return;
    setLoading(true);
    setError('');
    setBusinesses(new Map());
    setOpportunities([]);
    setDemandSignals(new Map());

    try {
      setLoadingStage(`Scanning ${getCategoryLabel(selectedCategory)}…`);
      setProgress(5);

      const biz = await queryBusinesses(
        selectedCity.lat, selectedCity.lon, 10000,
        (pct, msg) => { setProgress(Math.max(pct, 5)); setLoadingStage(msg); },
        selectedCategory
      );
      setBusinesses(biz);
      setProgress(45);

      if (biz.size === 0) {
        setError('No businesses found — OpenStreetMap servers may be busy. Click Retry to try again.');
        setLoading(false);
        return;
      }

      setLoadingStage('Analyzing demand signals…');
      setProgress(55);
      const sig = await getDemandSignals(getCategoryLabel(selectedCategory), selectedCity.name);
      const signals = new Map<string, DemandSignal>();
      signals.set(selectedCategory, sig);
      setDemandSignals(signals);
      setProgress(80);

      setLoadingStage('Computing opportunity scores…');
      const opps = computeOpportunities(biz, selectedCity.population || 500000, signals);
      setOpportunities(opps);
      setSelectedOppCategory(selectedCategory);
      setProgress(100);
    } catch (e: any) {
      setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
      setLoadingStage('');
    }
  }, [selectedCity, selectedCategory]);

  const allBizCount = Array.from(businesses.values()).reduce((s, a) => s + a.length, 0);
  const displayOpps = showAllOpps ? opportunities : opportunities.slice(0, 25);
  const selectedCatInfo = selectedOppCategory ? demandSignals.get(selectedOppCategory) : null;
  const selectedOpp = selectedOppCategory ? opportunities.find(o => o.category === selectedOppCategory) : null;

  // Businesses for the selected category
  const categoryBusinesses = selectedOppCategory ? (businesses.get(selectedOppCategory) || []) : [];
  const [bizSearch, setBizSearch] = useState('');
  const [sortCol, setSortCol] = useState<string>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const filteredBiz = categoryBusinesses
    .filter(b =>
      !bizSearch || b.name.toLowerCase().includes(bizSearch.toLowerCase()) ||
      b.address.toLowerCase().includes(bizSearch.toLowerCase()) ||
      b.cuisine.toLowerCase().includes(bizSearch.toLowerCase()) ||
      b.brand.toLowerCase().includes(bizSearch.toLowerCase())
    )
    .sort((a, b) => {
      let av: any, bv: any;
      switch (sortCol) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'cuisine': av = a.cuisine.toLowerCase(); bv = b.cuisine.toLowerCase(); break;
        case 'address': av = a.address.toLowerCase(); bv = b.address.toLowerCase(); break;
        case 'phone': av = a.phone; bv = b.phone; break;
        case 'website': av = a.website; bv = b.website; break;
        default: av = a.name.toLowerCase(); bv = b.name.toLowerCase();
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const sortArrow = (col: string) => {
    if (sortCol !== col) return <span className="ml-1 text-muted-foreground/40">↕</span>;
    return <span className="ml-1 text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  // CSV download function
  const downloadCSV = useCallback(() => {
    if (filteredBiz.length === 0) return;
    const catLabel = getCategoryLabel(selectedOppCategory || '');
    const cityName = selectedCity?.name || 'city';
    
    const headers = ['#', 'Business Name', 'Category', 'Address', 'Phone', 'Email', 'Website', 'Facebook', 'Instagram', 'Latitude', 'Longitude', 'Google Maps Link'];
    const rows = filteredBiz.map((b, i) => {
      const gmapsUrl = getGoogleMapsUrl(b);
      return [
        i + 1,
        b.name || 'Unnamed',
        b.categoryLabel,
        b.address,
        b.phone,
        b.email,
        b.website,
        b.facebook,
        b.instagram,
        b.lat,
        b.lon,
        gmapsUrl,
      ];
    });
    
    const escapeCSV = (val: any) => {
      const str = String(val ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };
    
    const csv = [headers.map(escapeCSV).join(','), ...rows.map(r => r.map(escapeCSV).join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blueocean-${cityName.toLowerCase().replace(/\s+/g, '-')}-${catLabel.toLowerCase().replace(/\s+/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredBiz, selectedOppCategory, selectedCity]);

  if (viewMode === 'compare') {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-500 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <span className="text-sm font-bold">Blue Ocean <span className="text-muted-foreground font-normal">· Compare Cities</span></span>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-xs text-muted-foreground hidden sm:block">OpenStreetMap · Nominatim · Wikipedia</div>
              <button
                onClick={() => setViewMode('analysis')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
              >
                ← Back
              </button>
            </div>
          </div>
        </header>
        <CompareView />
      </div>
    );
  }

  if (viewMode === 'country') {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-500 text-white">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <span className="text-sm font-bold">Blue Ocean <span className="text-muted-foreground font-normal">· Country Finder</span></span>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-xs text-muted-foreground hidden sm:block">OpenStreetMap · Nominatim · Wikipedia</div>
              <button
                onClick={() => setViewMode('analysis')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
              >
                ← Back
              </button>
            </div>
          </div>
        </header>
        <CountryView />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-500 text-white">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </div>
            <span className="text-sm font-bold">Blue Ocean <span className="text-muted-foreground font-normal">· Market Gap Intelligence</span> <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary/60 font-mono">v{APP_VERSION}</span></span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground hidden sm:block">OpenStreetMap · Nominatim · Wikipedia</div>
            <div className="flex gap-1.5">
              {viewMode !== 'analysis' && (
                <button
                  onClick={() => setViewMode('analysis')}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
                >
                  ← Back
                </button>
              )}
              <button
                onClick={() => setViewMode('compare')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
              >
                🏙️ Compare
              </button>
              <button
                onClick={() => setViewMode('country')}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-emerald-500/50 transition-all"
              >
                🌍 Country
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 opacity-30" style={{backgroundImage:'radial-gradient(circle at 50% 0%, hsl(250 80% 70% / 0.15), transparent 60%)'}} />
        <div className="relative mx-auto max-w-3xl px-4 pb-8 pt-12 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            Find What Your City <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">Is Missing</span>.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
            Underserved industries, real business counts, peer-city benchmarks — for cities anywhere in the world.
          </p>
        </div>
      </section>

      {/* Controls */}
      <section className="mx-auto max-w-3xl px-4 pb-8">
        <div className="rounded-xl border border-border bg-card p-5 shadow-lg">
          <div className="grid gap-3 sm:grid-cols-[1fr_1.2fr_1.2fr]">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Country</label>
              <select
                value={selectedCountry}
                onChange={e => { setSelectedCountry(e.target.value); setSelectedCity(null); setCityQuery(''); setCityResults([]); }}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select a country</option>
                {COUNTRIES.map(c => <option key={c.code} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">City</label>
              <div className="relative">
                <input
                  value={selectedCity ? `${selectedCity.name}, ${selectedCity.country}` : cityQuery}
                  onChange={e => { setCityQuery(e.target.value); setSelectedCity(null); }}
                  placeholder={selectedCountry ? `Search cities in ${selectedCountry}…` : 'Select a country first'}
                  disabled={!selectedCountry}
                  className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
                {citySearching && <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">searching…</div>}
                {cityResults.length > 0 && !selectedCity && (
                  <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-border bg-card shadow-xl">
                    {cityResults.map((c, i) => (
                      <button
                        key={i}
                        onClick={() => { setSelectedCity(c); setCityResults([]); }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 border-b border-border/50 last:border-0"
                      >
                        <span className="font-medium">{c.name}</span>
                        <span className="ml-2 text-muted-foreground">{c.country}</span>
                        {c.population && <span className="ml-2 text-xs text-muted-foreground">pop. {fmtCompact(c.population)}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Industry</label>
              <select
                value={selectedCategory}
                onChange={e => setSelectedCategory(e.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select an industry</option>
                {POPULAR_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={startAnalyze}
              disabled={loading || !selectedCity || !selectedCategory}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg hover:from-indigo-600 hover:to-violet-600 disabled:opacity-40 transition-all"
            >
              ⚡ Analyze Industry
            </button>
            <button
              onClick={runAnalysis}
              disabled={loading || !selectedCity}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-6 py-2.5 text-sm font-semibold hover:bg-muted/50 disabled:opacity-40 transition-all"
            >
              🎯 Discover Opportunities
            </button>
          </div>

          {!loading && selectedCity && !selectedCategory && (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              City selected — pick an industry for single-industry analysis, or click <span className="font-medium text-foreground">Discover Opportunities</span> for all categories.
            </p>
          )}

          {loading && (
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>{loadingStage}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500" style={{width: `${progress}%`}} />
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400 flex items-center justify-between gap-3">
              <span>{error}</span>
              <button
                onClick={() => selectedCategory ? startAnalyze() : runAnalysis()}
                className="shrink-0 rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/30 transition-colors"
              >
                🔄 Retry
              </button>
            </div>
          )}
        </div>

        <div className="mx-auto mt-6 flex max-w-3xl flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-muted-foreground">Try:</span>
          {[
            { label: 'Tbilisi · Cafes', city: 'Tbilisi, Georgia', cat: 'cafe' },
            { label: 'Batumi · Beauty Salons', city: 'Batumi, Georgia', cat: 'beauty_salon' },
            { label: 'Yerevan · Gyms', city: 'Yerevan, Armenia', cat: 'gym' },
            { label: 'Baku · Restaurants', city: 'Baku, Azerbaijan', cat: 'restaurant' },
          ].map(ex => (
            <button
              key={ex.label}
              onClick={async () => {
                const countryName = COUNTRIES.find(c => ex.city.endsWith(c.name))?.name || '';
                setSelectedCountry(countryName);
                setSelectedCategory(ex.cat);
                setCityQuery(ex.city);
                try {
                  const results = await resolveCity(ex.city);
                  if (results.length > 0) {
                    setSelectedCity(results[0]);
                    setCityResults([]);
                  }
                } catch {}
              }}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </section>

      {/* Results */}
      {opportunities.length > 0 && selectedCity && (
        <div className="mx-auto max-w-7xl space-y-6 px-4 pb-12">
          {/* Summary */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-4">
              <h2 className="text-lg font-bold">Opportunities in {selectedCity.name}</h2>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>📊 {fmtNum(allBizCount)} businesses</span>
                {selectedCity.population && <span>👥 pop. {fmtCompact(selectedCity.population)}</span>}
                <span>📈 {opportunities.length} categories</span>
              </div>
            </div>
          </div>

          {/* AI Insights */}
          {aiInsights && (
            <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-5">
              <h3 className="text-sm font-bold mb-2">🤖 AI Market Analysis</h3>
              <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
                {aiInsights.split('\n').map((line, i) => (
                  <p key={i} className="mb-2" dangerouslySetInnerHTML={{ __html: line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground">$1</strong>') }} />
                ))}
              </div>
            </div>
          )}

          {/* Map */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {selectedOppCategory
                  ? `${getCategoryLabel(selectedOppCategory)} Map · ${categoryBusinesses.length} locations`
                  : `Competition Map · ${fmtNum(allBizCount)} businesses`}
              </h3>
              <div className="flex gap-2 flex-wrap">
                {selectedOppCategory && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{background: (CAT_COLORS[selectedOppCategory] || '#94a3b8') + '22', color: CAT_COLORS[selectedOppCategory] || '#94a3b8'}}>
                    {getCategoryLabel(selectedOppCategory)}
                  </span>
                )}
              </div>
            </div>
            <div ref={mapRef} className="h-[500px] w-full map-container" />
          </div>

          {/* Selected category detail */}
          {selectedOppCategory && selectedOpp && selectedCatInfo && (
            <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold">📊 {selectedOpp.categoryLabel} — Deep Analysis</h3>
                <button onClick={() => setSelectedOppCategory(null)} className="text-xs text-muted-foreground hover:text-foreground">✕ Close</button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Existing</div>
                  <div className="text-2xl font-bold">{fmtNum(selectedOpp.existing)}</div>
                  <div className="text-xs text-muted-foreground">businesses</div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Per 10k residents</div>
                  <div className="text-2xl font-bold">{selectedOpp.per10k}</div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Expected (peer benchmark)</div>
                  <div className="text-2xl font-bold">{fmtNum(selectedOpp.expected)}</div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Supply Gap</div>
                  <div className={`text-2xl font-bold ${selectedOpp.gap > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {selectedOpp.gap > 0 ? '+' : ''}{fmtNum(selectedOpp.gap)}
                  </div>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg bg-emerald-500/20 p-3">
                  <div className="text-xs text-emerald-400/80">Opportunity Score</div>
                  <div className={`text-3xl font-extrabold ${scoreColor(selectedOpp.score)}`}>{selectedOpp.score}/100</div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Web Presence</div>
                  <div className="text-2xl font-bold">{selectedCatInfo.webSearch}<span className="text-xs text-muted-foreground">/100</span></div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Wikipedia Interest</div>
                  <div className="text-2xl font-bold">{selectedCatInfo.wikipedia}<span className="text-xs text-muted-foreground">/100</span></div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Reddit Mentions</div>
                  <div className="text-2xl font-bold">{selectedCatInfo.reddit}<span className="text-xs text-muted-foreground">/100</span></div>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{selectedCatInfo.explanation} · Sources: {selectedCatInfo.sources.join(', ') || 'Calculated'} · Demand adds up to 15% to the score.</p>
            </div>
          )}

          {/* Business List — only in single-category mode */}
          {selectedOppCategory && categoryBusinesses.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-4">
                <h3 className="text-sm font-semibold">
                  {getCategoryLabel(selectedOppCategory)} Businesses · {categoryBusinesses.length} found
                </h3>
                <div className="flex items-center gap-2">
                  <input
                    value={bizSearch}
                    onChange={e => setBizSearch(e.target.value)}
                    placeholder="Search businesses…"
                    className="h-8 w-48 rounded-lg border border-border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={downloadCSV}
                    className="h-8 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/20 px-3 text-xs font-medium text-emerald-400 hover:bg-emerald-600/30 transition-colors whitespace-nowrap"
                  >
                    ⬇️ Export CSV
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium w-10">#</th>
                      <th className="px-4 py-2.5 font-medium cursor-pointer hover:text-foreground transition-colors select-none" onClick={() => handleSort('name')}>Business{sortArrow('name')}</th>
                      <th className="px-4 py-2.5 font-medium cursor-pointer hover:text-foreground transition-colors select-none" onClick={() => handleSort('address')}>Address{sortArrow('address')}</th>
                      <th className="px-4 py-2.5 font-medium cursor-pointer hover:text-foreground transition-colors select-none" onClick={() => handleSort('phone')}>Phone{sortArrow('phone')}</th>
                      <th className="px-4 py-2.5 font-medium">Email</th>
                      <th className="px-4 py-2.5 font-medium cursor-pointer hover:text-foreground transition-colors select-none" onClick={() => handleSort('website')}>Website{sortArrow('website')}</th>
                      <th className="px-4 py-2.5 font-medium">Social</th>
                      <th className="px-4 py-2.5 font-medium text-right">Google Maps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBiz.map((b, i) => {
                      const gmapsUrl = getGoogleMapsUrl(b);
                      return (
                        <tr key={b.id} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3 text-xs text-muted-foreground">{i + 1}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-sm">{b.name || <span className="text-muted-foreground italic">Unnamed</span>}</div>
                            {b.brand && <div className="text-xs text-muted-foreground">{b.brand}</div>}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground max-w-[180px] truncate">{b.address || '—'}</td>
                          <td className="px-4 py-3 text-xs">
                            {b.phone ? <a href={`tel:${b.phone}`} className="text-blue-400 hover:underline">{b.phone}</a> : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground max-w-[150px] truncate">{b.email || '—'}</td>
                          <td className="px-4 py-3 text-xs">
                            {b.website ? <a href={b.website} target="_blank" rel="noopener" className="text-blue-400 hover:underline">🌐 Link</a> : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-3 text-xs">
                            <div className="flex flex-col gap-0.5">
                              {b.facebook && <a href={b.facebook} target="_blank" rel="noopener" className="text-blue-400 hover:underline text-[11px]">Facebook</a>}
                              {b.instagram && <a href={b.instagram} target="_blank" rel="noopener" className="text-pink-400 hover:underline text-[11px]">Instagram</a>}
                              {(!b.facebook && !b.instagram) && <span className="text-muted-foreground">—</span>}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <a
                              href={gmapsUrl}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-center gap-1 rounded-md bg-blue-600/20 px-2.5 py-1 text-xs font-medium text-blue-400 hover:bg-blue-600/30 transition-colors"
                            >
                              📍 Google Maps
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredBiz.length === 0 && bizSearch && (
                <div className="py-8 text-center text-sm text-muted-foreground">No businesses match "{bizSearch}"</div>
              )}
              {filteredBiz.length === 0 && !bizSearch && categoryBusinesses.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <div className="text-2xl mb-2">🔍</div>
                  No {getCategoryLabel(selectedOppCategory || '')} businesses found in {selectedCity?.name || 'this city'}.<br/>
                  <span className="text-xs">This could be a Blue Ocean opportunity!</span>
                </div>
              )}
            </div>
          )}

          {/* Opportunity table */}
          <div className="rounded-xl border border-border bg-card">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {selectedCategory ? `${getCategoryLabel(selectedCategory)} Opportunities` : 'All Opportunities'}
                <span className="ml-2 text-muted-foreground font-normal">({opportunities.length} categories)</span>
              </h3>
              {opportunities.length > 25 && (
                <button onClick={() => setShowAllOpps(!showAllOpps)} className="text-xs text-primary hover:underline">
                  {showAllOpps ? 'Show top 25' : `Show all ${opportunities.length}`}
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">#</th>
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    <th className="px-4 py-2.5 font-medium text-right">Existing</th>
                    <th className="px-4 py-2.5 font-medium text-right">Per 10k</th>
                    <th className="px-4 py-2.5 font-medium text-right">Gap</th>
                    <th className="px-4 py-2.5 font-medium text-right">Demand</th>
                    <th className="px-4 py-2.5 font-medium text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {displayOpps.map((opp, i) => {
                    const demand = demandSignals.get(opp.category);
                    const isSelected = selectedOppCategory === opp.category;
                    const color = CAT_COLORS[opp.category] || '#94a3b8';
                    return (
                      <tr
                        key={opp.category}
                        onClick={() => setSelectedOppCategory(isSelected ? null : opp.category)}
                        className={`border-b border-border/50 last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                      >
                        <td className="px-5 py-3 text-xs text-muted-foreground">{i + 1}</td>
                        <td className="px-4 py-3 font-medium flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0" style={{background: color}} />
                          {opp.categoryLabel}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{fmtNum(opp.existing)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{opp.per10k}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className={opp.gap > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {opp.gap > 0 ? '+' : ''}{fmtNum(opp.gap)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {demand ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${demand.score > 50 ? 'bg-emerald-500/20 text-emerald-400' : demand.score > 20 ? 'bg-amber-500/20 text-amber-400' : 'bg-muted text-muted-foreground'}`}>
                              {demand.score}
                            </span>
                          ) : <span className="text-muted-foreground text-xs">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className={`font-bold tabular-nums ${scoreColor(opp.score)}`}>{opp.score}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {opportunities.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">No opportunities found.</div>
            )}
          </div>

          {/* Methodology */}
          <div className="rounded-xl border border-border bg-card p-5 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground mb-1">How the scoring works</p>
            <p>
              Every category is counted from OpenStreetMap data, normalized per 10,000 residents, and benchmarked against the median.
              Opportunity Score = <span className="font-mono">0.60 × supplyGap + 0.15 × marketSize + 0.25 × 50 + demandBonus(0-15)</span>.
              Demand signals come from Google search presence, Wikipedia pageviews, and Reddit mentions.
            </p>
          </div>
        </div>
      )}

      <footer className="border-t border-border py-8 mt-8">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs text-muted-foreground">
          <p>Blue Ocean · Market Gap Intelligence — built on OpenStreetMap, Nominatim, Wikipedia</p>
          <p className="mt-1">100% client-side · No backend · No data stored · Free & open source</p>
        </div>
      </footer>
    </div>
  );
}
