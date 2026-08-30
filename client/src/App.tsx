import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  resolveCity,
  queryBusinesses,
  getDemandSignals,
  computeOpportunities,
  getCategoryLabel,
  getGoogleMapsUrl, getAIAnalysis,
  setCancelSignal,
  type CityResult,
  type Business,
  type DemandSignal,
  type OpportunityResult,
  type DiscoveryProgress,
  type AIAnalysis,
  type SanityCheck,
  runDiscoveryPhases,
  getSmartCategoryAnalysis,
  sanityCheckOpportunities,
  aiVerifyOpportunities,
  rescanWideNet,
  getEngineHealthSnapshot,
  type EngineHealthEntry,
  type VerificationResult,
  type EnrichmentProgress,
  setScanContext, buildScanContext,
  addBackupKeys, keyPoolStatus,
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

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  // v6.9.17: previously missing big countries
  { name: 'Belarus', code: 'BY' }, { name: 'Kazakhstan', code: 'KZ' },
  { name: 'Uzbekistan', code: 'UZ' }, { name: 'Moldova', code: 'MD' },
  { name: 'Lithuania', code: 'LT' }, { name: 'Latvia', code: 'LV' },
  { name: 'Estonia', code: 'EE' }, { name: 'Israel', code: 'IL' },
  { name: 'Saudi Arabia', code: 'SA' }, { name: 'United Arab Emirates', code: 'AE' },
  { name: 'Qatar', code: 'QA' }, { name: 'Kuwait', code: 'KW' },
  { name: 'Iran', code: 'IR' }, { name: 'Iraq', code: 'IQ' },
  { name: 'Pakistan', code: 'PK' }, { name: 'Bangladesh', code: 'BD' },
  { name: 'Sri Lanka', code: 'LK' }, { name: 'Malaysia', code: 'MY' },
  { name: 'Singapore', code: 'SG' }, { name: 'Morocco', code: 'MA' },
  { name: 'Algeria', code: 'DZ' }, { name: 'Tunisia', code: 'TN' },
  { name: 'Ghana', code: 'GH' }, { name: 'Kenya', code: 'KE' },
  { name: 'Ethiopia', code: 'ET' }, { name: 'Taiwan', code: 'TW' },
  { name: 'Hong Kong', code: 'HK' }, { name: 'Slovakia', code: 'SK' },
  { name: 'Slovenia', code: 'SI' }, { name: 'North Macedonia', code: 'MK' },
  { name: 'Albania', code: 'AL' }, { name: 'Bosnia and Herzegovina', code: 'BA' },
  { name: 'Montenegro', code: 'ME' }, { name: 'Malta', code: 'MT' },
  { name: 'Cyprus', code: 'CY' }, { name: 'Luxembourg', code: 'LU' },
  { name: 'Iceland', code: 'IS' },
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
  { id: 'massage', label: '💆 Massage' }, { id: 'dance', label: '🩰 Dance Studio' }, // v6.9.19
  { id: 'web_agency', label: '🌐 Web Agency' }, { id: 'software', label: '⚙️ Software Company' },
  { id: 'it_consulting', label: '🖥️ IT Consulting' }, { id: 'digital_marketing', label: '📣 Digital Marketing' },
  { id: 'lawyer', label: '⚖️ Law Firm' }, { id: 'accountant', label: '🧮 Accounting' },
  { id: 'real_estate', label: '🏠 Real Estate' }, { id: 'insurance', label: '🛡️ Insurance' },
  { id: 'travel_agency', label: '✈️ Travel Agency' }, { id: 'cleaning', label: '🧹 Cleaning Service' },
  { id: 'car_wash', label: '🚿 Car Wash' }, { id: 'nail_salon', label: '💅 Nail Salon' },
  { id: 'laundry', label: '👔 Laundry' }, { id: 'night_club', label: '🎶 Nightclub' },
  { id: 'car_rental', label: '🚗 Car Rental' }, { id: 'veterinary', label: '🐾 Veterinary' },
  { id: 'florist', label: '🌸 Florist' }, { id: 'marketplace', label: '🏪 Marketplace' },
];

const CAT_COLORS: Record<string, string> = {
  cafe: '#f59e0b', restaurant: '#ef4444', bar: '#8b5cf6', pub: '#a855f7',
  hotel: '#3b82f6', gym: '#10b981', beauty_salon: '#ec4899', hair_salon: '#f472b6',
  pharmacy: '#06b6d4', supermarket: '#22c55e', bank: '#6366f1', clothing: '#a855f7',
  electronics: '#64748b', bakery: '#fbbf24', fast_food: '#f97316', school: '#3b82f6',
  cinema: '#e879f9', car_repair: '#f97316', pet_groomer: '#fb923c', coworking: '#38bdf8',
  spa: '#c084fc', yoga: '#34d399', massage: '#f0abfc', dance: '#e879f9',
  bookstore: '#a78bfa', library: '#2dd4bf', post_office: '#fbbf24',
  web_agency: '#06b6d4', software: '#3b82f6', it_consulting: '#6366f1',
  digital_marketing: '#f43f5e', lawyer: '#78716c', accountant: '#a8a29e',
  real_estate: '#84cc16', insurance: '#14b8a6', travel_agency: '#f59e0b',
  cleaning: '#22d3ee', car_wash: '#38bdf8', nail_salon: '#f472b6',
  laundry: '#94a3b8', night_club: '#a855f7', car_rental: '#fb923c',
  veterinary: '#10b981', florist: '#f472b6', marketplace: '#fbbf24',
};

const APP_VERSION = '6.9.19';

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
  const [discoverProgress, setDiscoverProgress] = useState<DiscoveryProgress | null>(null);
  const [demandSignals, setDemandSignals] = useState<Map<string, DemandSignal>>(new Map());
  const [selectedOppCategory, setSelectedOppCategory] = useState<string | null>(null);
  const [showAllOpps, setShowAllOpps] = useState(false);
  const [aiInsights, setAiInsights] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState<AIAnalysis | null>(null);
  const [selectedBiz, setSelectedBiz] = useState<{name:string;category:string;categoryLabel:string;color:string;phone:string;email:string;website:string;address:string;facebook:string;instagram:string;linkedin:string;youtube:string;tiktok:string;twitter:string;pinterest:string;rating:number;reviewCount:number;hours:string;lat:number;lon:number}|null>(null);
  const [enrichProgress, setEnrichProgress] = useState<EnrichmentProgress | null>(null);
  // v6.9.2: engine health (quota / fallback banners) + AI verification notes
  const [engineHealth, setEngineHealth] = useState<EngineHealthEntry[]>([]);
  const [aiVerification, setAiVerification] = useState<VerificationResult | null>(null);
  // v6.9.15: click-to-explain modal for the plausibility badge in the opportunities table
  const [sanityDetail, setSanityDetail] = useState<SanityCheck | null>(null);
  const [rescanNote, setRescanNote] = useState('');
  // v6.9.13: backup API-key manager (Settings panel)
  const [showSettings, setShowSettings] = useState(false);
  const [bkInputs, setBkInputs] = useState<Record<string, string>>({});
  const [bkStatus, setBkStatus] = useState<Record<string, { total: number; alive: number }>>({});
  const [bkToast, setBkToast] = useState('');
  const refreshBkStatus = useCallback(() => {
    const s: Record<string, { total: number; alive: number }> = {};
    for (const k of ['brave', 'serper', 'tavily', 'openrouter']) {
      s[k] = keyPoolStatus(k);
    }
    setBkStatus(s);
  }, []);
  const saveBackupKeys = useCallback((provider: string) => {
    const raw = (bkInputs[provider] || '').trim();
    if (!raw) return;
    const keys = raw.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) return;
    addBackupKeys(provider as any, keys);
    try { localStorage.setItem(`bk_keys_${provider}`, raw); } catch {}
    setBkInputs(prev => ({ ...prev, [provider]: '' }));
    refreshBkStatus();
    setBkToast(`Added ${keys.length} backup key${keys.length > 1 ? 's' : ''} for ${provider}`);
    setTimeout(() => setBkToast(''), 3000);
  }, [bkInputs, refreshBkStatus]);
  // Restore saved backup keys once on mount
  useEffect(() => {
    try {
      for (const p of ['brave', 'serper', 'tavily', 'openrouter']) {
        const saved = localStorage.getItem(`bk_keys_${p}`);
        if (saved) addBackupKeys(p as any, saved.split(/[\s,;]+/).filter(Boolean));
      }
    } catch {}
    refreshBkStatus();
  }, [refreshBkStatus]);

  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const maplibreRef = useRef<any>(null);
  const mapReadyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancelProcess = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
    setLoadingStage('');
    setProgress(0);
  }, []);

  // Listen for map pin clicks
  const bizPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = () => {
      const b = (window as any).__selectedBiz;
      if (b) {
        setSelectedBiz(b);
        // Scroll panel into view after render
        setTimeout(() => {
          bizPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
    };
    window.addEventListener('biz-click', handler);
    return () => window.removeEventListener('biz-click', handler);
  }, []);

  // Search cities
  useEffect(() => {
    if (!cityQuery.trim() || cityQuery.length < 2) { setCityResults([]); return; }
    const timer = setTimeout(async () => {
      setCitySearching(true);
      try {
        const searchQ = selectedCountry ? `${cityQuery}, ${selectedCountry}` : cityQuery;
        const results = await resolveCity(searchQ);
        setCityResults(results.slice(0, 8));
        setError('');
      } catch (e: any) {
        setCityResults([]);
        if (e.message?.includes('rate limit')) setError('Search servers are busy — wait a few seconds and try again');
        else if (e.message?.includes('No results')) setError(''); // silent for no results
      }
      setCitySearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [cityQuery, selectedCountry]);

  // ─── Map initialization ─────────────────────────────────────────
  // Initialize map when selectedCity changes
  useEffect(() => {
    if (!selectedCity || !mapRef.current) return;
    (window as any).__mapFitted = false;
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

      // Track active popup so we can close it on new click
      let activePopup: any = null;

      map.on('load', () => {
        mapReadyRef.current = true;
        // Add GeoJSON source for businesses
        map.addSource('businesses', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Circle layer: BIG and visible at all zoom levels
        map.addLayer({
          id: 'biz-circles',
          type: 'circle',
          source: 'businesses',
          paint: {
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              4, 8,
              8, 12,
              12, 16,
              16, 20,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#1e293b',
            'circle-stroke-opacity': 0.8,
            'circle-opacity': 0.9,
          },
        });
        // Text label layer: emoji or letter on each circle
        map.addLayer({
          id: 'biz-labels',
          type: 'symbol',
          source: 'businesses',
          layout: {
            'text-field': ['get', 'emoji'],
            'text-size': 14,
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
        // Click handler — show MapLibre popup ON the pin
        const handleBizClick = (e: any) => {
          e.originalEvent?.stopPropagation?.();
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties;
          const coords = f.geometry.coordinates;
          // Close previous popup
          if (activePopup) { activePopup.remove(); activePopup = null; }
          // Build compact popup HTML (all business-controlled values escaped)
          const contactParts: string[] = [];
          if (p.phone) contactParts.push(`<a href="tel:${escapeHtml(p.phone)}" style="color:#60a5fa;text-decoration:none">📞 ${escapeHtml(p.phone)}</a>`);
          if (p.email) contactParts.push(`<a href="mailto:${escapeHtml(p.email)}" style="color:#60a5fa;text-decoration:none">✉️ ${escapeHtml(p.email)}</a>`);
          if (p.website) contactParts.push(`<a href="${escapeHtml(p.website)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none">🌐 ${escapeHtml(String(p.website).replace(/^https?:\/\//, '').substring(0, 30))}</a>`);
          if (p.facebook) contactParts.push(`<a href="${escapeHtml(p.facebook)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:none">FB</a>`);
          if (p.instagram) contactParts.push(`<a href="${escapeHtml(p.instagram)}" target="_blank" rel="noopener noreferrer" style="color:#f472b6;text-decoration:none">IG</a>`);
          if (p.linkedin) contactParts.push(`<a href="${escapeHtml(p.linkedin)}" target="_blank" rel="noopener noreferrer" style="color:#93c5fd;text-decoration:none">LI</a>`);
          if (p.youtube) contactParts.push(`<a href="${escapeHtml(p.youtube)}" target="_blank" rel="noopener noreferrer" style="color:#f87171;text-decoration:none">YT</a>`);
          if (p.tiktok) contactParts.push(`<a href="${escapeHtml(p.tiktok)}" target="_blank" rel="noopener noreferrer" style="color:#fff;text-decoration:none">TT</a>`);
          if (p.twitter) contactParts.push(`<a href="${escapeHtml(p.twitter)}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:none">X</a>`);
          if (p.pinterest) contactParts.push(`<a href="${escapeHtml(p.pinterest)}" target="_blank" rel="noopener noreferrer" style="color:#f87171;text-decoration:none">Pin</a>`);
          if (p.rating > 0) contactParts.push(`<span style="color:#fbbf24;font-size:11px">★ ${Number(p.rating).toFixed(1)}${p.reviewCount > 0 ? ` (${p.reviewCount})` : ''}</span>`);
          if (p.hours) contactParts.push(`<span style="color:#94a3b8;font-size:11px">🕐 ${escapeHtml(p.hours)}</span>`);
          if (p.address) contactParts.push(`<span style="color:#94a3b8;font-size:11px">📍 ${escapeHtml(p.address)}</span>`);
          const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${coords[1]},${coords[0]}`;
          contactParts.push(`<a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" style="color:#34d399;text-decoration:none;font-size:11px">📍 Open in Maps</a>`);
          const html = `
            <div style="min-width:200px;max-width:300px;font-family:system-ui;font-size:13px;padding:0">
              <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:${p.color}22;border-bottom:1px solid #333">
                <span style="width:8px;height:8px;border-radius:50%;background:${p.color};flex-shrink:0"></span>
                <strong style="color:#fff;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name) || 'Unknown'}</strong>
                <span style="font-size:10px;color:${p.color};background:${p.color}22;padding:1px 6px;border-radius:8px">${escapeHtml(p.categoryLabel) || ''}</span>
              </div>
              <div style="padding:6px 10px;display:flex;flex-direction:column;gap:3px">
                ${contactParts.join('')}
              </div>
            </div>`;
          activePopup = new maplibregl.Popup({ offset: 20, closeButton: true, maxWidth: '300px', className: 'biz-popup' })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(map);
          // Also set state for the panel below (compact)
          (window as any).__selectedBiz = {
            name: p.name || '', category: p.category || '', categoryLabel: p.categoryLabel || '',
            color: p.color || '#64748b', phone: p.phone || '', email: p.email || '',
            website: p.website || '', address: p.address || '', facebook: p.facebook || '',
            instagram: p.instagram || '', linkedin: p.linkedin || '', youtube: p.youtube || '',
            tiktok: p.tiktok || '', twitter: p.twitter || '', pinterest: p.pinterest || '',
            rating: p.rating || 0, reviewCount: p.reviewCount || 0, hours: p.hours || '',
            lat: coords[1], lon: coords[0],
          };
          window.dispatchEvent(new CustomEvent('biz-click'));
        };
        map.on('click', 'biz-circles', handleBizClick);
        map.on('click', 'biz-labels', handleBizClick);
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
      web_agency: '🌐', software: '⚙️', it_consulting: '🖥️', digital_marketing: '📣',
      lawyer: '⚖️', accountant: '🧮', real_estate: '🏠', insurance: '🛡️',
      travel_agency: '✈️', cleaning: '🧹', car_wash: '🚿', nail_salon: '💅',
      laundry: '👔',
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
        linkedin: b.linkedin || '',
        youtube: b.youtube || '',
        tiktok: b.tiktok || '',
        twitter: b.twitter || '', pinterest: b.pinterest || '',
        rating: b.rating || 0, reviewCount: b.reviewCount || 0, hours: b.hours || '',
      },
    }));

    const geojson = { type: 'FeatureCollection' as const, features };
    const source = map.getSource('businesses');
    if (source) {
      source.setData(geojson);
    }

    // Fit bounds only if this is the first data load (tracked by a ref)
    if (allBiz.length > 1 && !(window as any).__mapFitted) {
      (window as any).__mapFitted = true;
      const bounds = new (maplibreRef.current as any).LngLatBounds();
      allBiz.forEach(b => bounds.extend([b.lon, b.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1200 });
    }
  }

  // Discover all opportunities
  const runAnalysis = useCallback(async () => {
    if (!selectedCity) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setCancelSignal(ac.signal);
    (window as any).__mapFitted = false;
    setLoading(true);
    setError('');
    setBusinesses(new Map());
    setOpportunities([]);
    setDemandSignals(new Map());
    setSelectedOppCategory(null);
    setShowAllOpps(false);
    setEnrichProgress(null);
    setDiscoverProgress(null);
    setAiAnalysis(null);
    setAiVerification(null);
    setRescanNote('');
    setEngineHealth(getEngineHealthSnapshot());

    try {
      // Native-language context for this city (helps contact discovery)
      setScanContext(buildScanContext(selectedCity.countryCode, selectedCity.country, selectedCity.name));
      let biz = await queryBusinesses(
        selectedCity.lat, selectedCity.lon, 10000,
        (pct, msg) => { setProgress(pct); setLoadingStage(msg); },
        undefined, true,
        undefined,
        (dp) => setDiscoverProgress(dp),
      );
      setBusinesses(biz);
      setProgress(40);

      if (biz.size === 0) {
        setError('No businesses found — OpenStreetMap servers may be busy. Click Retry to try again.');
        setLoading(false);
        return;
      }

      // Run demand signals + scoring + AI in one streamed pipeline.
      // Each phase emits DiscoveryProgress updates for the live feed UI.
      setLoadingStage('Measuring demand & computing opportunities…');
      const { opportunities: opps, demandSignals: signals, aiInsights, aiAnalysis: analysis } =
        await runDiscoveryPhases(
          biz, selectedCity.population || 0,
          selectedCity.name, selectedCity.country,
          (dp) => setDiscoverProgress(dp),
          ac.signal,
        );
      if (ac.signal.aborted) return;
      setOpportunities(opps);
      setDemandSignals(signals);
      if (aiInsights) setAiInsights(aiInsights);
      setAiAnalysis(analysis ?? null);

      // ── Second-chance rescan (v6.9.2): AI-checked absurd-low counts ──
      // The sanity pass flags categories whose counts fail plausibility bands.
      // For those with a name-based wide-net filter available, re-query OSM
      // once and merge newly found businesses; then recompute opportunities.
      const absurdCats = (analysis?.sanity || [])
        .filter(s => s.verdict === 'absurd')
        .map(s => s.category);
      if (absurdCats.length > 0 && !ac.signal.aborted) {
        try {
          setLoadingStage(`Re-checking ${absurdCats.length} suspicious categor${absurdCats.length > 1 ? 'ies' : 'y'}…`);
          const merged = await rescanWideNet(biz, absurdCats, selectedCity.lat, selectedCity.lon, 10000, {
            signal: ac.signal,
            onProgress: (msg) => setRescanNote(msg),
          });
          const addedTotal = Array.from(merged.entries()).reduce((s, [c, arr]) => {
            const before = biz.get(c)?.length ?? 0;
            return s + Math.max(0, arr.length - before);
          }, 0);
          if (addedTotal > 0) {
            biz = merged;
            setBusinesses(merged);
            const opps2 = computeOpportunities(merged, selectedCity.population || 0, signals);
            setOpportunities(opps2);
            if (analysis) {
              analysis.sanity = sanityCheckOpportunities(opps2, selectedCity.population || 0);
              setAiAnalysis(analysis);
            }
          }
          setRescanNote(addedTotal > 0
            ? `Re-check added ${addedTotal} businesses missed by the first scan.`
            : 'Re-check confirmed the first scan — no additional businesses found.');
        } catch { /* rescan best-effort */ }
      }

      // ── AI verification pass (v6.9.2): LLM cross-checks the flags ──
      if (!ac.signal.aborted) {
        try {
          setLoadingStage('AI verifying results…');
          const ver = await aiVerifyOpportunities(opportunities, selectedCity.population || 0, selectedCity.name, selectedCity.country, { signal: ac.signal });
          setAiVerification(ver);
          setEngineHealth(getEngineHealthSnapshot());
        } catch { /* verification best-effort */ }
      }
      setProgress(100);
    } catch (e: any) {
      if (e.message !== 'Cancelled') setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
      setLoadingStage('');
      abortRef.current = null;
      setCancelSignal(null);
    }
  }, [selectedCity]);

  // Analyze single industry
  const startAnalyze = useCallback(async () => {
    if (!selectedCity || !selectedCategory) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setCancelSignal(ac.signal);
    (window as any).__mapFitted = false;
    setLoading(true);
    setError('');
    setBusinesses(new Map());
    setOpportunities([]);
    setDemandSignals(new Map());
    setEnrichProgress(null);
    setAiAnalysis(null);
    setAiVerification(null);
    setRescanNote('');
    setEngineHealth(getEngineHealthSnapshot());

    try {
      setLoadingStage(`Scanning ${getCategoryLabel(selectedCategory)}…`);
      setProgress(5);

      // Native-language context for this city (helps contact discovery)
      setScanContext(buildScanContext(selectedCity.countryCode, selectedCity.country, selectedCity.name));
      let biz = await queryBusinesses(
        selectedCity.lat, selectedCity.lon, 10000,
        (pct, msg) => { setProgress(Math.max(pct, 5)); setLoadingStage(msg); },
        selectedCategory,
        false,
        (ep) => setEnrichProgress(ep)
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
      const opps = computeOpportunities(biz, selectedCity.population || 0, signals);
      setOpportunities(opps);
      setSelectedOppCategory(selectedCategory);
      setProgress(90);

      // ── AI analysis for this single category (v6.9.1) ──
      // Real LLM insights grounded in this category's scan + demand data,
      // plus the sanity-check pass that flags implausible counts before
      // the results are shown.
      let analysis: AIAnalysis | null = null;
      try {
        setLoadingStage('AI market analysis…');
        analysis = await getSmartCategoryAnalysis(
          selectedCategory, selectedCity.name, selectedCity.country,
          selectedCity.population || 0,
          biz.get(selectedCategory) || [], sig,
        );
        const sanity = sanityCheckOpportunities(opps, selectedCity.population || 0);
        analysis.sanity = sanity;
        const absurd = sanity.filter(s => s.verdict === 'absurd');
        if (absurd.length > 0) {
          analysis.insights = [{
            title: `⚠ Data warning: ${absurd.length > 1 ? `${absurd.length} categories` : 'this category'} failed the plausibility check`,
            detail: absurd[0].reason,
            severity: 'medium',
            categories: absurd.slice(0, 4).map(s => s.category).filter(c => c !== selectedCategory),
          }, ...analysis.insights];
        }
        setAiAnalysis(analysis);
      } catch {
        // AI unavailable → panel stays hidden; results remain fully usable.
      }
      // ── Second-chance rescan for this category (v6.9.2) ──
      const absurdCats1 = (analysis?.sanity || [])
        .filter(s => s.verdict === 'absurd' && s.category === selectedCategory)
        .map(s => s.category);
      if (absurdCats1.includes(selectedCategory) && !ac.signal.aborted) {
        try {
          setLoadingStage('Re-checking with a wider search…');
          const merged = await rescanWideNet(biz, [selectedCategory], selectedCity.lat, selectedCity.lon, 10000, {
            signal: ac.signal,
            onProgress: (msg) => setRescanNote(msg),
          });
          const before = biz.get(selectedCategory)?.length ?? 0;
          const after = merged.get(selectedCategory)?.length ?? 0;
          if (after > before) {
            biz = merged;
            setBusinesses(merged);
            const opps2 = computeOpportunities(merged, selectedCity.population || 0, signals);
            setOpportunities(opps2);
            if (analysis) {
              analysis.sanity = sanityCheckOpportunities(opps2, selectedCity.population || 0);
              setAiAnalysis(analysis);
            }
            setRescanNote(`Re-check found ${after - before} more businesses missed by the first scan.`);
          } else {
            setRescanNote('Re-check confirmed the first scan — no additional businesses found.');
          }
        } catch { /* rescan best-effort */ }
      }

      // ── AI verification pass (v6.9.2) ──
      if (!ac.signal.aborted) {
        try {
          const ver = await aiVerifyOpportunities(opps, selectedCity.population || 0, selectedCity.name, selectedCity.country, { signal: ac.signal });
          setAiVerification(ver);
          setEngineHealth(getEngineHealthSnapshot());
        } catch { /* verification best-effort */ }
      }
      setProgress(100);
    } catch (e: any) {
      if (e.message !== 'Cancelled') setError(e.message || 'Analysis failed');
    } finally {
      setLoading(false);
      setLoadingStage('');
      abortRef.current = null;
      setCancelSignal(null);
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
  // Lazy table rendering — initial row cap to keep the main thread responsive
  const [bizTableLimit, setBizTableLimit] = useState(200);
  // Reset pagination when switching categories or re-running a scan
  useEffect(() => { setBizTableLimit(200); }, [selectedOppCategory, businesses]);

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

  // ── Contact coverage summary (v6.9.1): how many of the found businesses
  // have each contact channel filled. Computed over the FULL filtered set,
  // shown as a strip of stat chips on top of the results table.
  const contactStats = useMemo(() => {
    const n = filteredBiz.length;
    const count = (pred: (b: Business) => boolean) => filteredBiz.reduce((s, b) => (pred(b) ? s + 1 : s), 0);
    const phones = count(b => !!b.phone);
    const emails = count(b => !!b.email);
    const websites = count(b => !!b.website);
    const socials = count(b => !!(b.facebook || b.instagram || b.linkedin || b.youtube || b.tiktok || b.twitter || b.pinterest));
    const anyContact = count(b => !!(b.phone || b.email || b.website || b.facebook || b.instagram || b.linkedin || b.youtube || b.tiktok || b.twitter || b.pinterest));
    const full = count(b => !!(b.phone && b.email && b.website));
    const pct = (v: number) => (n ? Math.round((v / n) * 100) : 0);
    return { n, phones, emails, websites, socials, anyContact, full, pct };
  }, [filteredBiz]);

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
              <button
                onClick={() => { setShowSettings(s => !s); refreshBkStatus(); }}
                title="Backup API keys & engine settings"
                className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
              >
                ⚙️ Settings
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* v6.9.13: Settings — backup API-key manager */}
      {showSettings && (
        <section className="mx-auto max-w-3xl px-4 pt-4">
          <div className="rounded-xl border border-border bg-card/60 p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm font-bold text-foreground">⚙️ Backup API Keys</div>
              <button onClick={() => setShowSettings(false)} className="text-xs text-muted-foreground hover:text-foreground">✕ close</button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Each data source already has a built-in free key. Add <b>backup keys</b> from your own
              accounts — when one hits its quota, the app rotates to the next automatically and the
              scan never stops. Keys are stored only in this browser (localStorage).
            </p>
            {bkToast && (
              <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{bkToast}</div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {(['brave', 'serper', 'tavily', 'openrouter'] as const).map(provider => (
                <div key={provider} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-foreground capitalize">{provider === 'openrouter' ? 'OpenRouter (AI)' : provider}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                      (bkStatus[provider]?.alive ?? 0) > 1 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                      : (bkStatus[provider]?.alive ?? 0) === 1 ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
                      : 'text-red-400 border-red-500/30 bg-red-500/10'
                    }`}>
                      {(bkStatus[provider]?.alive ?? 0)}/{(bkStatus[provider]?.total ?? 0)} keys alive
                    </span>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="password"
                      value={bkInputs[provider] || ''}
                      onChange={e => setBkInputs(prev => ({ ...prev, [provider]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') saveBackupKeys(provider); }}
                      placeholder="paste backup key(s), comma-separated"
                      className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
                    />
                    <button
                      onClick={() => saveBackupKeys(provider)}
                      className="rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20 transition-all"
                    >
                      Add
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Get free keys: <a className="underline hover:text-foreground" href="https://api-dashboard.search.brave.com/register" target="_blank" rel="noreferrer">Brave</a> · <a className="underline hover:text-foreground" href="https://serper.dev/signup" target="_blank" rel="noreferrer">Serper</a> · <a className="underline hover:text-foreground" href="https://app.tavily.com/home" target="_blank" rel="noreferrer">Tavily</a> · <a className="underline hover:text-foreground" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">OpenRouter</a>
              — when ALL keys for a provider are exhausted the engine banner shows
              <span className="text-red-300"> "backups exceeded"</span> and the scan continues on backup engines.
            </p>
          </div>
        </section>
      )}

      {/* Hero */}
      <section className="relative">
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
                        onClick={() => {
                          // v6.9.18: clear stale scan results when a new city is picked
                          abortRef.current?.abort();
                          setOpportunities([]); setBusinesses(new Map()); setAiInsights('');
                          setAiAnalysis(null); setAiVerification(null); setDemandSignals(new Map());
                          setSelectedOppCategory(null); setShowAllOpps(false);
                          setSelectedCity(c); setCityResults([]);
                        }}
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
              <div className="mb-1 flex justify-between items-center text-xs text-muted-foreground">
                <span className="truncate flex-1 mr-2">{loadingStage}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span>{progress}%</span>
                  <button
                    onClick={cancelProcess}
                    className="rounded-md bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-400 hover:bg-rose-500/25 transition-colors"
                  >
                    ✕ Cancel
                  </button>
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-500" style={{width: `${progress}%`}} />
              </div>

              {/* ── Real-time Live Discovery Feed ── */}
              {enrichProgress && enrichProgress.percent > 0 && (
                <div className="mt-3 overflow-hidden rounded-xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.04] via-card/90 to-cyan-500/[0.04] backdrop-blur-sm">

                  {/* ── Top bar: scanning radar + pass + counters ── */}
                  <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5">
                    {/* Animated scanning radar */}
                    <div className="relative h-9 w-9 shrink-0">
                      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-violet-500/30 to-cyan-500/30 animate-pulse" />
                      <div className="absolute inset-0 rounded-full border border-violet-400/40 animate-[ping_2.5s_linear_infinite]" />
                      <div className="absolute inset-1.5 rounded-full border border-violet-300/30 animate-[ping_2.5s_linear_infinite_0.4s]" />
                      <div className="absolute inset-0 flex items-center justify-center text-base">
                        {(() => {
                          const active = enrichProgress.engines.find(e => e.status === 'active');
                          return active?.icon ?? '🔎';
                        })()}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-foreground">{enrichProgress.activePass}</span>
                        <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-violet-300">
                          Pass {enrichProgress.passNumber}/{enrichProgress.totalPasses}
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary/60">
                        <div className="h-full rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-500 transition-all duration-300" style={{width: `${enrichProgress.percent}%`}} />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[10px] text-muted-foreground">processed</div>
                      <div className="text-xs font-bold tabular-nums text-foreground">
                        {enrichProgress.businessesProcessed}<span className="text-muted-foreground/60">/{enrichProgress.businessesTotal}</span>
                      </div>
                    </div>
                  </div>

                  {/* ── Engine leaderboard ── */}
                  <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2">
                    {[...enrichProgress.engines].sort((a,b) => b.found - a.found).map((eng) => (
                      <span
                        key={eng.name}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all duration-300
                          ${eng.status === 'active' ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40' :
                            eng.status === 'done' ? 'bg-muted/50 text-muted-foreground' :
                            eng.status === 'error' ? 'bg-rose-500/15 text-rose-400' :
                            'bg-muted/30 text-muted-foreground/40'}`}
                        title={`${eng.name}: ${eng.found} contacts found`}
                      >
                        <span>{eng.icon}</span>
                        <span>{eng.name}</span>
                        {eng.found > 0 && <span className="tabular-nums font-bold text-foreground/80">{eng.found}</span>}
                        {eng.status === 'active' && <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />}
                      </span>
                    ))}
                  </div>

                  {/* ── Two-column body: coverage heatmap + live stream ── */}
                  <div className="grid gap-3 px-3 py-2.5 sm:grid-cols-[1fr_1.4fr]">

                    {/* Coverage heatmap (left) */}
                    <div className="space-y-1.5">
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">Coverage</div>
                      {(() => {
                        const total = Math.max(enrichProgress.businessesProcessed, 1);
                        const types = [
                          { key: 'emails', icon: '📧', color: 'from-emerald-500 to-cyan-500' },
                          { key: 'phones', icon: '📞', color: 'from-violet-500 to-fuchsia-500' },
                          { key: 'websites', icon: '🌐', color: 'from-amber-500 to-orange-500' },
                          { key: 'social', icon: '👤', color: 'from-pink-500 to-rose-500' },
                        ] as const;
                        return types.map(t => {
                          const count = enrichProgress.contacts[t.key];
                          const pct = Math.round((count / total) * 100);
                          return (
                            <div key={t.key} className="flex items-center gap-2">
                              <span className="w-4 shrink-0 text-xs">{t.icon}</span>
                              <div className="relative h-4 flex-1 overflow-hidden rounded-md bg-secondary/60">
                                <div
                                  className={`h-full rounded-md bg-gradient-to-r ${t.color} transition-all duration-500`}
                                  style={{width: `${Math.min(pct, 100)}%`}}
                                />
                                <div className="absolute inset-0 flex items-center px-2 text-[10px] font-semibold text-foreground/90">
                                  <span className="tabular-nums">{count}</span>
                                  <span className="ml-1 text-muted-foreground/70">({pct}%)</span>
                                </div>
                              </div>
                            </div>
                          );
                        });
                      })()}

                      {/* Currently parsing card */}
                      {enrichProgress.currentBusiness && (
                        <div className="mt-2 overflow-hidden rounded-lg border border-violet-500/30 bg-violet-500/5 p-2">
                          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-violet-300/80">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
                            Parsing now
                          </div>
                          <div className="mt-0.5 truncate text-xs font-medium text-foreground" title={enrichProgress.currentBusiness.name}>
                            {enrichProgress.currentBusiness.name}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            {enrichProgress.currentBusiness.engine && (
                              <span className="rounded-full bg-violet-500/15 px-1.5 py-px text-violet-300">
                                via {enrichProgress.currentBusiness.engine}
                              </span>
                            )}
                            <span className="text-violet-300/80">→ {enrichProgress.currentBusiness.stage}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Live stream (right) */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
                          Live stream
                        </div>
                        <div className="text-[9px] text-muted-foreground/60 tabular-nums">
                          {enrichProgress.recentBusinesses.length} / {enrichProgress.businessesTotal}
                        </div>
                      </div>
                      <div className="max-h-44 overflow-y-auto rounded-lg border border-border/50 bg-background/40 p-1.5 space-y-1 livefeed-scroll">
                        {enrichProgress.recentBusinesses.length === 0 && (
                          <div className="flex h-16 items-center justify-center text-[10px] text-muted-foreground/60">
                            waiting for first parse…
                          </div>
                        )}
                        {enrichProgress.recentBusinesses.map((rb) => (
                          <div
                            key={rb.id}
                            className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] transition-all duration-300 animate-[slidein_0.3s_ease-out] ${
                              rb.status === 'parsing' ? 'border-violet-500/40 bg-violet-500/10' :
                              rb.status === 'enriched' ? 'border-emerald-500/30 bg-emerald-500/5' :
                              rb.status === 'partial' ? 'border-amber-500/30 bg-amber-500/5' :
                              'border-border/60 bg-background/30'
                            }`}
                          >
                            {rb.status === 'parsing' && (
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-violet-400 animate-pulse" />
                            )}
                            {rb.status !== 'parsing' && (
                              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                                rb.status === 'enriched' ? 'bg-emerald-400' :
                                rb.status === 'partial' ? 'bg-amber-400' :
                                'bg-muted-foreground/40'
                              }`} />
                            )}
                            <span className={`min-w-0 flex-1 truncate font-medium ${
                              rb.status === 'parsing' ? 'text-violet-200' : 'text-foreground/90'
                            }`} title={rb.name}>
                              {rb.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-1">
                              <span className={`text-[10px] ${rb.hasPhone ? 'opacity-100' : 'opacity-25'}`} title="phone">📞</span>
                              <span className={`text-[10px] ${rb.hasEmail ? 'opacity-100' : 'opacity-25'}`} title="email">📧</span>
                              <span className={`text-[10px] ${rb.hasWebsite ? 'opacity-100' : 'opacity-25'}`} title="website">🌐</span>
                              <span className={`text-[10px] ${rb.hasSocial ? 'opacity-100' : 'opacity-25'}`} title="social">👤</span>
                            </div>
                            {rb.viaEngine && (
                              <span className="hidden sm:inline shrink-0 rounded-full bg-muted/60 px-1.5 py-px text-[9px] text-muted-foreground">
                                {rb.viaEngine}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* ── Query log strip ── */}
                  {enrichProgress.recentQueries.length > 0 && (
                    <div className="border-t border-border/60 px-3 py-2">
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 mb-1">Recent queries</div>
                      <div className="flex flex-wrap gap-1">
                        {enrichProgress.recentQueries.slice(0, 4).map((q, i) => (
                          <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            <span className="text-cyan-400">⌕</span>
                            <span className="truncate max-w-[280px]" title={q}>{q}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Real-time Discovery Phases (Discover Opportunities full mode) ── */}
              {discoverProgress && discoverProgress.percent > 0 && (
                <div className="mt-3 overflow-hidden rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.04] via-card/90 to-emerald-500/[0.04] backdrop-blur-sm">

                  {/* ── Top bar ── */}
                  <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5">
                    <div className="relative h-9 w-9 shrink-0">
                      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-500/30 to-emerald-500/30 animate-pulse" />
                      <div className="absolute inset-0 rounded-full border border-cyan-400/40 animate-[ping_2.5s_linear_infinite]" />
                      <div className="absolute inset-1.5 rounded-full border border-cyan-300/30 animate-[ping_2.5s_linear_infinite_0.4s]" />
                      <div className="absolute inset-0 flex items-center justify-center text-base">🛰️</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-foreground">
                          {discoverProgress.phase === 'osm' ? 'Phase 1: OpenStreetMap scanning' :
                           discoverProgress.phase === 'demand' ? 'Phase 2: Demand signals' :
                           discoverProgress.phase === 'score' ? 'Phase 3: Scoring opportunities' :
                           discoverProgress.phase === 'ai' ? 'Phase 4: AI analysis' :
                           'Discovery complete'}
                        </span>
                        <span className="shrink-0 rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-300">
                          {discoverProgress.totalFound} businesses
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary/60">
                        <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-emerald-500 to-amber-500 transition-all duration-300" style={{width: `${discoverProgress.percent}%`}} />
                      </div>
                    </div>
                  </div>

                  {/* ── Three columns: OSM batches · demand signals · live ranking ── */}
                  <div className="grid gap-3 px-3 py-2.5 lg:grid-cols-3">

                    {/* Column A: OSM scanning batches */}
                    <div className="space-y-1.5">
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">OSM batches</div>
                      {([
                        { key: 'foodHealth',  label: 'Food / Health / Entertainment', icon: '🍽️' },
                        { key: 'shopsRetail', label: 'Shops & Retail',                  icon: '🛍️' },
                        { key: 'hotelsGyms',  label: 'Hotels / Gyms / Services',        icon: '🏨' },
                        ...(discoverProgress.osmBatches.fallback ? [{ key: 'fallback', label: 'Fallback retry', icon: '🔁' }] : []),
                      ] as const).map(({ key, label, icon }) => {
                        const b = discoverProgress.osmBatches[key as keyof typeof discoverProgress.osmBatches];
                        if (!b) return null;
                        const isRunning = b.status === 'running';
                        const isDone = b.status === 'done';
                        const isError = b.status === 'error';
                        return (
                          <div key={key} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition-all ${
                            isRunning ? 'border-cyan-500/40 bg-cyan-500/10' :
                            isDone ? 'border-emerald-500/30 bg-emerald-500/5' :
                            isError ? 'border-rose-500/30 bg-rose-500/5' :
                            'border-border/60 bg-background/30'
                          }`}>
                            <span className="text-sm shrink-0">{icon}</span>
                            <div className="min-w-0 flex-1">
                              <div className={`truncate text-[11px] font-medium ${
                                isRunning ? 'text-cyan-200' : 'text-foreground/90'
                              }`}>{label}</div>
                              <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                                {b.status === 'pending' ? 'waiting…' :
                                 b.status === 'running' ? 'scanning…' :
                                 b.status === 'done'    ? `+${b.found} found` :
                                                          'failed'}
                              </div>
                            </div>
                            {isRunning && <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />}
                            {isDone && <span className="text-emerald-400 text-xs shrink-0">✓</span>}
                            {isError && <span className="text-rose-400 text-xs shrink-0">✕</span>}
                          </div>
                        );
                      })}
                    </div>

                    {/* Column B: demand signals */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">Demand signals</div>
                        <div className="text-[9px] text-muted-foreground/60 tabular-nums">
                          {discoverProgress.demandDone}/{discoverProgress.demandTotal}
                        </div>
                      </div>
                      <div className="max-h-32 overflow-y-auto rounded-lg border border-border/50 bg-background/40 p-1.5 space-y-1 livefeed-scroll">
                        {discoverProgress.demand.length === 0 && (
                          <div className="flex h-12 items-center justify-center text-[10px] text-muted-foreground/60">
                            starting measurements…
                          </div>
                        )}
                        {discoverProgress.demand.map((d, i) => (
                          <div key={i} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-all ${
                            d.status === 'measuring' ? 'bg-cyan-500/10 text-cyan-200' :
                            d.status === 'done'      ? 'bg-emerald-500/5 text-foreground/90' :
                            d.status === 'error'     ? 'bg-rose-500/5 text-rose-300/80' :
                                                        'bg-background/20 text-muted-foreground/60'
                          }`}>
                            {d.status === 'measuring' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0" />}
                            {d.status === 'done' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />}
                            {d.status === 'pending' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/30 shrink-0" />}
                            <span className="min-w-0 flex-1 truncate" title={d.label}>{d.label}</span>
                            {d.sources && d.sources.length > 0 && (
                              <span className="hidden sm:flex gap-0.5 shrink-0 text-[9px]">
                                {d.sources.includes('wikipedia') && <span title="Wikipedia" className="opacity-70">📚</span>}
                                {d.sources.includes('reddit')    && <span title="Reddit"    className="opacity-70">💬</span>}
                                {d.sources.includes('web')       && <span title="Web"       className="opacity-70">🌐</span>}
                              </span>
                            )}
                            {d.score != null && (
                              <span className={`shrink-0 tabular-nums font-bold ${
                                d.score > 50 ? 'text-emerald-400' :
                                d.score > 20 ? 'text-amber-400' :
                                                'text-muted-foreground'
                              }`}>{d.score}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Column C: live ranking leaderboard + biggest-gap callout */}
                    <div className="space-y-1.5">
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">Live ranking</div>
                      {discoverProgress.biggestGap && (
                        <div className="overflow-hidden rounded-lg border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-2 animate-[slidein_0.4s_ease-out]">
                          <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-amber-300/90">
                            <span>🔥</span><span>Biggest gap</span>
                          </div>
                          <div className="mt-0.5 truncate text-xs font-bold text-foreground">{discoverProgress.biggestGap.categoryLabel}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
                            <span className="text-amber-300">+{discoverProgress.biggestGap.gap}</span>
                            <span>expected gap</span>
                            <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-px text-amber-300">
                              score {discoverProgress.biggestGap.score}
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="max-h-32 overflow-y-auto rounded-lg border border-border/50 bg-background/40 p-1.5 space-y-1 livefeed-scroll">
                        {discoverProgress.topOpps.length === 0 && (
                          <div className="flex h-12 items-center justify-center text-[10px] text-muted-foreground/60">
                            waiting for scores…
                          </div>
                        )}
                        {discoverProgress.topOpps.map((opp, i) => (
                          <div key={opp.categoryLabel}
                            className="flex items-center gap-1.5 rounded-md bg-background/30 px-2 py-1 text-[11px] animate-[slidein_0.3s_ease-out]"
                            style={{ animationDelay: `${i * 60}ms` }}
                          >
                            <span className="w-1.5 h-1.5 shrink-0 rounded-full" style={{ background: (CAT_COLORS as Record<string,string>)[opp.category] || '#94a3b8' }} />
                            <span className="min-w-0 flex-1 truncate text-foreground/90">{opp.categoryLabel}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">{opp.existing}</span>
                            <span className={`shrink-0 text-[10px] font-bold tabular-nums ${opp.score >= 60 ? 'text-emerald-400' : opp.score >= 40 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                              {opp.score}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* ── Bottom: AI status + recent queries ── */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
                    {discoverProgress.ai === 'thinking' && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] text-violet-300">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
                        AI thinking…
                      </span>
                    )}
                    {discoverProgress.ai === 'done' && discoverProgress.aiPreview && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-200/90 max-w-full">
                        <span>🧠</span>
                        <span className="truncate max-w-[420px]" title={discoverProgress.aiPreview}>
                          {discoverProgress.aiPreview}
                        </span>
                      </span>
                    )}
                    {discoverProgress.ai === 'error' && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                        ⚠️ AI unavailable — using statistical insights
                      </span>
                    )}
                    {discoverProgress.recentQueries.length > 0 && (
                      <div className="flex flex-wrap gap-1 ml-auto">
                        {discoverProgress.recentQueries.slice(0, 3).map((q, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            <span className="text-cyan-400">⌕</span>
                            <span className="truncate max-w-[260px]" title={q}>{q}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
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
                    // v6.9.18: clear stale scan results when a new city is picked
                    abortRef.current?.abort();
                    setOpportunities([]); setBusinesses(new Map()); setAiInsights('');
                    setAiAnalysis(null); setAiVerification(null); setDemandSignals(new Map());
                    setSelectedOppCategory(null); setShowAllOpps(false);
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
                {selectedCity.population
                  ? <span>👥 pop. {fmtCompact(selectedCity.population)}</span>
                  : <span className="text-amber-500">⚠ population unknown — gap metrics disabled, ranking by competition & demand</span>}
                <span>📈 {opportunities.length} categories</span>
              </div>
            </div>
          </div>

          {/* v6.9.2: Engine health — quota / fallback / down banners */}
          {engineHealth.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <div className="text-xs font-semibold text-amber-300 mb-2 flex items-center gap-2 flex-wrap">
                ⚙ Engine status
                <span className="font-normal text-muted-foreground">some data sources hit limits — the scan continues on backup engines</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {engineHealth.map(e => (
                  <span key={e.id}
                    title={e.detail || e.status}
                    className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border font-medium ${
                      e.status === 'quota' ? 'bg-red-500/10 border-red-500/30 text-red-300'
                      : e.status === 'down' ? 'bg-orange-500/10 border-orange-500/30 text-orange-300'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                    }`}>
                    {e.status === 'quota' ? '⛔' : e.status === 'down' ? '🔴' : '🟡'} {e.label}
                    <span className="opacity-70">
                      {e.status === 'quota'
                        ? (/backups exceeded/i.test(e.detail) ? 'quota — backups exceeded' : 'quota — backups in use')
                        : e.cooldownUntil > 0
                          ? `cooldown ${Math.ceil(e.cooldownUntil / 1000)}s`
                          : e.status}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* v6.9.2: second-chance rescan note */}
          {rescanNote && (
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-xs text-sky-200 flex items-center gap-2">
              🔁 {rescanNote}
            </div>
          )}

          {/* AI Insights (v6.9.2 redesign: model badge + source chip + verification) */}
          {(aiAnalysis || aiInsights) && (
            <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5 relative overflow-hidden">
              {/* decorative glow */}
              <div className="absolute -top-16 -right-16 h-40 w-40 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />
              <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg bg-emerald-500/15 text-base">🤖</span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold leading-tight">AI Market Analysis</h3>
                    <div className="text-[11px] text-muted-foreground">from live scan data · {selectedCity.name}</div>
                  </div>
                </div>
                {/* Source + model badges (v6.9.2) */}
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {aiAnalysis ? (
                    aiAnalysis.isAI ? (
                      <>
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                          ✦ LLM-GENERATED
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full bg-background/60 border border-border text-foreground/80 font-mono"
                          title="Model that produced these insights">
                          🧠 {aiAnalysis.model}
                        </span>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300"
                        title="AI providers unreachable — rules-based analysis on the same real data">
                        ⚙ DETERMINISTIC FALLBACK
                      </span>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                      ✦ LLM-GENERATED
                    </span>
                  )}
                </div>
              </div>

              {/* v6.9.15: visual snapshot — top 5 opportunity bars */}
              {opportunities.length > 0 && (
                <div className="mb-4 rounded-lg bg-background/30 border border-border/40 px-3 py-2.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-400/80 mb-2">📊 Top 5 by Score</div>
                  <div className="space-y-2">
                    {[...opportunities].sort((a, b) => b.score - a.score).slice(0, 5).map(opp => (
                      <div key={opp.category} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 truncate text-[11px] text-muted-foreground text-right">{opp.categoryLabel}</span>
                        <div className="flex-1 h-3.5 rounded-full bg-background/60 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${opp.score > 60 ? 'bg-emerald-500/70' : opp.score > 40 ? 'bg-amber-500/70' : 'bg-slate-500/50'}`}
                            style={{ width: `${opp.score}%` }}
                          />
                        </div>
                        <span className={`w-7 shrink-0 text-right text-[11px] font-bold tabular-nums ${opp.score > 60 ? 'text-emerald-400' : opp.score > 40 ? 'text-amber-400' : 'text-muted-foreground'}`}>{opp.score}</span>
                        <span className="w-24 shrink-0 text-[10px] text-muted-foreground">{opp.existing} exist{opp.gap != null && opp.gap > 0 ? ` · +${opp.gap}` : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {aiAnalysis ? (
                <div className="space-y-4">
                  {/* Insights */}
                  {aiAnalysis.insights.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400/80 mb-1.5">Key Insights</div>
                      <div className="space-y-2">
                        {aiAnalysis.insights.map((ins, i) => (
                          <div key={i} className="flex gap-2.5 items-start rounded-lg bg-background/40 px-3 py-2 border border-border/50">
                            <span className={`mt-0.5 shrink-0 inline-block h-2 w-2 rounded-full ${ins.severity === 'high' ? 'bg-red-400' : ins.severity === 'medium' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-foreground">
                                {ins.title}
                                {ins.severity === 'high' && <span className="ml-1.5 text-[10px] text-red-400 font-bold">HIGH</span>}
                              </div>
                              {ins.categories && ins.categories.length > 0 && (
                                <div className="text-[10px] text-muted-foreground mt-0.5">
                                  Categories: {ins.categories.map(c => getCategoryLabel(c)).join(', ')}
                                </div>
                              )}
                              <div className="text-xs text-muted-foreground leading-relaxed mt-0.5">{ins.detail}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* v6.9.15: gap chart — existing vs expected for top-gap categories */}
                  {aiAnalysis.insights.length > 0 && (() => {
                    const gapRows = opportunities
                      .filter(o => o.gap != null && o.gap > 0)
                      .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
                      .slice(0, 5);
                    if (gapRows.length === 0) return null;
                    const maxVal = Math.max(...gapRows.map(o => Math.max(o.existing + (o.gap ?? 0), 1)));
                    return (
                      <div className="rounded-lg bg-background/30 border border-border/40 px-3 py-2.5">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-400/80 mb-2">📉 Supply Gap — existing vs expected</div>
                        <div className="space-y-2">
                          {gapRows.map(o => {
                            const expected = o.existing + (o.gap ?? 0);
                            return (
                              <div key={o.category} className="flex items-center gap-2">
                                <span className="w-20 shrink-0 truncate text-[11px] text-muted-foreground text-right">{o.categoryLabel}</span>
                                <div className="flex-1 h-3.5 rounded-full bg-background/60 overflow-hidden relative">
                                  <div className="h-full bg-sky-500/40" style={{ width: `${(expected / maxVal) * 100}%` }} />
                                  <div className="absolute top-0 left-0 h-full bg-sky-500/80" style={{ width: `${(o.existing / maxVal) * 100}%` }} />
                                </div>
                                <span className="w-28 shrink-0 text-[10px] text-muted-foreground tabular-nums">
                                  {fmtNum(o.existing)}/{fmtNum(expected)} <span className="text-emerald-400">(+{fmtNum(o.gap)})</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-sky-500/80" /> exist now</span>
                          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-sky-500/40" /> expected (benchmark)</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Patterns */}
                  {aiAnalysis.patterns.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-400/80 mb-1.5">🔍 Detected Patterns</div>
                      <div className="grid sm:grid-cols-2 gap-2">
                        {aiAnalysis.patterns.map((p, i) => (
                          <div key={i} className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2">
                            <div className="text-xs font-semibold text-cyan-200">{p.name}</div>
                            <div className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{p.description}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Risks */}
                  {aiAnalysis.risks.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-400/80 mb-1.5">⚠️ Risks & Caveats</div>
                      <ul className="space-y-1">
                        {aiAnalysis.risks.map((r, i) => (
                          <li key={i} className="text-xs text-muted-foreground leading-relaxed flex gap-2">
                            <span className="text-amber-400/70 shrink-0">•</span>
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Actions */}
                  {aiAnalysis.actions.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-400/80 mb-1.5">🎯 Recommended Actions</div>
                      <div className="space-y-2">
                        {aiAnalysis.actions.map((a, i) => (
                          <div key={i} className="flex gap-2.5 items-start rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-2">
                            <span className="shrink-0 mt-0.5 text-xs text-violet-300 font-bold">{i + 1}</span>
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-foreground">
                                {a.action}
                                {a.timeframe && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 font-normal">{a.timeframe}</span>}
                              </div>
                              <div className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{a.rationale}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">
                  {aiInsights.split('\n').map((line, i) => (
                    <p key={i} className="mb-2" dangerouslySetInnerHTML={{ __html: escapeHtml(line).replace(/\*\*(.*?)\*\*/g, '<strong class="text-foreground">$1</strong>') }} />
                  ))}
                </div>
              )}

              {/* v6.9.2: AI verification pass results */}
              {aiVerification && aiVerification.checked > 0 && (
                <div className="mt-4 pt-3 border-t border-emerald-500/20">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                      aiVerification.aiVerified
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                        : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                    }`}>
                      {aiVerification.aiVerified ? '✓ AI-VERIFIED' : '⚠ RULES-CHECKED'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {aiVerification.checked} count{aiVerification.checked > 1 ? 's' : ''} flagged by plausibility bands, {aiVerification.notes.length} re-reviewed{aiVerification.aiVerified ? ' by the model' : ''}
                    </span>
                  </div>
                  {aiVerification.notes.length > 0 && (
                    <ul className="space-y-1 mt-1.5">
                      {aiVerification.notes.map((n, i) => (
                        <li key={i} className="text-[11px] text-muted-foreground leading-relaxed flex gap-2">
                          <span className="text-emerald-400/70 shrink-0">✓</span>
                          <span>{n}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Map */}
          {/* Map + Business Panel */}
          <div className="rounded-xl border border-border bg-card">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {selectedOppCategory
                  ? `${getCategoryLabel(selectedOppCategory)} Map · ${categoryBusinesses.length} locations`
                  : `Competition Map · ${fmtNum(allBizCount)} businesses`}
              </h3>
              <div className="flex gap-2 flex-wrap items-center">
                {selectedOppCategory && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{background: (CAT_COLORS[selectedOppCategory] || '#94a3b8') + '22', color: CAT_COLORS[selectedOppCategory] || '#94a3b8'}}>
                    {getCategoryLabel(selectedOppCategory)}
                  </span>
                )}
                {selectedBiz && (
                  <button onClick={() => setSelectedBiz(null)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">✕ Close panel</button>
                )}
              </div>
            </div>
            <div className="flex flex-col">
              <div ref={mapRef} className="h-[420px] w-full map-container" />
              {selectedBiz && (
                <div ref={bizPanelRef} className="border-t border-border bg-card/80 backdrop-blur-sm px-3 py-2">
                  {/* Desktop: rich card */}
                  <div className="hidden sm:flex items-start gap-3 text-xs">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm flex-shrink-0" style={{background: selectedBiz.color + '22', color: selectedBiz.color}}>
                      {selectedBiz.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-semibold text-foreground truncate">{selectedBiz.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{background: selectedBiz.color + '22', color: selectedBiz.color}}>{selectedBiz.categoryLabel}</span>
                        {selectedBiz.rating > 0 && <span className="text-[10px] text-yellow-400">★ {selectedBiz.rating.toFixed(1)}{selectedBiz.reviewCount > 0 ? ` (${selectedBiz.reviewCount})` : ''}</span>}
                      </div>
                      {selectedBiz.address && <div className="text-muted-foreground truncate">📍 {selectedBiz.address}</div>}
                      {selectedBiz.hours && <div className="text-[11px] text-muted-foreground truncate">🕐 {selectedBiz.hours}</div>}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                        {selectedBiz.phone && <a href={'tel:' + selectedBiz.phone} className="text-blue-400 hover:underline">📞 {selectedBiz.phone}</a>}
                        {selectedBiz.email && <a href={'mailto:' + selectedBiz.email} className="text-blue-400 hover:underline truncate max-w-[180px]">✉️ {selectedBiz.email}</a>}
                        {selectedBiz.website && <a href={selectedBiz.website} target="_blank" className="text-blue-400 hover:underline truncate max-w-[180px]">🌐 {selectedBiz.website.replace(/^https?:\/\//, '').substring(0, 30)}</a>}
                      </div>
                      <div className="flex gap-2 mt-0.5">
                        {selectedBiz.facebook && <a href={selectedBiz.facebook} target="_blank" className="text-blue-500 hover:underline">FB</a>}
                        {selectedBiz.instagram && <a href={selectedBiz.instagram} target="_blank" className="text-pink-400 hover:underline">IG</a>}
                        {selectedBiz.linkedin && <a href={selectedBiz.linkedin} target="_blank" className="text-blue-300 hover:underline">LI</a>}
                        {selectedBiz.youtube && <a href={selectedBiz.youtube} target="_blank" className="text-red-400 hover:underline">YT</a>}
                        {selectedBiz.tiktok && <a href={selectedBiz.tiktok} target="_blank" className="text-white hover:underline">TT</a>}
                        {selectedBiz.twitter && <a href={selectedBiz.twitter} target="_blank" className="text-sky-400 hover:underline">X</a>}
                        {selectedBiz.pinterest && <a href={selectedBiz.pinterest} target="_blank" className="text-red-400 hover:underline">Pin</a>}
                        <a href={`https://www.google.com/maps/search/?api=1&query=${selectedBiz.lat},${selectedBiz.lon}`} target="_blank" className="text-emerald-400 hover:underline ml-auto">📍 Maps</a>
                      </div>
                    </div>
                    <button onClick={() => setSelectedBiz(null)} className="text-muted-foreground hover:text-foreground flex-shrink-0">✕</button>
                  </div>
                  {/* Mobile: stacked rows */}
                  <div className="sm:hidden">
                    <div className="flex items-center gap-2 text-xs mb-1">
                      <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{background: selectedBiz.color}} />
                      <span className="font-semibold text-foreground truncate flex-1">{selectedBiz.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{background: selectedBiz.color + '22', color: selectedBiz.color}}>{selectedBiz.categoryLabel}</span>
                      <button onClick={() => setSelectedBiz(null)} className="text-muted-foreground hover:text-foreground flex-shrink-0 text-sm">✕</button>
                    </div>
                    {selectedBiz.address && <div className="text-[11px] text-muted-foreground truncate pl-4 mb-0.5">📍 {selectedBiz.address}</div>}
                    <div className="flex flex-col gap-0.5 text-xs pl-4">
                      {selectedBiz.phone && <a href={'tel:' + selectedBiz.phone} className="text-blue-400 hover:underline">📞 {selectedBiz.phone}</a>}
                      {selectedBiz.email && <a href={'mailto:' + selectedBiz.email} className="text-blue-400 hover:underline truncate">✉️ {selectedBiz.email}</a>}
                      {selectedBiz.website && <a href={selectedBiz.website} target="_blank" className="text-blue-400 hover:underline truncate">🌐 {selectedBiz.website.replace(/^https?:\/\//, '').substring(0, 35)}</a>}
                    </div>
                    <div className="flex gap-2 text-[11px] pl-4 mt-0.5">
                      {selectedBiz.facebook && <a href={selectedBiz.facebook} target="_blank" className="text-blue-500 hover:underline">FB</a>}
                      {selectedBiz.instagram && <a href={selectedBiz.instagram} target="_blank" className="text-pink-400 hover:underline">IG</a>}
                      {selectedBiz.linkedin && <a href={selectedBiz.linkedin} target="_blank" className="text-blue-300 hover:underline">LI</a>}
                      {selectedBiz.youtube && <a href={selectedBiz.youtube} target="_blank" className="text-red-400 hover:underline">YT</a>}
                      {selectedBiz.tiktok && <a href={selectedBiz.tiktok} target="_blank" className="text-white hover:underline">TT</a>}
                      {selectedBiz.twitter && <a href={selectedBiz.twitter} target="_blank" className="text-sky-400 hover:underline">X</a>}
                      {selectedBiz.pinterest && <a href={selectedBiz.pinterest} target="_blank" className="text-red-400 hover:underline">Pin</a>}
                      <a href={`https://www.google.com/maps/search/?api=1&query=${selectedBiz.lat},${selectedBiz.lon}`} target="_blank" className="text-emerald-400 hover:underline ml-auto">📍 Maps</a>
                    </div>
                  </div>
                </div>
              )}
            </div>
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
                  <div className="text-2xl font-bold">{selectedOpp.expected != null ? fmtNum(selectedOpp.expected) : '—'}</div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <div className="text-xs text-muted-foreground">Supply Gap</div>
                  <div className={`text-2xl font-bold ${selectedOpp.gap != null && selectedOpp.gap > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {selectedOpp.gap != null && selectedOpp.gap > 0 ? '+' : ''}{selectedOpp.gap != null ? fmtNum(selectedOpp.gap) : 'n/a'}
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
            <div className="rounded-xl border border-border bg-card">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-4">
                <h3 className="text-sm font-semibold">
                  {getCategoryLabel(selectedOppCategory)} Businesses · {categoryBusinesses.length} found
                </h3>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    value={bizSearch}
                    onChange={e => setBizSearch(e.target.value)}
                    placeholder="Search businesses…"
                    className="h-8 w-48 rounded-lg border border-border bg-background px-3 text-xs outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={() => {
                      if (selectedOppCategory) {
                        setSelectedCategory(selectedOppCategory);
                        // Trigger full analysis with enrichment after state updates
                        setTimeout(() => {
                          if (selectedCity && selectedOppCategory) {
                            const ac = new AbortController();
                            abortRef.current = ac;
                            setCancelSignal(ac.signal);
                            setLoading(true);
                            setError('');
                            setBusinesses(new Map());
                            setOpportunities([]);
                            setDemandSignals(new Map());
                            setEnrichProgress(null);
                            setLoadingStage(`Enriching ${getCategoryLabel(selectedOppCategory)}…`);
                            setProgress(5);
                            setScanContext(buildScanContext(selectedCity.countryCode, selectedCity.country, selectedCity.name));
                            queryBusinesses(
                              selectedCity.lat, selectedCity.lon, 10000,
                              (pct, msg) => { setProgress(Math.max(pct, 5)); setLoadingStage(msg); },
                              selectedOppCategory, false,
                              (ep) => setEnrichProgress(ep)
                            ).then(biz => {
                              setBusinesses(biz);
                              setProgress(45);
                              setLoadingStage('Analyzing demand signals…');
                              return getDemandSignals(getCategoryLabel(selectedOppCategory), selectedCity.name).then(sig => {
                                const signals = new Map<string, DemandSignal>();
                                signals.set(selectedOppCategory, sig);
                                setDemandSignals(signals);
                                setProgress(80);
                                setLoadingStage('Computing opportunity scores…');
                                const opps = computeOpportunities(biz, selectedCity.population || 0, signals);
                                setOpportunities(opps);
                                setSelectedOppCategory(selectedOppCategory);
                                setProgress(100);
                                setLoading(false);
                                setLoadingStage('');
                              });
                            }).catch((e: any) => {
                              if (e.message !== 'Cancelled') setError(e.message || 'Enrichment failed');
                              setLoading(false);
                              setLoadingStage('');
                            }).finally(() => {
                              abortRef.current = null;
                              setCancelSignal(null);
                            });
                          }
                        }, 100);
                      }
                    }}
                    className="h-8 inline-flex items-center gap-1.5 rounded-lg bg-amber-600/20 px-3 text-xs font-medium text-amber-400 hover:bg-amber-600/30 transition-colors whitespace-nowrap"
                  >
                    🔍 Enrich Contacts
                  </button>
                  <button
                    onClick={downloadCSV}
                    className="h-8 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/20 px-3 text-xs font-medium text-emerald-400 hover:bg-emerald-600/30 transition-colors whitespace-nowrap"
                  >
                    ⬇️ Export CSV
                  </button>
                </div>
              </div>
              {/* ── Contact coverage summary (v6.9.1) ── */}
              {filteredBiz.length > 0 && (
                <div className="px-5 py-2.5 border-b border-border bg-muted/30 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                  <span className="text-muted-foreground">Contact data ({contactStats.n} businesses):</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-emerald-400 font-semibold">{contactStats.pct(contactStats.anyContact)}%</span>
                    <span className="text-muted-foreground">have any contact</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-blue-400 font-semibold">📞 {contactStats.phones}</span>
                    <span className="text-muted-foreground">phones ({contactStats.pct(contactStats.phones)}%)</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-amber-400 font-semibold">✉️ {contactStats.emails}</span>
                    <span className="text-muted-foreground">emails ({contactStats.pct(contactStats.emails)}%)</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-purple-400 font-semibold">🌐 {contactStats.websites}</span>
                    <span className="text-muted-foreground">websites ({contactStats.pct(contactStats.websites)}%)</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-pink-400 font-semibold">🔗 {contactStats.socials}</span>
                    <span className="text-muted-foreground">socials ({contactStats.pct(contactStats.socials)}%)</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-emerald-400 font-semibold">★ {contactStats.full}</span>
                    <span className="text-muted-foreground">full trio (phone+email+site)</span>
                  </span>
                </div>
              )}
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
                    {filteredBiz.slice(0, bizTableLimit).map((b, i) => {
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
                              {b.linkedin && <a href={b.linkedin} target="_blank" rel="noopener" className="text-sky-400 hover:underline text-[11px]">LinkedIn</a>}
                              {b.youtube && <a href={b.youtube} target="_blank" rel="noopener" className="text-red-400 hover:underline text-[11px]">YouTube</a>}
                              {b.tiktok && <a href={b.tiktok} target="_blank" rel="noopener" className="text-slate-300 hover:underline text-[11px]">TikTok</a>}
                              {(!b.facebook && !b.instagram && !b.linkedin && !b.youtube && !b.tiktok) && <span className="text-muted-foreground">—</span>}
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
              {/* Lazy table rendering: render ≤200 rows initially; a huge
                  table (10k+ rows) froze the main thread for seconds. The
                  "Show all" button renders the rest — same data, no loss. */}
              {filteredBiz.length > bizTableLimit && (
                <div className="py-3 text-center border-t border-border">
                  <button
                    onClick={() => setBizTableLimit(l => l + 500)}
                    className="text-sm text-primary hover:underline"
                  >
                    Show more ({filteredBiz.length - bizTableLimit} remaining)
                  </button>
                </div>
              )}
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
                    // v6.9.1 sanity badge: category count failed the AI
                    // plausibility check — numbers likely reflect scan
                    // coverage gaps, not the real market.
                    const sanityFlag = aiAnalysis?.sanity?.find(s => s.category === opp.category && s.verdict === 'absurd');
                    // v6.9.15: clear badge label + click-to-explain instead of hover-only title
                    const badgeLabel = sanityFlag?.kind === 'high' ? '⚠ too many' : '⚠ low data';
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
                          {sanityFlag && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setSanityDetail(sanityFlag); }}
                              title="Why is this flagged? Click for details"
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-normal hover:bg-amber-500/30 transition-colors"
                            >
                              {badgeLabel}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{fmtNum(opp.existing)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{opp.per10k}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          <span className={opp.gap != null && opp.gap > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {opp.gap != null && opp.gap > 0 ? '+' : ''}{opp.gap != null ? fmtNum(opp.gap) : '—'}
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
              Every category is counted live from OpenStreetMap data. When the area's population is known, counts are normalized
              per 10,000 residents and benchmarked against per-category baselines (live city median for unlisted categories).
              Opportunity Score = <span className="font-mono">0.45 × gap + 0.25 × citySize + 0.30 × lowCompetition + demandBonus(0-15)</span>.
              Without a known population, gap/size criteria score neutral and ranking relies on competition &amp; measured demand — no numbers are fabricated.
              Demand signals come from Wikipedia pageviews (rolling 12-month window), Reddit, and web search — counted only when successfully measured (confidence &gt; 0).
            </p>
          </div>
        </div>
      )}

      {/* v6.9.15: plausibility-flag explain modal (opens from the table badge) */}
      {sanityDetail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSanityDetail(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-amber-500/40 bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <h3 className="text-sm font-bold text-amber-300">
                ⚠ Why is “{getCategoryLabel(sanityDetail.category)}” flagged?
              </h3>
              <button onClick={() => setSanityDetail(null)} className="text-xs text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed mb-4">{sanityDetail.reason}</p>
            {sanityDetail.found != null && sanityDetail.expected != null && (
              <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Found by scan</span>
                  <span className="font-semibold text-foreground tabular-nums">{fmtNum(sanityDetail.found)}</span>
                </div>
                <div className="h-2 rounded-full bg-background overflow-hidden">
                  <div className="h-full bg-sky-500" style={{ width: `${Math.min(100, (sanityDetail.found / Math.max(sanityDetail.found, sanityDetail.expected)) * 100)}%` }} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Expected for a city this size</span>
                  <span className="font-semibold text-amber-300 tabular-nums">~{fmtNum(sanityDetail.expected)}</span>
                </div>
                <div className="h-2 rounded-full bg-background overflow-hidden">
                  <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, (sanityDetail.expected / Math.max(sanityDetail.found, sanityDetail.expected)) * 100)}%` }} />
                </div>
                <p className="text-[11px] text-muted-foreground pt-1">
                  {sanityDetail.kind === 'high'
                    ? 'The scan found more than plausible — some entries are likely mis-tagged or duplicated.'
                    : 'The scan found far fewer than plausible — most were likely missed by the data source.'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="border-t border-border py-8 mt-8">
        <div className="mx-auto max-w-7xl px-4 text-center text-xs text-muted-foreground">
          <p>Blue Ocean · Market Gap Intelligence — built on OpenStreetMap, Nominatim, Wikipedia, Wikidata</p>
          <p className="mt-1">Client SPA runs fully in your browser · No data stored · Free &amp; open source · A Next.js + FastAPI stack lives in frontend/ and backend/ for self-hosting</p>
        </div>
      </footer>
    </div>
  );
}
