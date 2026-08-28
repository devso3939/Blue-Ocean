/**
 * Blue Ocean Client Engine — v2
 * 
 * Core functionality:
 * - Resolves cities via Nominatim
 * - Fetches real businesses from OpenStreetMap Overpass API
 * - Computes opportunity scores
 * - Fetches demand signals from Wikipedia, Reddit, DuckDuckGo
 */

// ─── City Resolution ───────────────────────────────────────────────

// libphonenumber-js (free, offline): parse/validate/normalize phone numbers
import { parsePhoneNumberFromString, AsYouType } from 'libphonenumber-js';
// Native-language scan context (country → language/ccTLD/category terms)
import { setScanContext, getScanContext, buildScanContext, categoryInNative, countryTld, type ScanContext } from './lang';
export type { ScanContext };
export { setScanContext, buildScanContext };

export interface CityResult {
  name: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
  population: number | null;
  bbox: [number, number, number, number];
}

export async function resolveCity(query: string): Promise<CityResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5&extratags=1`;
  // Retry up to 3 times on rate limit (429) with backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await directFetch(url, { headers: { 'Accept': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const data = await res.json();
    if (!data.length) throw new Error(`No results found for "${query}"`);
    return data.map((r: any) => {
      const bbox = r.boundingbox.map(Number);
      const pop = r.extratags?.population ? parseInt(r.extratags.population) : null;
      return {
        name: r.address?.city || r.address?.town || r.address?.village || r.address?.municipality || r.display_name.split(',')[0],
        country: r.address?.country || '',
        countryCode: r.address?.country_code?.toUpperCase() || '',
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        population: pop,
        bbox: [bbox[0], bbox[2], bbox[1], bbox[3]],
      };
    });
  }
  throw new Error('Nominatim rate limit — try again in a few seconds');
}

// ─── Business Data ─────────────────────────────────────────────────

export interface Business {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  categoryLabel: string;
  address: string;
  phone: string;
  website: string;
  email: string;
  brand: string;
  cuisine: string;
  facebook: string;
  instagram: string;
  linkedin: string;
  youtube: string;
  tiktok: string;
  rating: number;
  reviewCount: number;
  hours: string;
  twitter: string;
  pinterest: string;
}

// ─── Enrichment Progress (real-time panel) ──────────────────────
export interface EngineStatus {
  name: string;       // e.g. 'DuckDuckGo', 'Brave', 'Bing'
  icon: string;       // e.g. '🦆', '🦁'
  status: 'idle' | 'active' | 'done' | 'error';
  found: number;      // contacts found by this engine
}

export interface EnrichmentProgress {
  activePass: string;                  // e.g. 'Pass 1: Multi-engine search'
  passNumber: number;                  // 1-7
  totalPasses: number;                 // 7
  engines: EngineStatus[];             // all engines with status
  contacts: {                          // live counters
    emails: number;
    phones: number;
    websites: number;
    social: number;
    total: number;
  };
  businessesProcessed: number;
  businessesTotal: number;
  percent: number;
  // ── New: live discovery feed ──────────────────────────────────
  recentBusinesses: RecentBusiness[];   // last ~30 businesses as they're parsed
  currentBusiness?: {                  // the one currently being processed
    id: string;
    name: string;
    engine?: string;                   // which engine is parsing it right now
    stage: 'address' | 'phone' | 'email' | 'website' | 'social' | 'done';
  };
  recentQueries: string[];             // last ~12 search queries sent (audit trail)
}

export interface RecentBusiness {
  id: string;
  name: string;
  category?: string;                   // e.g. 'cafe', 'gym'
  status: 'parsing' | 'enriched' | 'partial' | 'minimal';
  // what got found for this business
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  hasSocial: boolean;
  viaEngine?: string;                  // which engine supplied the data
  ts: number;                          // when it completed (Date.now())
}

// ── Discovery progress (Discover Opportunities — full mode, no per-business enrichment) ──
export interface DiscoveryProgress {
  phase: 'osm' | 'categorize' | 'demand' | 'score' | 'ai' | 'done';
  // OSM scanning
  osmBatches: {
    foodHealth:  { status: 'pending' | 'running' | 'done' | 'error'; found: number };
    shopsRetail: { status: 'pending' | 'running' | 'done' | 'error'; found: number };
    hotelsGyms:  { status: 'pending' | 'running' | 'done' | 'error'; found: number };
    fallback?:   { status: 'pending' | 'running' | 'done' | 'error'; found: number };
  };
  totalFound: number;
  // Demand signal collection per category (top-N)
  demand: {
    category: string;                  // category key
    label: string;                     // human label
    status: 'pending' | 'measuring' | 'done' | 'error';
    score?: number;                    // demand score 0-100
    sources?: string[];                // ['wikipedia','reddit','web'] actually measured
  }[];
  demandTotal: number;                 // total demand queries
  demandDone: number;                  // completed
  // Ranking leaderboard (top 5 so far)
  topOpps: {
    category: string;                  // category key — UI maps to color
    categoryLabel: string;
    existing: number;
    gap: number;
    score: number;
  }[];
  biggestGap?: { categoryLabel: string; gap: number; existing: number; score: number };
  // AI analysis
  ai: 'idle' | 'thinking' | 'done' | 'error';
  aiPreview?: string;                  // first insight bullet preview
  aiInsightsFull?: AIAnalysis;         // structured result (patterns/risks/actions)
  percent: number;                     // 0-100
  recentQueries: string[];             // last few demand queries
}

export const CATEGORY_QUERIES: Record<string, { label: string }> = {
  cafe: { label: 'Cafe' },
  restaurant: { label: 'Restaurant' },
  bar: { label: 'Bar' },
  pub: { label: 'Pub' },
  fast_food: { label: 'Fast Food' },
  hotel: { label: 'Hotel' },
  gym: { label: 'Gym / Fitness' },
  beauty_salon: { label: 'Beauty Salon' },
  hair_salon: { label: 'Hair Salon' },
  pharmacy: { label: 'Pharmacy' },
  hospital: { label: 'Hospital' },
  clinic: { label: 'Clinic' },
  dentist: { label: 'Dentist' },
  supermarket: { label: 'Supermarket' },
  grocery: { label: 'Grocery Store' },
  clothing: { label: 'Clothing Store' },
  electronics: { label: 'Electronics Store' },
  furniture: { label: 'Furniture Store' },
  hardware: { label: 'Hardware Store' },
  bank: { label: 'Bank' },
  school: { label: 'School' },
  cinema: { label: 'Cinema' },
  bakery: { label: 'Bakery' },
  car_repair: { label: 'Car Repair' },
  laundry: { label: 'Laundry' },
  pet_groomer: { label: 'Pet Groomer' },
  coworking: { label: 'Coworking Space' },
  library: { label: 'Library' },
  post_office: { label: 'Post Office' },
  spa: { label: 'Spa' },
  hostel: { label: 'Hostel' },
  car_rental: { label: 'Car Rental' },
  jewelry: { label: 'Jewelry Store' },
  sports: { label: 'Sports Store' },
  books: { label: 'Bookstore' },
  mobile_phone: { label: 'Mobile Phone Store' },
  convenience: { label: 'Convenience Store' },
  department_store: { label: 'Department Store' },
  ice_cream: { label: 'Ice Cream Shop' },
  art: { label: 'Art Gallery' },
  bicycle: { label: 'Bicycle Shop' },
  night_club: { label: 'Nightclub' },
  veterinary: { label: 'Veterinary' },
  florist: { label: 'Florist' },
  optician: { label: 'Optician' },
  butcher: { label: 'Butcher' },
  marketplace: { label: 'Marketplace' },
  wedding: { label: 'Wedding Venue' },
  fuel: { label: 'Gas Station' },
  web_agency: { label: 'Web Agency' }, software: { label: 'Software Company' },
  it_consulting: { label: 'IT Consulting' }, digital_marketing: { label: 'Digital Marketing' },
  lawyer: { label: 'Law Firm' }, accountant: { label: 'Accounting' },
  real_estate: { label: 'Real Estate' }, insurance: { label: 'Insurance' },
  travel_agency: { label: 'Travel Agency' }, printing: { label: 'Printing Shop' },
  nail_salon: { label: 'Nail Salon' }, tattoo: { label: 'Tattoo Parlor' },
  car_wash: { label: 'Car Wash' }, market: { label: 'Local Market' },
  dance: { label: 'Dance Studio' }, music_school: { label: 'Music School' },
  cleaning: { label: 'Cleaning Service' }, courier: { label: 'Courier Service' },
};

export function getCategoryLabel(id: string): string {
  return CATEGORY_QUERIES[id]?.label || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Categorization ────────────────────────────────────────────────

function categorizeBusiness(tags: Record<string, string>): string | null {
  const a = tags.amenity;
  const s = tags.shop;
  const t = tags.tourism;
  const l = tags.leisure;

  // ─── Shops (always businesses) ───
  if (s === 'beauty' || s === 'cosmetics') {
    // A "beauty" shop named like a nail salon is a nail salon, not a beauty salon
    const nm = (tags.name || tags['name:en'] || '').toLowerCase();
    if (/(nail|manikюр|pedikюр)/.test(nm)) return 'nail_salon';
    return 'beauty_salon';
  }
  if (s === 'hairdresser' || s === 'wigs') return 'hair_salon';
  if (s === 'tattoo' || s === 'tattoo_piercing') return 'tattoo';
  if (s === 'printing' || s === 'print') return 'printing';
  if (s === 'market') return 'market';
  if (s === 'nail_salon') return 'nail_salon';
  if (s === 'supermarket' || s === 'greengrocer' || s === 'deli') return 'supermarket';
  if (s === 'grocery' || s === 'health_food') return 'grocery';
  if (s === 'convenience' || s === 'kiosk' || s === 'newsagent') return 'convenience';
  if (s === 'clothes' || s === 'fashion' || s === 'boutique') return 'clothing';
  if (s === 'shoes' || s === 'shoe') return 'clothing';
  if (s === 'electronics' || s === 'mobile_phone' || s === 'computer' || s === 'hifi') return 'electronics';
  if (s === 'furniture' || s === 'interior_decoration') return 'furniture';
  if (s === 'doityourself' || s === 'trade' || s === 'hardware') return 'hardware';
  if (s === 'bakery' || s === 'pastry') return 'bakery';
  if (s === 'butcher') return 'butcher';
  if (s === 'florist') return 'florist';
  if (s === 'optician' || s === 'eyewear') return 'optician';
  if (s === 'car_repair' || s === 'car_parts') return 'car_repair';
  if (s === 'laundry' || s === 'dry_cleaning') return 'laundry';
  if (s === 'pet_grooming' || s === 'pet') return 'pet_groomer';
  if (s === 'jewelry' || s === 'jewellery' || s === 'watches') return 'jewelry';
  if (s === 'sports' || s === 'outdoor') return 'sports';
  if (s === 'books' || s === 'stationery') return 'books';
  if (s === 'department_store') return 'department_store';
  if (s === 'art') return 'art';
  if (s === 'bicycle') return 'bicycle';
  if (s === 'fuel') return 'fuel';

  // ─── Amenity-based ───
  if (a === 'cafe') return 'cafe';
  if (a === 'restaurant') return 'restaurant';
  if (a === 'bar' || a === 'biergarten') return 'bar';
  if (a === 'pub') return 'pub';
  if (a === 'fast_food' || a === 'food_court') return 'fast_food';
  if (a === 'ice_cream') return 'ice_cream';
  if (a === 'pharmacy' || a === 'chemist') return 'pharmacy';
  if (a === 'hospital') return 'hospital';
  if (a === 'clinic' || a === 'doctors') return 'clinic';
  if (a === 'dentist') return 'dentist';
  if (a === 'bank') return 'bank';
  if (a === 'school' || a === 'college' || a === 'university') return 'school';
  if (a === 'cinema') return 'cinema';
  if (a === 'veterinary') return 'veterinary';
  if (a === 'library') return 'library';
  if (a === 'post_office') return 'post_office';
  if (a === 'car_rental') return 'car_rental';
  if (a === 'nightclub' || a === 'casino') return 'night_club';
  if (a === 'music_school' || a === 'dancing_school' || a === 'arts_centre') return 'music_school';
  if (a === 'spa' || a === 'sauna') return 'spa';
  if (a === 'marketplace') return 'marketplace';
  if (a === 'fuel') return 'fuel';

    // Craft businesses (Georgia, Russia, CIS)
  if (tags.craft === 'bakery') return 'bakery';
  if (tags.craft === 'car_repair' || tags.craft === 'car_paint') return 'car_repair';
  if (tags.craft === 'tailor' || tags.craft === 'dressmaker') return 'clothing';
  if (tags.craft === 'jeweler') return 'jewelry';
  if (tags.craft === 'optician') return 'optician';
  if (tags.craft === 'florist') return 'florist';
  // Healthcare (UK, Germany, Scandinavia)
  if (tags.healthcare === 'dentist') return 'dentist';
  if (tags.healthcare === 'clinic' || tags.healthcare === 'doctor') return 'clinic';
  if (tags.healthcare === 'pharmacy') return 'pharmacy';
  if (tags.healthcare === 'hospital') return 'hospital';
  if (tags.healthcare === 'physiotherapist') return 'clinic';
// ─── Tourism ───
  if (t === 'hotel' || t === 'motel' || t === 'apartment') return 'hotel';
  if (t === 'hostel') return 'hostel';
  if (t === 'guest_house') return 'hotel';

  // ─── Leisure ───
  if (l === 'fitness_centre' || l === 'sports_centre' || l === 'sports_hall' || l === 'swimming_pool') {
    // Name-based split: yoga/pilates studios before the generic 'gym' bucket
    const nameLower = (tags.name || tags['name:en'] || '').toLowerCase();
    if (/(yoga|pilates)/.test(nameLower)) return 'yoga';
    return 'gym';
  }

  // ─── Amenity (car wash, etc) ───
  if (a === 'car_wash') return 'car_wash';

  // ─── Office-based businesses ───
  if (tags.office === 'coworking') return 'coworking';
  if (tags.office === 'lawyer' || tags.office === 'attorney') return 'lawyer';
  if (tags.office === 'accountant') return 'accountant';
  if (tags.office === 'estate_agent' || tags.office === 'real_estate') return 'real_estate';
  if (tags.office === 'insurance') return 'insurance';
  if (tags.office === 'travel_agent') return 'travel_agency';
  if (tags.office === 'it' || tags.office === 'software') return 'software';
  if (tags.office === 'consulting') return 'it_consulting';
  if (tags.office === 'marketing' || tags.office === 'advertising') return 'digital_marketing';
  if (tags.office === 'telecommunication') return 'web_agency';

  // ─── Name-based heuristics for new categories ───
  const nameLower = (tags.name || tags['name:en'] || '').toLowerCase();
  if (!tags.office && nameLower) {
    if (/(law|legal|attorney|advo[ck]at)/.test(nameLower)) return 'lawyer';
    if (/(account|buh|finance|audit)/.test(nameLower)) return 'accountant';
    if (/(real.?estate|property|immobili)/.test(nameLower)) return 'real_estate';
    if (/(insur|strakhov)/.test(nameLower)) return 'insurance';
    if (/(travel|tur|tour|travel)/.test(nameLower)) return 'travel_agency';
    if (/(clean|ubor|cleaning)/.test(nameLower)) return 'cleaning';
    if (/(car.?wash|moyk[ae]|автомойк)/.test(nameLower)) return 'car_wash';
    if (/(nail|manikюр|pedikюр)/.test(nameLower)) return 'nail_salon';
    if (/(yoga|pilates)/.test(nameLower)) return 'yoga';
  }

  return null;
}

// ─── Parsing Helpers ───────────────────────────────────────────────

/**
 * Extract + normalize a phone from OSM tags using libphonenumber-js.
 * OSM stores multi-numbers ';'-separated; pass countryCode (e.g. 'GE')
 * so local formats (032 2xx xx xx) resolve correctly.
 */
function extractPhone(tags: Record<string, string>, countryCode?: string): string {
  const raw = tags.phone || tags['contact:phone'] || tags['contact:mobile'] ||
              tags['phone:mobile'] || tags['phone:international'] ||
              tags['contact:landline'] || tags['contact:fax'] ||
              tags['contact:whatsapp'] || tags['contact:viber'] || '';
  if (!raw) return '';
  const first = raw.split(/[;,/]/)[0].trim();
  try {
    const cc = (countryCode || '').toLowerCase() || undefined;
    const parsed = parsePhoneNumberFromString(first, cc as any);
    if (parsed && parsed.isValid()) return parsed.formatInternational();
    // Invalid but digits exist — keep cleaned raw (better than dropping)
    if (first.replace(/\D/g, '').length >= 7) return first;
    return '';
  } catch {
    return first;
  }
}

/** Normalize any scraped phone against the scan country. */
export function normalizePhone(raw: string, countryCode?: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  try {
    const parsed = parsePhoneNumberFromString(v, (countryCode || undefined) as any);
    if (parsed && parsed.isValid()) return parsed.formatInternational();
  } catch {}
  return v;
}

function extractEmail(tags: Record<string, string>): string {
  return tags.email || tags['contact:email'] || tags['email:office'] || '';
}

function extractWebsite(tags: Record<string, string>): string {
  return tags.website || tags['contact:website'] || tags.url || '';
}

/** OSM social values may be full URLs, 'www.', bare usernames or '@user'. */
function osmSocialUrl(raw: string, base: string): string {
  if (!raw) return '';
  const v = raw.split(';')[0].trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('www.')) return `https://${v}`;
  return `${base}/${v.replace(/^@+/, '').replace(/^\/+/, '')}`;
}

function extractFacebook(tags: Record<string, string>): string {
  return osmSocialUrl(tags['contact:facebook'] || tags.facebook || '', 'https://facebook.com');
}

function extractInstagram(tags: Record<string, string>): string {
  return osmSocialUrl(tags['contact:instagram'] || tags.instagram || '', 'https://instagram.com');
}

// Extract LinkedIn from OSM tags
function extractLinkedIn(tags: Record<string, string>): string {
  return osmSocialUrl(tags['contact:linkedin'] || tags.linkedin || '', 'https://linkedin.com/company');
}

// Extract YouTube from OSM tags
function extractYouTube(tags: Record<string, string>): string {
  return osmSocialUrl(tags['contact:youtube'] || tags.youtube || '', 'https://youtube.com/@');
}

// Extract TikTok from OSM tags
function extractTikTok(tags: Record<string, string>): string {
  return osmSocialUrl(tags['contact:tiktok'] || tags.tiktok || '', 'https://tiktok.com/@');
}

// Extract Twitter/X from OSM tags (was discarded entirely before v6.5)
function extractTwitter(tags: Record<string, string>): string {
  const raw = tags['contact:twitter'] || tags.twitter || tags['contact:x'] || '';
  const u = osmSocialUrl(raw, 'https://twitter.com');
  // Normalize x.com → twitter.com for display consistency
  return u ? u.replace('//x.com/', '//twitter.com/') : '';
}

function formatAddress(tags: Record<string, string>): string {
  const parts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city'], tags['addr:postcode']].filter(Boolean);
  return parts.join(', ') || '';
}

// ─── Overpass Query ────────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  // Independent infrastructure: different operators = different rate-limit
  // pools, so heavy scans on one don't poison the others. (lz4 was removed:
  // it shares infrastructure and bans with overpass-api.de, adding a mirror
  // that is already banned just wastes the retry window.)
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

// Visibility-aware wait: when tab is hidden, browsers throttle setTimeout to 1s+.
// This function uses shorter delays when hidden so enrichment keeps moving.
function wait(ms: number): Promise<void> {
  if (isCancelled()) throw new Error('Cancelled');
  return new Promise((resolve, reject) => {
    // If tab is visible, use normal delay
    if (!document.hidden) {
      const timer = setTimeout(() => {
        if (isCancelled()) { reject(new Error('Cancelled')); return; }
        resolve();
      }, ms);
      // Also listen for cancel during the wait (listener removed when the
      // promise settles, so it doesn't accumulate across thousands of calls)
      const onAbort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
      _cancelSignal?.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => _cancelSignal?.removeEventListener('abort', onAbort), ms + 50);
      return;
    }
    // Tab is hidden: poll rapidly with short intervals so we don't get stuck
    const interval = Math.min(ms, 100);
    let elapsed = 0;
    const poll = () => {
      if (isCancelled()) { reject(new Error('Cancelled')); return; }
      elapsed += interval;
      if (elapsed >= ms || !document.hidden) { resolve(); return; }
      setTimeout(poll, interval);
    };
    setTimeout(poll, interval);
  });
}

// Global cancel signal — set by App.tsx, checked by all enrichment loops
let _cancelSignal: AbortSignal | null = null;
export function setCancelSignal(signal: AbortSignal | null) { _cancelSignal = signal; }
function isCancelled(): boolean { return _cancelSignal?.aborted ?? false; }

// ─── CORS Fetch Helper ────────────────────────────────────────────
// ─── CORS Fetch Helper ────────────────────────────────────────────
// corsproxy.io is dead. This helper:
// 1. Tries direct fetch (instant for CORS-enabled: Nominatim, Overpass, Brave)
// 2. Falls back to allorigins.win with 3s timeout (races raw + get)
// Total max wait: ~4 seconds (not 12+)
// Multi-proxy strategy: try 3 different CORS proxies in parallel
let _lastProxyFail = 0; // 30s cooldown instead of permanent block
async function corsFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...init?.headers };
  const callerSignal = init?.signal;

  // 1) Try direct fetch — instant for CORS-enabled, instant error for others
  try {
    const r = await fetch(url, { ...init, headers });
    if (r.ok) return r;
  } catch { /* CORS error */ }
  if (callerSignal?.aborted) throw new Error('Cancelled');

  // 2) If proxy failed recently (30s cooldown), skip
  if (Date.now() - _lastProxyFail < 30000) {
    return new Response('', { status: 0, statusText: 'CORS unavailable' });
  }

  // 3) Try cors.sh (working as of 2026, keyless)
  try {
    const r = await fetch('https://cors.sh/' + url, { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) return r;
  } catch {}

  // 4) Jina Reader (keyless, returns page text/markdown — good for contact
  // extraction; works from real browser sessions)
  try {
    const r = await fetch('https://r.jina.ai/' + url, { headers, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const text = await r.text();
      if (text && text.length > 100) return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
  } catch {}

  // 5) allorigins (demoted to last resort: 5xx/timeout failures observed 2026)
  try {
    const r = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url), { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const json = await r.json();
      return new Response(json.contents || '', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
  } catch {}

  _lastProxyFail = Date.now();
  return new Response('', { status: 0, statusText: 'CORS unavailable' });
}

// Direct fetch for services that support CORS (Nominatim, Overpass)
async function directFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { 'User-Agent': 'BlueOcean/5.0.0 (https://devso3939.github.io/Blue-Ocean; contact@blueocean.app)', ...init?.headers } });
}

// Map category IDs to OSM tag filters for focused queries
const CAT_OSM_FILTER: Record<string, string> = {
  cafe: '["amenity"="cafe"]',
  restaurant: '["amenity"="restaurant"]',
  bar: '["amenity"~"bar|biergarten"]',
  pub: '["amenity"="pub"]',
  fast_food: '["amenity"~"fast_food|food_court"]',
  ice_cream: '["amenity"="ice_cream"]',
  hotel: '["tourism"~"hotel|hostel|motel|apartment|guest_house"]',
  gym: '["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool"]',
  beauty_salon: '["shop"~"beauty|cosmetics|nail_salon"]',
  hair_salon: '["shop"~"hairdresser|wigs"]',
  pharmacy: '["amenity"~"pharmacy|chemist"]',
  hospital: '["amenity"="hospital"]',
  clinic: '["amenity"~"clinic|doctors"]',
  dentist: '["amenity"="dentist"]',
  supermarket: '["shop"~"supermarket|greengrocer|deli"]',
  grocery: '["shop"~"grocery|health_food"]',
  clothing: '["shop"~"clothes|fashion|boutique|shoes"]',
  electronics: '["shop"~"electronics|mobile_phone|computer|hifi"]',
  furniture: '["shop"~"furniture|interior_decoration"]',
  hardware: '["shop"~"doityourself|trade|hardware"]',
  bank: '["amenity"="bank"]',
  school: '["amenity"~"school|college|university"]',
  cinema: '["amenity"="cinema"]',
  bakery: '["shop"~"bakery|pastry"]',
  car_repair: '["shop"~"car_repair|car_parts"]',
  laundry: '["shop"~"laundry|dry_cleaning"]',
  pet_groomer: '["shop"~"pet_grooming|pet"]',
  coworking: '["office"="coworking"]',
  night_club: '["amenity"="night_club"]',
  car_rental: '["amenity"="car_rental"]',
  veterinary: '["amenity"="veterinary"]',
  florist: '["shop"="florist"]',
  optician: '["shop"~"optician|eyewear"]',
  butcher: '["shop"="butcher"]',
  marketplace: '["amenity"="marketplace"]',
  fuel: '["amenity"="fuel"]',
  department_store: '["shop"="department_store"]',
  jewelry: '["shop"~"jewelry|jewellery|watches"]',
  sports: '["shop"~"sports|outdoor"]',
  art: '["shop"="art"]',
  bicycle: '["shop"="bicycle"]',
  convenience: '["shop"~"convenience|kiosk|newsagent"]',
  spa: '["amenity"~"spa|sauna"]',
  yoga: '["leisure"="fitness_centre"]',
  bookstore: '["shop"~"books|stationery"]',
  library: '["amenity"="library"]',
  post_office: '["amenity"="post_office"]',
  // ── v3.5.0 new categories ──
  web_agency: '["office"="telecommunication"]',
  software: '["office"~"it|software"]',
  it_consulting: '["office"="consulting"]',
  digital_marketing: '["office"~"marketing|advertising"]',
  lawyer: '["office"="lawyer"]',
  accountant: '["office"="accountant"]',
  real_estate: '["office"~"estate_agent|real_estate"]',
  insurance: '["office"="insurance"]',
  travel_agency: '["office"~"travel_agent"]',
  cleaning: '["shop"="cleaning"]',
  car_wash: '["amenity"="car_wash"]',
  nail_salon: '["shop"~"beauty|nail_salon|cosmetics"]',
  massage: '["leisure"~"spa|sauna"]',
};

// Set when fetchOverpass exhausts every mirror — lets callers distinguish
// "area genuinely empty" from "Overpass never answered".
let _overpassExhausted = false;

async function fetchOverpass(query: string, timeoutSec = 60, onWait?: (msg: string) => void): Promise<any> {
  _overpassExhausted = false;
  const tryAllMirrors = async (): Promise<any> => {
    for (let mi = 0; mi < OVERPASS_MIRRORS.length; mi++) {
      const mirror = OVERPASS_MIRRORS[mi];
      // Try up to 2 attempts per mirror for main mirrors
      const attempts = mi < 2 ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), (timeoutSec + 15) * 1000);
          const res = await fetch(mirror, {
            method: 'POST',
            body: `data=${encodeURIComponent(query)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (res.status === 429 || res.status === 504) {
            // Rate limited / gateway timeout — this mirror needs a longer pause
            if (attempt < attempts - 1) await wait(10000);
            continue;
          }
          if (!res.ok) {
            if (attempt < attempts - 1) await wait(3000);
            continue;
          }
          const text = await res.text();
          if (!text.trim().startsWith('{')) {
            // Got XML error or empty — rate limited
            if (attempt < attempts - 1) await wait(5000);
            continue;
          }
          const data = JSON.parse(text);
          if (data.elements === undefined) continue;
          return data;
        } catch (e) {
          if (attempt < attempts - 1) await wait(2000);
          continue;
        }
      }
      // Wait between mirrors
      if (mi < OVERPASS_MIRRORS.length - 1) await wait(2000);
    }
    return null;
  };

  // First pass across all mirrors…
  let data = await tryAllMirrors();
  // …if everything failed, cool down and try again (typical cause: the IP is
  // rate-limited after a heavy scan; bans usually lift within a minute).
  if (!data) {
    onWait?.('OpenStreetMap servers are busy — waiting 40s before retrying…');
    await wait(40000);
    data = await tryAllMirrors();
  }
  // Still nothing? One last patient attempt — longer bans need a longer pause.
  if (!data) {
    onWait?.('Still busy — waiting 2 minutes for a final retry…');
    await wait(120000);
    data = await tryAllMirrors();
  }
  if (data) return data;

  // ── Last resort: try Overpass directly (CORS supported) ──
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75000);
    const res = await directFetch(OVERPASS_MIRRORS[0], {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const text = await res.text();
      if (text.trim().startsWith('{')) {
        const data = JSON.parse(text);
        if (data.elements !== undefined) return data;
      }
    }
  } catch {}

  _overpassExhausted = true;
  return null;
}

export async function queryBusinesses(
  lat: number,
  lon: number,
  radiusMeters: number = 10000,
  onProgress?: (pct: number, msg: string) => void,
  categoryFilter?: string,
  skipEnrichment?: boolean,
  onEnrichProgress?: (ep: EnrichmentProgress) => void,
  onDiscoverProgress?: (dp: DiscoveryProgress) => void
): Promise<Map<string, Business[]>> {
  const results = new Map<string, Business[]>();
  const south = lat - radiusMeters / 111000;
  const north = lat + radiusMeters / 111000;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const west = lon - radiusMeters / (111000 * cosLat);
  const east = lon + radiusMeters / (111000 * cosLat);
  const bbox = `${south},${west},${north},${east}`;

  // ── Tier 1: Single focused query for food/drink/healthcare ──
  const qFood = `[out:json][timeout:90][maxsize:536870912];
(
  node(${bbox})["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream"];
  way(${bbox})["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream"];
  node(${bbox})["amenity"~"pharmacy|hospital|clinic|dentist|veterinary"];
  way(${bbox})["amenity"~"pharmacy|hospital|clinic|dentist|veterinary"];
  node(${bbox})["amenity"~"bank|cinema|nightclub|car_rental|fuel|marketplace|spa|sauna|casino|music_school|dancing_school"];
  way(${bbox})["amenity"~"bank|cinema|nightclub|car_rental|fuel|marketplace|spa|sauna|casino|music_school|dancing_school"];
);
out center body;`;

  // ── Tier 1b: Shops ──
  const qShops = `[out:json][timeout:90][maxsize:536870912];
(
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;

  // ── Tier 1c: Tourism + Leisure ──
  const qOther = `[out:json][timeout:60][maxsize:268435456];
(
  node(${bbox})["tourism"~"hotel|hostel|motel|apartment|guest_house"];
  way(${bbox})["tourism"~"hotel|hostel|motel|apartment|guest_house"];
  node(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool|spa|sauna"];
  way(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool|spa|sauna"];
  node(${bbox})["office"];
  way(${bbox})["office"];
  node(${bbox})["craft"];
  way(${bbox})["craft"];
  node(${bbox})["healthcare"];
  way(${bbox})["healthcare"];
);
out center body;`;

  const allElements: any[] = [];

  // ── Discovery progress tracker (only used by Discover Opportunities full mode) ──
  const isFullMode = !categoryFilter || !CAT_OSM_FILTER[categoryFilter];
  const _dp: DiscoveryProgress = {
    phase: 'osm',
    osmBatches: {
      foodHealth:  { status: 'pending', found: 0 },
      shopsRetail: { status: 'pending', found: 0 },
      hotelsGyms:  { status: 'pending', found: 0 },
    },
    totalFound: 0,
    demand: [],
    demandTotal: 0,
    demandDone: 0,
    topOpps: [],
    ai: 'idle',
    percent: 0,
    recentQueries: [],
  };
  function emitDP(overrides?: Partial<DiscoveryProgress>) {
    if (!onDiscoverProgress) return;
    onDiscoverProgress({ ..._dp, ...overrides,
      osmBatches: { ..._dp.osmBatches },
      demand: _dp.demand.slice(),
      topOpps: _dp.topOpps.slice(),
      recentQueries: _dp.recentQueries.slice(),
    });
  }

  // ── FOCUSED MODE: Single category query (much faster) ──
  if (categoryFilter && CAT_OSM_FILTER[categoryFilter]) {
    const filter = CAT_OSM_FILTER[categoryFilter];
    const qFocused = `[out:json][timeout:90][maxsize:536870912];
(
  node(${bbox})${filter};
  way(${bbox})${filter};
);
out center body;`;
    onProgress?.(10, `Scanning for ${getCategoryLabel(categoryFilter)}…`);
    const d = await fetchOverpass(qFocused, 90, (msg) => onProgress?.(15, msg));
    if (d?.elements) allElements.push(...d.elements);

    // Fallback: the focused tag can exist yet categorize into a different
    // bucket (e.g. leisure=fitness_centre -> 'gym' when scanning for 'yoga',
    // shop=beauty -> 'beauty_salon' when scanning for 'spa'/'nail_salon').
    // Retry broadly unless at least one element lands in the requested category.
    const hasRequestedCategory = allElements.some(
      el => categorizeBusiness(el.tags || {}) === categoryFilter
    );
    if (!hasRequestedCategory) {
      onProgress?.(50, 'Retrying with broader query…');
      const qBroad = `[out:json][timeout:60][maxsize:268435456];
(
  node(${bbox})["amenity"];
  way(${bbox})["amenity"];
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;
      const d2 = await fetchOverpass(qBroad, 60, (msg) => onProgress?.(55, msg));
      if (d2?.elements) allElements.push(...d2.elements);
    }
  } else {
    // ── FULL MODE: All categories (for Discover Opportunities) ──
    _dp.osmBatches.foodHealth.status = 'running';
    emitDP({ percent: 8 });
    onProgress?.(10, 'Scanning food, healthcare & entertainment…');
    const d1 = await fetchOverpass(qFood, 90, (msg) => onProgress?.(15, msg));
    if (d1?.elements) allElements.push(...d1.elements);
    _dp.osmBatches.foodHealth = { status: d1 ? 'done' : 'error', found: allElements.length };
    _dp.totalFound = allElements.length;
    emitDP({ percent: 22 });

    await wait(1500);
    _dp.osmBatches.shopsRetail.status = 'running';
    emitDP({ percent: 25 });
    onProgress?.(30, 'Scanning shops & retail…');
    const d2 = await fetchOverpass(qShops, 90, (msg) => onProgress?.(35, msg));
    if (d2?.elements) allElements.push(...d2.elements);
    _dp.osmBatches.shopsRetail = { status: d2 ? 'done' : 'error', found: allElements.length - _dp.osmBatches.foodHealth.found };
    _dp.totalFound = allElements.length;
    emitDP({ percent: 38 });

    await wait(1500);
    _dp.osmBatches.hotelsGyms.status = 'running';
    emitDP({ percent: 42 });
    onProgress?.(50, 'Scanning hotels, gyms & services…');
    const d3 = await fetchOverpass(qOther, 60, (msg) => onProgress?.(55, msg));
    if (d3?.elements) allElements.push(...d3.elements);
    _dp.osmBatches.hotelsGyms = { status: d3 ? 'done' : 'error', found: allElements.length - _dp.osmBatches.foodHealth.found - _dp.osmBatches.shopsRetail.found };
    _dp.totalFound = allElements.length;
    emitDP({ percent: 55 });

    // ── Tier 2: Fallback ──
    if (allElements.length === 0) {
      _dp.osmBatches.fallback = { status: 'running', found: 0 };
      emitDP({ percent: 60 });
      onProgress?.(60, 'Retrying with minimal query…');
      const qMin = `[out:json][timeout:60];
(
  node(${bbox})["amenity"];
  way(${bbox})["amenity"];
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;
      const d4 = await fetchOverpass(qMin, 60, (msg) => onProgress?.(65, msg));
      if (d4?.elements) allElements.push(...d4.elements);
      _dp.osmBatches.fallback = { status: d4 ? 'done' : 'error', found: allElements.length };
      _dp.totalFound = allElements.length;
      emitDP({ percent: 65 });
    }
  }

  onProgress?.(60, 'Categorizing businesses…');

  if (allElements.length === 0) {
    // Distinguish "genuinely empty area" from "Overpass never answered" —
    // previously both surfaced as 'No businesses found'.
    const rateLimited = _overpassExhausted;
    onProgress?.(70, rateLimited
      ? 'OpenStreetMap servers could not be reached (rate limited or busy). Please retry in a minute.'
      : 'No businesses found from OpenStreetMap');
    if (rateLimited) throw new Error('OpenStreetMap servers are rate-limiting requests. Wait a minute and retry.');
    return results;
  }

  const seenLocations = new Map<string, string>();
  // Detect the local language from Overpass data itself: the most frequent
  // `name:xx` key among results is the working local language. This refines
  // the static country→language map (handles bilingual areas dynamically).
  const langFreq = new Map<string, number>();
  const ctx = getScanContext();
  for (const el of allElements) {
    const t = el.tags || {};
    for (const k of Object.keys(t)) {
      const m = k.match(/^name:([a-z]{2})$/);
      if (m && m[1] !== 'en') langFreq.set(m[1], (langFreq.get(m[1]) || 0) + 1);
    }
  }
  if (ctx) {
    let best = '', bestN = 0;
    langFreq.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
    if (best && best !== ctx.lang && bestN >= 3) (ctx as any).lang = best;
  }

  for (const el of allElements) {
    const elLat = el.lat || el.center?.lat;
    const elLon = el.lon || el.center?.lon;
    if (!elLat || !elLon) continue;

    const tags = el.tags || {};
    const category = categorizeBusiness(tags);
    if (!category) continue;

    // Must have a name to count as a real business
    const name = tags.name || tags['name:en'] || tags['name:int'] || tags.brand || tags.operator || '';
    if (!name.trim()) continue;

    // Dedup by location + category (1m precision)
    const locKey = `${Math.round(elLat * 1000)},${Math.round(elLon * 1000)},${category}`;
    if (seenLocations.has(locKey)) continue;
    seenLocations.set(locKey, category);

    const business: Business = {
      id: `${el.type}/${el.id}`,
      name: name.trim(),
      lat: elLat,
      lon: elLon,
      category,
      categoryLabel: getCategoryLabel(category),
      address: formatAddress(tags),
      phone: extractPhone(tags, ctx?.countryCode),
      website: extractWebsite(tags),
      email: extractEmail(tags),
      brand: tags.brand || '',
      cuisine: tags.cuisine || '',
      facebook: extractFacebook(tags),
      instagram: extractInstagram(tags),
      linkedin: extractLinkedIn(tags),
      youtube: extractYouTube(tags),
      tiktok: extractTikTok(tags),
      rating: 0,
      reviewCount: 0,
      hours: tags.opening_hours || '',
      twitter: extractTwitter(tags),
      pinterest: '',
    };

    if (!results.has(category)) results.set(category, []);
    results.get(category)!.push(business);
  }

  const totalBiz = Array.from(results.values()).reduce((s, a) => s + a.length, 0);
  onProgress?.(70, `Found ${totalBiz} businesses — enriching data…`);



// ─── Social Platform Deep Search ──────────────────────────────
// Searches for business presence on LinkedIn, YouTube, Twitter, TikTok, Pinterest
async function enrichFromSocialPlatforms(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS = businesses.filter(b => !b.facebook && !b.instagram);
  if (NEEDS.length === 0) return;
  const BATCH = 3;
  const max = Math.min(NEEDS.length, 80);
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const cityEn = getEnglishCityName(b.address?.split(',').pop()?.trim() || '');
        const nameEn2 = getEnglishCityName(b.name);
        const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
        const streetEn = getEnglishCityName(street);
        const parts = ["'" + (nameEn2 || b.name) + "'"];
        if (streetEn && streetEn !== street) parts.push(streetEn);
        if (cityEn) parts.push(cityEn);
        parts.push('facebook instagram linkedin youtube tiktok social media');
        const q = encodeURIComponent(parts.join(' '));
        const r = await corsFetch('https://html.duckduckgo.com/html/?q=' + q, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return;
        const html = await r.text();
        // LinkedIn
        // LinkedIn
        if (!b.linkedin) {
          const liMatch = html.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
          if (liMatch && !liMatch[0].includes('login')) {
            b.linkedin = 'https://linkedin.com/company/' + liMatch[1];
          }
        }
        // Twitter/X
        // TikTok
        if (!b.website) {
          const ttMatch = html.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
          if (ttMatch && !ttMatch[0].includes('login')) {
            b.website = 'https://tiktok.com/@' + ttMatch[1];
            found++;
          }
        }
        // LinkedIn company page
        if (!b.website) {
          const liMatch = html.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
          if (liMatch && !liMatch[0].includes('login')) {
            b.website = 'https://linkedin.com/company/' + liMatch[1];
            found++;
          }
        }
        // YouTube
        const ytMatch = html.match(/youtube\.com\/(channel\/[^"&]+|@[^"&\s]+)/i);
        if (ytMatch && !b.website) {
          b.website = 'https://' + ytMatch[0].replace(/\/$/, '');
          found++;
        }
        // Extract any social links found
        if (!b.facebook) {
          const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
          if (fbM && !fbM[0].includes('login') && !fbM[0].includes('sharer')) {
            b.facebook = 'https://facebook.com/' + fbM[1].replace(/\/$/, '');
            found++;
          }
        }
        if (!b.instagram) {
          const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
          if (igM && !igM[0].includes('accounts')) {
            b.instagram = 'https://instagram.com/' + igM[1].replace(/\/$/, '');
            found++;
          }
        }
        // Extract phone from social media descriptions
        if (!b.phone) {
          const phM = html.match(/\+?[\d][\d\s\-\.()]{7,18}/);
          if (phM && phM[0].length >= 8) {
            const digits = phM[0].replace(/[^\d+]/g, '');
            if (digits.length >= 8) { b.phone = phM[0].trim(); found++; }
          }
        }
        // Extract email from social descriptions
        if (!b.email) {
          const emM = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emM && !emM[0].includes('example.com') && !emM[0].includes('duckduckgo')) {
            b.email = emM[0]; found++;
          }
        }
      } catch {}
    }));
    if (i + BATCH < max) await wait(2000);
    onProgress?.(86, `Social platforms… ${Math.min(i + BATCH, max)}/${max} (${found} found)`);
  }
}


// ─── Enhanced Website Scraper (JSON-LD, OpenGraph, deep contact) ──
async function enrichFromWebsiteDeep(b: Business): Promise<void> {
  if (!b.website) return;
  const EXCLUDE = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com/i;

  async function deepScrape(url: string): Promise<void> {
    try {
      // Try direct fetch first (most websites work from browser)
      let r: Response;
      try {
        r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
      } catch {
        r = await corsFetch(url, { signal: AbortSignal.timeout(5000) });
      }
      if (!r.ok) return;
      const html = await r.text();
      const full = html.substring(0, 80000);

      // 1. JSON-LD structured data extraction (schema.org/LocalBusiness)
      if (!b.phone || !b.email || !b.website) {
        const jsonLdBlocks = full.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        for (const match of jsonLdBlocks) {
          try {
            const data = JSON.parse(match[1]);
            const entities = Array.isArray(data) ? data : [data];
            for (const entity of entities) {
              const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']];
              if (types.some((t: string) => /LocalBusiness|Restaurant|Bar|Cafe|Store|Hotel|Organization/i.test(t || ''))) {
                if (!b.phone && entity.telephone) b.phone = entity.telephone;
                if (!b.email && entity.email) b.email = entity.email;
                if (!b.website && entity.url && !EXCLUDE.test(entity.url)) b.website = entity.url;
                if (!b.facebook && entity.sameAs) {
                  const sameAs = Array.isArray(entity.sameAs) ? entity.sameAs : [entity.sameAs];
                  for (const s of sameAs) {
                    if (typeof s === 'string') {
                      if (/facebook\.com/i.test(s) && !b.facebook) b.facebook = s;
                      if (/instagram\.com/i.test(s) && !b.instagram) b.instagram = s;
                    }
                  }
                }
                if (entity.address && !b.address) {
                  const a = entity.address;
                  if (typeof a === 'string') b.address = a;
                  else if (a.streetAddress) b.address = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
                }
              }
            }
          } catch {}
        }
      }

      // 2. Open Graph meta tags
      if (!b.email || !b.phone) {
        const ogTags = full.matchAll(/<meta[^>]*(?:property|name)="(og:[^"]+)"[^>]*content="([^"]*)"/gi);
        for (const m of ogTags) {
          const prop = m[1].toLowerCase();
          const val = m[2];
          if (!b.email && prop === 'og:email') { b.email = val.replace('mailto:', ''); }
          if (!b.phone && prop === 'og:phone') { b.phone = val; }
        }
      }

      // 3. Phone from tel: links or structured text
      if (!b.phone) {
        const telMatch = full.match(/href="tel:([^"]+)"/);
        if (telMatch) b.phone = telMatch[1].trim();
        else {
          // Look for phone in structured areas (footer, header, contact section)
          const phoneText = full.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
          if (phoneText) {
            for (const p of phoneText) {
              if (p.replace(/[^\d+]/g, '').length >= 8 && p.replace(/[^\d+]/g, '').length <= 15) {
                b.phone = p.trim(); break;
              }
            }
          }
        }
      }

      // 4. Email — multiple strategies
      if (!b.email) {
        // a. mailto: links
        const mailtoMatch = full.match(/href="mailto:([^"?\s]+)/i);
        if (mailtoMatch && !EXCLUDE.test(mailtoMatch[1])) b.email = mailtoMatch[1].trim();
        // b. email in text
        if (!b.email) {
          const emails = full.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, '');
              if (!EXCLUDE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
            }
          }
        }
        // c. Cloudflare encoded emails
        if (!b.email) {
          const encoded = full.match(/data-cfemail="([a-f0-9]+)"/i);
          if (encoded) {
            try {
              const bytes = encoded[1].match(/.{2}/g)!.map(h => parseInt(h, 16));
              const key = bytes[0];
              const decoded = bytes.slice(1).map(b => b ^ key).map(b => String.fromCharCode(b)).join('');
              if (decoded.includes('@') && !EXCLUDE.test(decoded)) b.email = decoded;
            } catch {}
          }
        }
        // d. Encoded with &#64; (HTML entity for @)
        if (!b.email) {
          const encodedAt = full.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          if (encodedAt && !EXCLUDE.test(encodedAt[0])) b.email = encodedAt[1] + '@' + encodedAt[2];
        }
      }

      // 5. Facebook — multiple patterns
      if (!b.facebook) {
        const fbPatterns = [
          /facebook\.com\/([a-zA-Z0-9._]+)/i,
          /fb\.com\/([a-zA-Z0-9._]+)/i,
          /facebook\.com\/pages\/[^/]+\/(\d+)/i,
        ];
        for (const pat of fbPatterns) {
          const m = full.match(pat);
          if (m && !m[0].includes('login') && !m[0].includes('sharer') && !m[0].includes('dialog')) {
            b.facebook = 'https://facebook.com/' + m[1].replace(/\/$/, '');
            break;
          }
        }
      }

      // 6. Instagram
      if (!b.instagram) {
        const igMatch = full.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
        if (igMatch && !igMatch[0].includes('accounts') && !igMatch[0].includes('explore')) {
          b.instagram = 'https://instagram.com/' + igMatch[1].replace(/\/$/, '');
        }
      }

      // 7. YouTube channel link
      if (!b.website) {
        const ytMatch = full.match(/youtube\.com\/(?:channel\/([^"\s&]+)|@([a-zA-Z0-9._-]+))/i);
        if (ytMatch) {
          const ytUrl = ytMatch[1] ? 'https://youtube.com/channel/' + ytMatch[1] : 'https://youtube.com/@' + ytMatch[2];
          b.website = ytUrl;
        }
      }

      // 8. TikTok link
      if (!b.tiktok) {
        const ttMatch = full.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
        if (ttMatch && !ttMatch[0].includes('login')) {
          b.tiktok = 'https://tiktok.com/@' + ttMatch[1];
        }
      }

      // 9. Extract social links from href attributes (comprehensive)
      const allHrefs = [...full.matchAll(/href="([^"]+)"/gi)].map(m => m[1]);
      for (const href of allHrefs) {
        if (!b.facebook && /facebook\.com\/[^/]+/i.test(href) && !href.includes('login') && !href.includes('sharer')) {
          const fbM = href.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
          if (fbM) b.facebook = 'https://facebook.com/' + fbM[1];
        }
        if (!b.instagram && /instagram\.com\/[^/]+/i.test(href) && !href.includes('accounts')) {
          const igM2 = href.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
          if (igM2) b.instagram = 'https://instagram.com/' + igM2[1];
        }
        if (!b.email && /^mailto:/i.test(href)) {
          const emailAddr = href.replace(/^mailto:/i, '').split('?')[0].trim();
          if (emailAddr.includes('@') && !EXCLUDE.test(emailAddr)) b.email = emailAddr;
        }
      }
    } catch {}
  }

  // Scrape main page
  await deepScrape(b.website);

  // Scrape contact/about pages if still missing data
  if (!b.email || !b.phone || !b.facebook || !b.instagram) {
    const base = b.website.replace(/\/$/, '');
    const paths = ['/contact', '/contact-us', '/about', '/about-us', '/kontakti', '/kontakt',
                   '/contacte', '/team', '/info', '/impressum', '/locations', '/find-us',
                   '/where-to-find-us', '/reach-us', '/get-in-touch',
                   '/kontaktay', '/kavshiri', '/momkhmarebeli', '/tsmrunebi',
                   '/contactos', '/contato', '/联系我们', '/お問い合わせ', '/اتصل بنا', '/написать-нам'];
    for (const path of paths) {
      if (b.email && b.phone && b.facebook) break;
      await deepScrape(base + path);
    }
  }
}

// ─── WordPress REST API Scraper ────────────────────────────────
// WordPress sites expose contact info via /wp-json/wp/v2/users and /wp-json/
async function scrapeWordPressAPI(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  const base = b.website.replace(/\/$/, '');
  const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;

  const endpoints = ['/wp-json/', '/wp-json/wp/v2/users', '/wp-json/wp/v2/pages'];
  for (const ep of endpoints) {
    if (b.email && b.phone) break;
    try {
      const r = await corsFetch(base + ep, {
        signal: AbortSignal.timeout(4000),
        headers: { 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const text = await r.text();
      // Extract emails
      if (!b.email) {
        const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emails) {
          for (const e of emails) {
            const clean = e.replace(/[\s>);]+$/, '');
            if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
          }
        }
      }
      // Extract phones
      if (!b.phone) {
        const phones = text.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
        if (phones) {
          for (const p of phones) {
            if (p.replace(/[^\d+]/g, '').length >= 8 && p.replace(/[^\d+]/g, '').length <= 15) {
              b.phone = p.trim(); break;
            }
          }
        }
      }
    } catch {}
  }
}

// ─── Sitemap Scraper ────────────────────────────────────────────
// Parse sitemap.xml to find contact/about pages, then scrape them
async function scrapeSitemapForContacts(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  const base = b.website.replace(/\/$/, '');
  const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;

  try {
    const r = await corsFetch(base + '/sitemap.xml', {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return;
    const xml = await r.text();
    // Find contact/about URLs in sitemap
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
    const contactUrls = urls.filter(u => /contact|about|team|info|impressum/i.test(u));

    for (const url of contactUrls.slice(0, 3)) {
      if (b.email && b.phone) break;
      try {
        const cr = await corsFetch(url, { signal: AbortSignal.timeout(3000) });
        if (!cr.ok) continue;
        const html = await cr.text();
        // Extract emails
        if (!b.email) {
          const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, '');
              if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
            }
          }
        }
        // Extract phones
        if (!b.phone) {
          const telM = html.match(/href="tel:([^"]+)"/);
          if (telM) b.phone = telM[1].trim();
          if (!b.phone) {
            const phones = html.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
            if (phones) {
              for (const p of phones) {
                if (p.replace(/[^\d+]/g, '').length >= 8 && p.replace(/[^\d+]/g, '').length <= 15) {
                  b.phone = p.trim(); break;
                }
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
}

// ─── vCard Scraper ──────────────────────────────────────────────
// Some businesses link to .vcf files with full contact info
async function scrapeVCard(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  const base = b.website.replace(/\/$/, '');

  try {
    // Check main page for .vcf links
    const r = await corsFetch(base, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    const html = await r.text();
    const vcfLinks = [...html.matchAll(/href="([^"]*\.vcf[^"]*)"/gi)].map(m => m[1]);

    for (const vcfUrl of vcfLinks.slice(0, 2)) {
      if (b.email && b.phone) break;
      const fullUrl = vcfUrl.startsWith('http') ? vcfUrl : base + '/' + vcfUrl.replace(/^\//, '');
      try {
        const vr = await corsFetch(fullUrl, { signal: AbortSignal.timeout(3000) });
        if (!vr.ok) continue;
        const vcf = await vr.text();
        // Parse vCard format
        if (!b.email) {
          const emailM = vcf.match(/EMAIL[^:]*:([^\r\n]+)/i);
          if (emailM) b.email = emailM[1].trim();
        }
        if (!b.phone) {
          const telM = vcf.match(/TEL[^:]*:([^\r\n]+)/i);
          if (telM) b.phone = telM[1].trim();
        }
      } catch {}
    }
  } catch {}
}

// ─── Google Maps Place Search Enrichment ────────────────────────
async function enrichFromGooglePlaces(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS = businesses.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  if (NEEDS.length === 0) return;
  const BATCH = 3;
  const max = Math.min(NEEDS.length, 50);
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const q = encodeURIComponent(b.name + ' ' + (b.address || ''));
        const r = await corsFetch('https://www.google.com/maps/search/' + q, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return;
        const html = await r.text();
        if (!b.phone) {
          const m = html.match(/\+\d[\d\s\-\.\(\)]{7,18}/);
          if (m && m[0].length >= 8) { b.phone = m[0].trim(); found++; }
        }
        if (!b.website) {
          const m = html.match(/(?:www\.|https?:\/\/)([^"\s<>]+\.(com|ge|net|org|io|co)[^"\s<>]*)/i);
          if (m && !m[0].includes('google.com') && !m[0].includes('gstatic') && isLikelyBusinessWebsite(m[0], b.name)) {
            let u = m[0]; if (!u.startsWith('http')) u = 'https://' + u;
            b.website = u; found++;
          }
        }
        if (!b.email) {
          const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (m && !m[0].includes('example.com') && !m[0].includes('google.com')) { b.email = m[0]; found++; }
        }
        if (!b.facebook) {
          const m = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
          if (m) { b.facebook = 'https://facebook.com/' + m[1]; found++; }
        }
        if (!b.instagram) {
          const m = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
          if (m) { b.instagram = 'https://instagram.com/' + m[1]; found++; }
        }
      } catch {}
    }));
    if (i + BATCH < max) await wait(3000);
    onProgress?.(92, 'Google enrichment... ' + Math.min(i + BATCH, max) + '/' + max + ' (' + found + ' found)');
  }
}


// Directory/listing sites that should NEVER be set as a business website
const DIRECTORY_SITES = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress|2gis\.com|yandex\.com|uber\.com|doordash|grubhub|seamless|glassdoor|indeed\.com|glassdoor|angieslist|homeadvisor|thumbtack|bbb\.org|trustpilot|sitejabber|clutch\.co|goodfirms|sortlist|brightlocal|moz\.com|semrush|ahrefs|similarweb/i;

// Check if a URL is likely the business's OWN website (not a directory listing)
function isLikelyBusinessWebsite(url: string, businessName: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    // Reject directory/listing sites
    if (DIRECTORY_SITES.test(hostname)) return false;
    // Reject known non-business domains
    if (/google|facebook|instagram|twitter|tiktok|linkedin|pinterest|reddit|youtube|amazon|ebay|apple|microsoft|github|stackoverflow/i.test(hostname)) return false;
    // Reject if hostname is just an IP address
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
    // Reject subdomains of major platforms (e.g., business.tripadvisor.com)
    const parts = hostname.split('.');
    if (parts.length > 3) return false; // too many subdomains = likely a platform page
    // Accept if it looks like a real business domain
    // Good signs: .com, .ge, .org, .net, .io, .co, country TLDs
    // Bad signs: blogspot, wordpress.com, wix, squarespace (but these ARE real business sites)
    return true;
  } catch {
    return false;
  }
}

// ── Unified extraction: pull phone, email, website, social from any HTML/text ──
function extractFromHtml(html: string, b: Business): boolean {
  // Snapshot before so caller can know whether anything was extracted
  const before = `${b.phone}|${b.email}|${b.website}|${b.facebook}|${b.instagram}|${b.twitter}|${b.pinterest}|${b.rating ?? ''}|${b.reviewCount ?? ''}`;
  const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org|privacy.*policy|terms.*service|cookie/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;

  // Phone: tel: links, then text regex
  if (!b.phone) {
    // 1. tel: links (most reliable)
    const telM = html.match(/href="tel:([^"]+)"/);
    if (telM) b.phone = (() => { try { return decodeURIComponent(telM[1]).trim(); } catch { return telM[1].trim(); } })();
    // 2. Country-specific formats
    if (!b.phone) {
      const geoM = html.match(/\+995\s?\d{3}\s?\d{2}\s?\d{2}\s?\d{2}/);
      if (geoM) b.phone = geoM[0].trim();
    }
    if (!b.phone) {
      const armM = html.match(/\+374\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}/);
      if (armM) b.phone = armM[0].trim();
    }
    if (!b.phone) {
      const turM = html.match(/\+90\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/);
      if (turM) b.phone = turM[0].trim();
    }
    if (!b.phone) {
      const ruM = html.match(/\+7\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/);
      if (ruM) b.phone = ruM[0].trim();
    }
    // 3. Labeled phone patterns (Phone: +xxx, Tel: xxx, etc.)
    if (!b.phone) {
      const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls?|whatsapp|viber|contact)\s*[:;=\s"'>]*([+\d][\d\s\-\.()]{7,18})/i);
      if (labeledPh && labeledPh[1].replace(/[^\d]/g, '').length >= 8 && plausiblePhone(labeledPh[1])) b.phone = labeledPh[1].trim();
    }
    // 4. General phone regex (fallback). Unlabeled text is noisy: require a
    // leading '+' so floats/coordinates (2.3333…), IDs and fragments don't
    // match. Labeled/tel: paths above stay permissive for local formats.
    if (!b.phone) {
      const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
      if (phM) {
        for (const p of phM) {
          if (!p.includes('+')) continue;
          const digits = p.replace(/[^\d+]/g, '');
          if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(p) && !JUNK.test(p)) { b.phone = p.trim(); break; }
        }
      }
    }
  }

  // Email: structured extraction with verification
  // Strategy 1: Look for contact info in structured HTML (most reliable)
  if (!b.email) {
    // Contact section: look for labeled email near "contact" heading
    const contactSection = html.match(/<(?:div|section|footer|aside)[^>]*class="[^"]*contact[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|footer|aside)/i);
    if (contactSection) {
      const emails = contactSection[1].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
        }
      }
    }
  }

  // Email: mailto, text, Cloudflare decode, &#64; encode, JSON-LD
  if (!b.email) {
    // 1. mailto: links (most reliable)
    const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
    if (mailM && !JUNK.test(mailM[1]) && !EMAIL_FILE.test(mailM[1])) b.email = mailM[1].trim();
    // 2. Labeled email patterns (Email: xxx@yyy.com)
    if (!b.email) {
      const labelM = html.match(/(?:email|e-mail|mail|contact)\s*[:;=\s"'>]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (labelM && !JUNK.test(labelM[1]) && !EMAIL_FILE.test(labelM[1])) b.email = labelM[1];
    }
    // 3. JSON-LD structured data
    if (!b.email) {
      const jsonLdEmails = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of jsonLdEmails) {
        try {
          const data = JSON.parse(m[1]);
          const entities = Array.isArray(data) ? data : [data];
          for (const e of entities) {
            if (e.email && !JUNK.test(e.email) && !EMAIL_FILE.test(e.email)) { b.email = e.email; break; }
          }
        } catch {}
        if (b.email) break;
      }
    }
    // 4. General email regex (fallback)
    if (!b.email) {
      const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
        }
      }
    }
    // 5. Cloudflare encoded emails
    if (!b.email) {
      const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
      if (cfM) {
        try {
          const bytes = cfM[1].match(/.{2}/g)!.map(h => parseInt(h, 16));
          const key = bytes[0];
          const decoded = bytes.slice(1).map(x => x ^ key).map(x => String.fromCharCode(x)).join('');
          if (decoded.includes('@') && !JUNK.test(decoded)) b.email = decoded;
        } catch {}
      }
    }
    // 6. HTML entity encoded (@)
    if (!b.email) {
      const entM = html.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (entM && !JUNK.test(entM[0])) b.email = entM[1] + '@' + entM[2];
    }
    // 7. JavaScript string literals
    if (!b.email) {
      const jsEmailM = html.match(/['"]([\w][\w._%+-]*@[\w.-]+\.[a-zA-Z]{2,})['"]/);
      if (jsEmailM && !JUNK.test(jsEmailM[1]) && !EMAIL_FILE.test(jsEmailM[1]) && jsEmailM[1].length > 6) b.email = jsEmailM[1];
    }
    // 8. data-email attributes
    if (!b.email) {
      const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
      if (dataEmailM && !JUNK.test(dataEmailM[1]) && !EMAIL_FILE.test(dataEmailM[1])) b.email = dataEmailM[1];
    }
  }

  // Website: extract from links. Self-contained denylist (this variant must
  // not depend on the nested DIRECTORY_SITES/_EXCLUDE helpers).
  if (!b.website) {
    const links = html.matchAll(/href="([^"]+)"/g);
    const DENY = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest\.com|tumblr|reddit\.com|quora|wikipedia\.org|youtube\.com|tiktok\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|snapchat|threads|medium\.com|substack|archive\.org|amazon\.|ebay\.|aliexpress|2gis\.|yandex\.|uber\.com|doordash|grubhub|glassdoor|indeed\.com|thumbtack|bbb\.org|trustpilot|google\.|gstatic|apple\.com|microsoft\.com/i;
    for (const link of links) {
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!url.startsWith('http')) continue;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
      if (DENY.test(host)) continue;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
      b.website = url; break;
    }
  }

  // Facebook
  if (!b.facebook) {
    const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
    if (fbM && !fbM[0].includes('login') && !fbM[0].includes('sharer') && !fbM[0].includes('dialog')) {
      b.facebook = 'https://facebook.com/' + fbM[1].replace(/\/$/, '');
    }
  }

  // Instagram
  if (!b.instagram) {
    const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
    if (igM && !igM[0].includes('accounts') && !igM[0].includes('explore')) {
      b.instagram = 'https://instagram.com/' + igM[1].replace(/\/$/, '');
    }
  }

  // Twitter/X
  if (!b.twitter) {
    const twM = html.match(/(?:twitter|x)\.com\/([a-zA-Z0-9._]+)/i);
    if (twM && !twM[0].includes('login') && !twM[0].includes('intent') && !twM[0].includes('share')) {
      b.twitter = 'https://twitter.com/' + twM[1].replace(/\/$/, '');
    }
  }

  // Pinterest
  if (!b.pinterest) {
    const pinM = html.match(/pinterest\.com\/([a-zA-Z0-9._]+)/i);
    if (pinM && !pinM[0].includes('login')) {
      b.pinterest = 'https://pinterest.com/' + pinM[1].replace(/\/$/, '');
    }
  }

  // Rating from meta/structured data
  if (!b.rating) {
    const ratingM = html.match(/(?:ratingValue|rating)["\s:=]*(?:content)?["\s:=]*(\d\.\d)/i)
      || html.match(/(\d\.\d)\s*(?:out of|\/)\s*5/i);
    if (ratingM) {
      const val = parseFloat(ratingM[1]);
      if (val >= 1 && val <= 5) b.rating = val;
    }
  }
  // Review count
  if (!b.reviewCount) {
    const revM = html.match(/(?:reviewCount|ratingCount)["\s:=]+(\d+)/i)
      || html.match(/(\d[\d,]*)\s*reviews?/i);
    if (revM) {
      const val = parseInt(revM[1].replace(/,/g, ''));
      if (val > 0 && val < 100000) b.reviewCount = val;
    }
  }
  const after = `${b.phone}|${b.email}|${b.website}|${b.facebook}|${b.instagram}|${b.twitter}|${b.pinterest}|${b.rating ?? ''}|${b.reviewCount ?? ''}`;
  return before !== after;
}

// Try common email patterns by fetching the contact page
async function tryCommonEmailPatterns(b: Business): Promise<void> {
  if (b.email || !b.website) return;
  try {
    const host = new URL(b.website).hostname.replace(/^www\./, '');
    const prefixes = ['info', 'contact', 'hello', 'mail', 'office', 'admin', 'support', 'reception', 'reservations', 'booking', 'sales'];
    // Try the most common pattern first: info@domain.com
    // We verify by checking if the contact page exists
    const base = b.website.replace(/\/$/, '');
    const contactPaths = ['/contact', '/contact-us', '/about', '/about-us'];
    for (const path of contactPaths) {
      if (b.email) break;
      try {
        const r = await corsFetch(base + path, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) continue;
        const html = await r.text();
        // Look for any email on the contact page
        const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emails) {
          for (const e of emails) {
            const clean = e.replace(/[\s>);]+$/, '');
            const junk = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org|duckduckgo/i;
            if (!junk.test(clean) && clean.length > 6 && clean.length < 80) {
              b.email = clean;
              break;
            }
          }
        }
      } catch {}
    }
    // If still no email, try common patterns as mailto: links
    if (!b.email) {
      for (const prefix of prefixes.slice(0, 5)) {
        const guessedEmail = prefix + '@' + host;
        // We can't verify without sending, but we can check if the domain exists
        // by trying to fetch the website itself
        break; // Don't fabricate — just stop here
      }
    }
  } catch {}
}

// ── Extract from plain text (e.g. Brave search descriptions) ──
function extractFromText(text: string, b: Business): boolean {
  let touched = false;
  if (!b.phone) {
    const m = text.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
    if (m && m[0].length >= 8) { b.phone = m[0].trim(); touched = true; }
  }
  if (!b.email) {
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m && !m[0].includes('example.com') && !m[0].includes('google') && !m[0].includes('facebook') && !m[0].includes('instagram')) { b.email = m[0]; touched = true; }
  }
  if (!b.facebook) {
    const m = text.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
    if (m && !m[0].includes('login') && !m[0].includes('sharer')) { b.facebook = 'https://facebook.com/' + m[1]; touched = true; }
  }
  if (!b.instagram) {
    const m = text.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    if (m && !m[0].includes('accounts')) { b.instagram = 'https://instagram.com/' + m[1]; touched = true; }
  }
  // Extract rating (e.g. "4.5 stars" or "4.5/5" or "Rating: 4.5")
  if (!b.rating) {
    const ratingM = text.match(/(?:rating|stars|rated?)\s*[:=]?\s*(\d\.\d)\s*(?:\/\s*5)?/i)
      || text.match(/(\d\.\d)\s*(?:stars?|\/\s*5|out\s*of\s*5)/i);
    if (ratingM) {
      const val = parseFloat(ratingM[1]);
      if (val >= 1 && val <= 5) b.rating = val;
    }
  }
  // Extract review count (e.g. "1,234 reviews" or "(1234)")
  if (!b.reviewCount) {
    const revM = text.match(/(\d[\d,]*)\s*(?:reviews?|ratings?)/i)
      || text.match(/\((\d[\d,]*)\)/);
    if (revM) {
      const val = parseInt(revM[1].replace(/,/g, ''));
      if (val > 0 && val < 100000) b.reviewCount = val;
    }
  }
  // YouTube as website fallback
  if (!b.website) {
    const m = text.match(/youtube\.com\/(?:channel\/([a-zA-Z0-9_-]+)|@([a-zA-Z0-9._-]+))/i);
    if (m) b.website = m[1] ? 'https://youtube.com/channel/' + m[1] : 'https://youtube.com/@' + m[2];
  }
  // LinkedIn as website fallback
  if (!b.website) {
    const m = text.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
    if (m) { b.website = 'https://linkedin.com/company/' + m[1]; touched = true; }
  }
  return touched;
}

// ─── Brave Search Enrichment ───────────────────────────────────
// Bing Search (free scraping, no API key needed)
async function searchBing(query: string): Promise<{title: string; url: string; snippet: string}[]> {
  try {
    const r = await corsFetch('https://www.bing.com/search?q=' + query + '&count=10', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    // Challenge/benign page detection: Bing occasionally serves an Arkose
    // challenge instead of results. b_algo==0 + challenge markers => no data.
    if (!/<li class="b_algo"/i.test(html) && /akchal|challenge|verify|captcha/i.test(html)) return [];
    const results: {title: string; url: string; snippet: string}[] = [];
    // Extract search result blocks (li.b_algo)
    const blocks = html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const block of blocks) {
      const titleMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      // Try multiple snippet selectors: b_caption p, then any p
      const snippetMatch = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
        || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (titleMatch) {
        // Decode Bing redirect URLs: bing.com/ck/a?...u=a1<base64>...
        let url = titleMatch[1];
        if (url.includes('bing.com/ck/a')) {
          const uMatch = url.match(/u=([^&]+)/);
          if (uMatch) {
            const raw = uMatch[1];
            if (raw.startsWith('a1')) {
              try {
                url = atob(raw.substring(2));
              } catch {}
            }
          }
        }
        results.push({
          url,
          title: titleMatch[2].replace(/<[^>]+>/g, '').replace(/&#\d+;/g, ''),
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '') : '',
        });
      }
    }
    return results;
  } catch { return []; }
}

// DuckDuckGo Lite search — different endpoint from html.duckduckgo.com, returns cleaner results
async function searchDDGLite(query: string): Promise<{title: string; url: string; snippet: string}[]> {
  try {
    const r = await corsFetch('https://lite.duckduckgo.com/lite/?q=' + query, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const results: {title: string; url: string; snippet: string}[] = [];
    // DDG Lite uses table-based layout with class="result-link" for titles
    const links = html.matchAll(/<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]*)<\/a>/gi);
    for (const m of links) {
      const url = m[1];
      const title = m[2].replace(/&amp;/g, '&').replace(/&#\d+;/g, '');
      if (url.startsWith('http') && !url.includes('duckduckgo')) {
        results.push({ url, title, snippet: '' });
      }
    }
    // Extract snippets from adjacent table cells
    const snippetBlocks = html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi);
    let si = 0;
    for (const m of snippetBlocks) {
      if (si < results.length) {
        results[si].snippet = m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim();
        si++;
      }
    }
    // Fallback: try standard result pattern if lite layout fails
    if (results.length === 0) {
      const fallbackBlocks = html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
      for (const m of fallbackBlocks) {
        if (m[1].startsWith('http') && !m[1].includes('duckduckgo')) {
          results.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, ''), snippet: '' });
        }
      }
    }
    return results.slice(0, 10);
  } catch { return []; }
}

// Wikidata SPARQL lookup: free, keyless, CORS-native. Finds official email/
// phone/website for NOTABLE businesses (chains, hotels, landmarks). Queries
// are serialized (anonymous limit: 1 concurrent).
let _wikidataQueue: Promise<void> = Promise.resolve();
async function wikidataContacts(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  let host = '';
  try { host = new URL(b.website).hostname.replace(/^www\./, ''); } catch { return; }
  if (!host) return;
  // STRSTARTS over the 4 URL forms (verified working on WDQS; CONTAINS and
  // REGEXP trip this Blazegraph build's parser). UA is required (403 without).
  const h = host.replace(/[\\"]/g, '');
  const sparql = 'SELECT ?email ?phone WHERE { ?item wdt:P856 ?site . ' +
    'FILTER(STRSTARTS(STR(?site), "https://www.' + h + '") || STRSTARTS(STR(?site), "https://' + h + '") || ' +
    'STRSTARTS(STR(?site), "http://www.' + h + '") || STRSTARTS(STR(?site), "http://' + h + '")) . ' +
    'OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 1';
  const run = async () => {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql), {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BlueOcean/6.2 (market-gap research demo; contact@blueocean.app)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) return;
      const data = await r.json();
      const row = data?.results?.bindings?.[0];
      if (!row) return;
      if (!b.email && row.email?.value) {
        const e = String(row.email.value).replace(/^mailto:/, '');
        if (!_EMAIL_FILE_RE.test(e) && !_EMAIL_JUNK_RE.test(e)) b.email = e;
      }
      if (!b.phone && row.phone?.value) {
        const p = String(row.phone.value);
        if (plausiblePhone(p)) b.phone = p;
      }
    } catch { /* sparse coverage / timeouts are normal */ }
  };
  _wikidataQueue = _wikidataQueue.then(run, run);
  await _wikidataQueue;
}

// Wayback Machine: recover contact data for DEAD websites. CORS-native
// availability API, snapshot fetch routed through corsFetch.
async function waybackContacts(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  try {
    const av = await fetch('https://archive.org/wayback/available?url=' + encodeURIComponent(b.website), {
      signal: AbortSignal.timeout(10000),
    });
    if (!av.ok) return;
    const j = await av.json();
    const snap = j?.archived_snapshots?.closest?.url;
    if (!snap || !j.archived_snapshots.closest.available) return;
    const r = await corsFetch(snap, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const html = await r.text();
    if (html && html.length > 200) extractFromHtmlModule(html, b);
  } catch { /* best effort */ }
}

// Domain probing - check if common domain patterns exist for a business.
// Ownership verification: a guessed domain that merely returns HTTP 200 could
// belong to anyone (cybersquatters, unrelated businesses). The page must
// mention the business name before it may be attached.
async function probeDomains(b: Business): Promise<void> {
  if (b.website) return;
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  // Try multiple slug variants
  const slugs: string[] = [];
  if (nameEn && nameEn !== b.name) {
    slugs.push(nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 20));
    slugs.push(nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 25));
  }
  // Also try transliterated name
  const translit = transliterateGeo(b.name);
  if (translit !== b.name && translit !== nameEn) {
    slugs.push(translit.toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 20));
  }
  const tlds = ['.com', '.ge', '.org', '.net', '.io', '.am', '.ru', '.tr', '.fr', '.de', '.co'];
  for (const slug of slugs) {
    if (slug.length < 3) continue;
    for (const tld of tlds) {
      try {
        const domain = 'https://' + slug + tld;
        const r = await corsFetch(domain, {
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const html = (await r.text()).toLowerCase();
          // Verify the page actually references the business (name, in any
          // of its written forms) before claiming it as the business's site.
          const nameTokens = [nameEn, translit, b.name]
            .map(n => (n || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\u0400-\u04ff\u0370-\u03ff]+/g, ''))
            .filter(n => n.length >= 4);
          const nameMatch = nameTokens.some(tok => html.includes(tok.slice(0, 10)));
          const cityMatch = cityEn ? html.includes(cityEn.toLowerCase()) : true;
          if (nameMatch || (cityMatch && nameTokens.length === 0)) {
            b.website = domain;
            return;
          }
        }
      } catch {}
    }
  }
}

// Brave API key: prefer VITE_BRAVE_API_KEY from client/.env (see README),
// other free-tier engines: Serper (2,500 free one-time queries), Tavily
// (1,000 searches/month free). Keys are optional — engines simply skip
// when the env var is absent.
const SERPER_API_KEY = (import.meta as any).env?.VITE_SERPER_API_KEY || '';
const TAVILY_API_KEY = (import.meta as any).env?.VITE_TAVILY_API_KEY || '';

/** Apply a search result (title/url/snippet) to a business — shared by all engines. */
function applySearchResult(b: Business, url: string, text: string, found: { n: number }): void {
  const cc = getScanContext()?.countryCode;
  if (!b.phone && text) {
    const m = text.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
    if (m) {
      const norm = normalizePhone(m[0], cc);
      if (norm.replace(/\D/g, '').length >= 8) { b.phone = norm; found.n++; }
    }
  }
  if (!b.website && url) {
    let u = url;
    const uddg = u.match(/uddg=([^&]+)/);
    if (uddg) { try { u = decodeURIComponent(uddg[1]); } catch {} }
    if (u.startsWith('http') && !EXCLUDE_DOMAINS.test(u) && isLikelyBusinessWebsite(u, b.name)) {
      b.website = u; found.n++;
    }
  }
  if (!b.email && text) {
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m && !/example\.|duckduckgo|sentry|wixpress/i.test(m[0])) { b.email = m[0]; found.n++; }
  }
  if (!b.facebook && text) {
    const m = text.match(/facebook\.com\/([a-zA-Z0-9._-]{2,})/i);
    if (m && !/sharer|login|dialog/i.test(m[0])) { b.facebook = 'https://facebook.com/' + m[1]; found.n++; }
  }
  if (!b.instagram && text) {
    const m = text.match(/instagram\.com\/([a-zA-Z0-9._-]{2,})/i);
    if (m && !/accounts|explore|p\/|reel/i.test(m[0])) { b.instagram = 'https://instagram.com/' + m[1]; found.n++; }
  }
}

// ─── Serper.dev engine (free tier: 2,500 one-time queries, key optional) ──
async function enrichFromSerper(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  if (!SERPER_API_KEY) return;
  const NEEDS = businesses.filter(b => !b.website || !b.phone || !b.email);
  const max = Math.min(NEEDS.length, 80);
  const BATCH = 3;
  let found = { n: 0 };
  for (let i = 0; i < max; i += BATCH) {
    if (isCancelled()) break;
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        // Native-language query first (site-restricted), then plain
        const queries = buildSearchQueries(b).slice(0, 2);
        for (const q of queries) {
          const r = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: decodeURIComponent(q), num: 5 }),
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) return;
          const data = await r.json();
          for (const res of (data.organic || []).slice(0, 5)) {
            applySearchResult(b, res.link || '', `${res.title || ''} ${res.snippet || ''}`, found);
            if (b.website && b.phone && b.email) break;
          }
          if (b.website && b.phone && b.email) break;
          await wait(400);
        }
      } catch {}
    }));
    onProgress?.(86, `Serper… ${Math.min(i + BATCH, max)}/${max} (${found.n} found)`);
    if (i + BATCH < max) await wait(1200);
  }
}

// ─── Tavily engine (free tier: 1,000 searches/month, key optional) ──
async function enrichFromTavily(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  if (!TAVILY_API_KEY) return;
  const NEEDS = businesses.filter(b => !b.website || !b.phone || !b.email);
  const max = Math.min(NEEDS.length, 60);
  const BATCH = 3;
  let found = { n: 0 };
  for (let i = 0; i < max; i += BATCH) {
    if (isCancelled()) break;
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const ctx = getScanContext();
        const q = `"${b.name}" ${ctx?.cityNative || ''} ${b.categoryLabel || ''} contact phone email`.trim();
        const r = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: TAVILY_API_KEY, query: q, max_results: 5, search_depth: 'basic' }),
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) return;
        const data = await r.json();
        for (const res of (data.results || []).slice(0, 5)) {
          applySearchResult(b, res.url || '', `${res.title || ''} ${res.content || ''}`, found);
          if (b.website && b.phone && b.email) break;
        }
      } catch {}
    }));
    onProgress?.(86, `Tavily… ${Math.min(i + BATCH, max)}/${max} (${found.n} found)`);
    if (i + BATCH < max) await wait(1000);
  }
}
// falling back to the embedded free-tier key so the app works out of the box.
const BRAVE_API_KEY = (import.meta as any).env?.VITE_BRAVE_API_KEY || 'BSAded3tnZfvadieW5pz0tiLrlh2lvn';

// ─── Multilingual Search Helpers ───────────────────────────
// Maps common Georgian city names to English
const CITY_EN_MAP: Record<string, string> = {
  // Georgian
  'თბილისი': 'Tbilisi', 'ბათუმი': 'Batumi', 'ქუთაისი': 'Kutaisi',
  'რუსთავი': 'Rustavi', 'ზუგდიდი': 'Zugdidi', 'გორი': 'Gori',
  'ფოთი': 'Poti', 'ქობულეთი': 'Kobuleti', 'თელავი': 'Telavi',
  'სამტრედია': 'Samtredia', 'სენაკი': 'Senaki', 'ხაშური': 'Khashuri',
  'ახალციხე': 'Akhaltsikhe', 'ოზურგეთი': 'Ozurgeti', 'მარნეული': 'Marneuli',
  // Armenian
  'Երևան': 'Yerevan', 'Գյումրի': 'Gyumri', 'Վանաձոր': 'Vanadzor',
  'Աբովյան': 'Abovyan', 'Կապան': 'Kapan', 'Հրազդան': 'Hrazdan',
  // Russian
  'Москва': 'Moscow', 'Санкт-Петербург': 'Saint Petersburg', 'Новосибирск': 'Novosibirsk',
  'Екатеринбург': 'Yekaterinburg', 'Казань': 'Kazan', 'Нижний Новгород': 'Nizhny Novgorod',
  'Краснодар': 'Krasnodar', 'Сочи': 'Sochi', 'Самара': 'Samara', 'Омск': 'Omsk',
  // Turkish
  'İstanbul': 'Istanbul', 'Ankara': 'Ankara', 'İzmir': 'Izmir',
  'Bursa': 'Bursa', 'Antalya': 'Antalya', 'Adana': 'Adana',
  'Trabzon': 'Trabzon', 'Gaziantep': 'Gaziantep', 'Konya': 'Konya',
  'Mersin': 'Mersin', 'Diyarbakır': 'Diyarbakir',
  // Azerbaijani
  'Bakı': 'Baku', 'Gəncə': 'Ganja', 'Sumqayıt': 'Sumqayit',
  // Arabic
  'القاهرة': 'Cairo', 'الرياض': 'Riyadh', 'جدة': 'Jeddah',
  'دبي': 'Dubai', 'بيروت': 'Beirut', 'عمّان': 'Amman',
  // Hindi
  'मुंबई': 'Mumbai', 'दिल्ली': 'Delhi', 'बेंगलुरु': 'Bangalore',
  // Chinese/Japanese/Korean
  '서울': 'Seoul', '도쿄': 'Tokyo',
  // Ukrainian
  'Київ': 'Kyiv', 'Харків': 'Kharkiv', 'Одеса': 'Odesa', 'Дніпро': 'Dnipro',
};

// Transliterate any non-Latin script to Latin
function transliterateGeo(text: string): string {
  if (!text) return text;
  const map: Record<string, string> = {
    // Georgian
    'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v',
    'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l', 'მ': 'm',
    'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's',
    'ტ': 't', 'უ': 'u', 'ფ': 'p', 'ქ': 'k', 'ღ': 'gh', 'ყ': 'q',
    'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts',
    'ჭ': 'ch', 'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h',
    // Armenian
    'Ա': 'A', 'Բ': 'B', 'Գ': 'G', 'Դ': 'D', 'Ե': 'Ye', 'Զ': 'Z',
    'Է': 'E', 'Ը': 'Y', 'Թ': 'T', 'Ժ': 'Zh', 'Ի': 'I', 'Լ': 'L',
    'Խ': 'Kh', 'Կ': 'K', 'Հ': 'H', 'Ձ': 'Dz', 'Ղ': 'Gh', 'Ճ': 'Ch',
    'Մ': 'M', 'Յ': 'Y', 'Ն': 'N', 'Շ': 'Sh', 'Ո': 'Vo', 'Չ': 'Ch',
    'Պ': 'P', 'Ջ': 'J', 'Ռ': 'R', 'Ս': 'S', 'Վ': 'V', 'Տ': 'T',
    'Ր': 'R', 'Ց': 'Ts', 'Փ': 'P', 'Ք': 'K', 'Օ': 'O', 'Ֆ': 'F',
    'ա': 'a', 'բ': 'b', 'գ': 'g', 'դ': 'd', 'ե': 'ye', 'զ': 'z',
    'է': 'e', 'ը': 'y', 'թ': 't', 'ժ': 'zh', 'ի': 'i', 'լ': 'l',
    'խ': 'kh', 'կ': 'k', 'հ': 'h', 'ձ': 'dz', 'ղ': 'gh', 'ճ': 'ch',
    'մ': 'm', 'յ': 'y', 'ն': 'n', 'շ': 'sh', 'ո': 'vo', 'չ': 'ch',
    'պ': 'p', 'ջ': 'j', 'ռ': 'r', 'ս': 's', 'վ': 'v', 'տ': 't',
    'ր': 'r', 'ց': 'ts', 'ու': 'u', 'փ': 'p', 'ք': 'k', 'և': 'ev',
    'օ': 'o', 'ֆ': 'f',
    // Russian/Cyrillic
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E',
    'Ё': 'Yo', 'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K',
    'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R',
    'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts',
    'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '',
    'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e',
    'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k',
    'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
    'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
    'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '',
    'э': 'e', 'ю': 'yu', 'я': 'ya',
  };
  return text.split('').map(c => map[c] || c).join('');
}

// Get English name for a city (from map or transliteration)
function getEnglishCityName(name: string): string {
  if (!name) return '';
  if (CITY_EN_MAP[name]) return CITY_EN_MAP[name];
  // Check if already Latin
  if (/^[a-zA-Z\s-]+$/.test(name)) return name;
  // Try transliteration
  const translit = transliterateGeo(name);
  if (translit !== name) return translit;
  return name;
}


const EXCLUDE_DOMAINS = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com/i;

// Build a smart search query for any language
function buildSearchQuery(b: { name: string; address?: string; categoryLabel?: string; category?: string }): string {
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const category = b.categoryLabel || '';
  const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
    if (cityEn) parts.push(cityEn);
  } else {
    // Non-Latin: search by street + category + city + transliterated name
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (cityEn) parts.push(cityEn);
    if (category) parts.push(category);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
    parts.push(`"${b.name}"`);
  }
  // Add keywords that help find contact data in search snippets
  // Native-language category term (e.g. 'კაფე') reaches local-only sites
  const nativeCat = categoryInNative(b.category || '', category);
  if (nativeCat && nativeCat !== category) parts.push(nativeCat);
  parts.push('phone email website contact');
  return encodeURIComponent(parts.join(' '));
}

// Generate multiple query variations for a business (native + English)
function buildSearchQueries(b: Business): string[] {
  const queries: string[] = [];
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
  const ctx = getScanContext();
  const nativeCat = categoryInNative(b.category || '', b.categoryLabel || '');
  const tld = countryTld();

  // Query 0 (new): site:.tld restriction — the strongest local-site filter
  if (tld && tld !== 'com') {
    queries.push(encodeURIComponent(`"${b.name}" ${ctx?.cityNative || cityEn || ''} site:.${tld}`));
  }

  // Query 0b (new): native-language query — name + native category + city
  if (nativeCat && nativeCat !== (b.categoryLabel || '')) {
    queries.push(encodeURIComponent(`"${b.name}" ${nativeCat} ${ctx?.cityNative || cityEn || ''} contact`));
  }

  // Query 1: Exact name + city (best for well-known businesses)
  if (isLatin) {
    queries.push(encodeURIComponent(`"${b.name}" ${cityEn || ''} phone email contact`));
  } else {
    if (nameEn && nameEn !== b.name) {
      queries.push(encodeURIComponent(`"${nameEn}" ${cityEn || ''} phone email contact`));
    }
  }

  // Query 2: Name + street + city (for local businesses)
  if (streetEn && streetEn !== street) {
    queries.push(encodeURIComponent(`"${b.name}" "${streetEn}" ${cityEn || ''} phone email`));
  }

  // Query 3: Transliterated name + category + city (for non-Latin businesses)
  if (!isLatin && nameEn && nameEn !== b.name) {
    queries.push(encodeURIComponent(`"${nameEn}" ${b.categoryLabel || ''} ${cityEn || ''} phone email website`));
  }

  // Query 4: Original name + city (for businesses that appear in local language)
  if (!isLatin) {
    queries.push(encodeURIComponent(`"${b.name}" ${cityEn || ''} phone email website contact`));
  }

  return queries.filter(q => q.length > 5);
}

// Build a targeted query specifically for finding contact pages
function buildContactQuery(b: Business): string {
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
  } else {
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
  }
  if (cityEn) parts.push(cityEn);
  // Use site: to search for contact pages specifically
  parts.push('site:facebook.com OR site:instagram.com OR "contact us"');
  return encodeURIComponent(parts.join(' '));
}

// Build targeted email-only query
function buildEmailQuery(b: Business): string {
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const category = b.categoryLabel || '';
  const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
  } else {
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (category) parts.push(category);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
  }
  if (cityEn) parts.push(cityEn);
  parts.push('email address contact');
  return encodeURIComponent(parts.join(' '));
}

// Build targeted phone-only query
function buildPhoneQuery(b: Business): string {
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const category = b.categoryLabel || '';
  const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
  } else {
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (category) parts.push(category);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
  }
  if (cityEn) parts.push(cityEn);
  parts.push('phone number telephone call');
  return encodeURIComponent(parts.join(' '));
}
// guessEmailsFromDomain removed

// Try Google cache as fallback for blocked websites
async function tryGoogleCache(_b: Business): Promise<void> {
    // Google Cache discontinued in 2024
    return;
}

// Try AMP/cached version of a page
async function tryAMPVersion(b: Business): Promise<void> {
  if (b.email && b.phone) return;
  if (!b.website) return;
  try {
    // Try AMP version (many sites have AMP pages with contact info)
    const ampUrl = b.website.replace(/\.html$/, '') + '/amp';
    const r = await corsFetch(ampUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const html = await r.text();
      extractFromHtml(html, b);
    }
  } catch {}
}

// Also try to find email by scraping the website contact page directly
async function scrapeContactPageForEmail(b: Business): Promise<void> {
  if (b.email || !b.website) return;
  try {
    const base = b.website.replace(/\/$/, '');
    // Extended contact page paths — covers most CMS platforms and languages
    // Top 8 most effective contact page paths (speed: max 8 pages)
    // Priority contact page paths — covers most CMS platforms and languages
    const paths = [
      '/contact', '/contact-us', '/about', '/about-us',
      '/kontakti', '/контакты', '/iletisim', '/contato',
      '/contacto', '/kontakt', '/scontattaci', '/ contacting',
      '/team', '/info', '/impressum', '/locations',
      '/find-us', '/where-to-find-us', '/reach-us', '/get-in-touch',
      '/kontaktay', '/momkhmarebeli', '/联系方式', '/お問い合わせ',
      '/اتصل-بنا', '/написать-нам', '/联系我们',
    ];
    for (const path of paths) {
      if (b.email) break;
      try {
        // Try direct fetch first (most websites support CORS)
        let r: Response;
        try {
          r = await fetch(base + path, { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
        } catch {
          r = await corsFetch(base + path, { signal: AbortSignal.timeout(2500) });
        }
        if (!r.ok) continue;
        const html = await r.text();
        const junk = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org|duckduckgo/i;
        // Look for email patterns
        const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emails) {
          for (const e of emails) {
            const clean = e.replace(/[\s>);]+$/, '');
            if (!junk.test(clean) && clean.length > 6 && clean.length < 80) {
              b.email = clean;
              break;
            }
          }
        }
        // Also check Cloudflare encoded emails
        if (!b.email) {
          const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
          if (cfM) {
            try {
              const bytes = cfM[1].match(/.{2}/g)!.map(h => parseInt(h, 16));
              const key = bytes[0];
              const decoded = bytes.slice(1).map(x => x ^ key).map(x => String.fromCharCode(x)).join('');
              if (decoded.includes('@') && !junk.test(decoded)) b.email = decoded;
            } catch {}
          }
        }
        // Also extract phone from contact page
        if (!b.phone) {
          const telM = html.match(/href="tel:([^"]+)"/);
          if (telM) b.phone = telM[1].trim();
          if (!b.phone) {
            const phM = html.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
            if (phM) {
              for (const p of phM) {
                const digits = p.replace(/[^\d+]/g, '');
                if (digits.length >= 8 && digits.length <= 15 && !junk.test(p)) { b.phone = p.trim(); break; }
              }
            }
          }
          if (!b.phone) {
            const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls)\s*[:;]\s*([+\d][\d\s\-\.()]{7,18})/i);
            if (labeledPh && labeledPh[1].replace(/[^\d]/g, '').length >= 8) b.phone = labeledPh[1].trim();
          }
        }
        // Also extract social media links from contact page
        if (!b.facebook) {
          const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
          if (fbM && !fbM[0].includes('login') && !fbM[0].includes('sharer')) {
            b.facebook = 'https://facebook.com/' + fbM[1].replace(/\/$/, '');
          }
        }
        if (!b.instagram) {
          const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
          if (igM && !igM[0].includes('accounts')) {
            b.instagram = 'https://instagram.com/' + igM[1].replace(/\/$/, '');
          }
        }
        // Also extract from href attributes
        const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map(m => m[1]);
        for (const href of hrefs) {
          if (!b.facebook && /facebook\.com\/[^/]+/i.test(href) && !href.includes('login')) {
            const m2 = href.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
            if (m2) b.facebook = 'https://facebook.com/' + m2[1];
          }
          if (!b.instagram && /instagram\.com\/[^/]+/i.test(href) && !href.includes('accounts')) {
            const m3 = href.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
            if (m3) b.instagram = 'https://instagram.com/' + m3[1];
          }
        }
      } catch {}
    }
  } catch {}
}

async function enrichFromBrave(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS = businesses.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  if (NEEDS.length === 0 || !BRAVE_API_KEY) return;
  const BATCH = 3;
  const max = Math.min(NEEDS.length, 50); // Brave free tier: 2000 req/mo
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const q = buildSearchQuery(b);
        const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=3`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return;
        const data = await r.json();
        const results = data.web?.results || [];
        for (const res of results) {
          const desc = (res.description || '') + ' ' + (res.title || '');
          // Extract phone
          if (!b.phone) {
            const m = desc.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
            if (m && m[0].length >= 8) { b.phone = m[0].trim(); found++; }
          }
          // Extract website from result URL
          if (!b.website && res.url && !res.url.includes('google.com') && !res.url.includes('facebook.com')) {
            b.website = res.url; found++;
          }
          // Extract email
          if (!b.email) {
            const m = desc.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (m && !m[0].includes('example.com')) { b.email = m[0]; found++; }
          }
          // Extract social — try all platforms
          if (!b.facebook) {
            const m = desc.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
            if (m) { b.facebook = 'https://facebook.com/' + m[1]; found++; }
          }
          if (!b.instagram) {
            const m = desc.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
            if (m) { b.instagram = 'https://instagram.com/' + m[1]; found++; }
          }
          // Extract additional website from Brave knowledge graph
          if (!b.website && data.knowledge_graph?.url) {
            const kgUrl = data.knowledge_graph.url;
            if (!kgUrl.includes('google.com') && !EXCLUDE_DOMAINS.test(kgUrl)) {
              b.website = kgUrl; found++;
            }
          }
        }
      } catch {}
    }));
    if (i + BATCH < max) await wait(1500);
    onProgress?.(88, `Brave search… ${Math.min(i + BATCH, max)}/${max} (${found} found)`);
  }
}

// ─── DuckDuckGo Search Enrichment ──────────────────────────────
// Searches DuckDuckGo for business contact info (website, phone, social)
async function enrichFromWeb(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS_DATA = businesses.filter(b => !b.website || !b.phone || !b.email || (!b.facebook && !b.instagram));
  if (NEEDS_DATA.length === 0) return;

  const BATCH = 5;
  const maxEnrich = Math.min(NEEDS_DATA.length, 120);
  let found = 0;

  for (let i = 0; i < maxEnrich; i += BATCH) {
    const batch = NEEDS_DATA.slice(i, i + BATCH);
    const promises = batch.map(async (b) => {
      try {
        // Build multilingual query: original name + English transliteration
        const query = buildSearchQuery(b);
        const url = `https://html.duckduckgo.com/html/?q=${query}`;
        const r = await corsFetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) return;
        const html = await r.text();

        // Extract phone numbers from search results (look for local format too)
        if (!b.phone) {
          const phoneMatch = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,15})/);
          if (phoneMatch) {
            const phone = phoneMatch[0].trim();
            if (phone.length >= 8 && phone.length <= 20) {
              b.phone = phone;
              found++;
            }
          }
        }
        // Also look for Georgian-format phones (995 XXX XX XX XX)
        if (!b.phone) {
          const geoMatch = html.match(/\+995\s?\d{3}\s?\d{2}\s?\d{2}\s?\d{2}/);
          if (geoMatch) {
            b.phone = geoMatch[0].trim();
            found++;
          }
        }

        // Extract website URL from search results
        if (!b.website) {
          // Look for links in search results that look like business websites
          const linkMatches = html.matchAll(/href="([^"]+)"[^>]*class="result__a"[^>]*>([^<]+)/g);
          for (const match of linkMatches) {
            const href = match[1];
            const text = match[2].toLowerCase();
            // Skip Google, Facebook, Instagram, Yelp, TripAdvisor, Wikipedia results
            if (href.match(/google\.|facebook\.com|instagram\.com|yelp\.com|tripadvisor|wikipedia|linkedin|twitter|x\.com|youtube|tiktok|pinterest/i)) continue;
            // Skip DuckDuckGo redirect URLs - extract the actual URL
            let actualUrl = href;
            const uddgMatch = href.match(/uddg=([^&]+)/);
            if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
            // Must be an HTTP URL
            if (actualUrl.startsWith('http')) {
              b.website = actualUrl;
              found++;
              break;
            }
          }
        }

        // Extract email from search result text
        if (!b.email) {
          const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            const junk = ['example.com', 'duckduckgo', 'googleapis', 'sentry', 'wixpress', 'cloudflare', 'schema.org'];
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, '');
              if (junk.every(j => !clean.includes(j)) && clean.length > 6 && clean.length < 80) {
                b.email = clean;
                found++;
                break;
              }
            }
          }
        }
        // Extract Facebook/Instagram from search snippets
        const snippetMatch = html.match(/class="result__snippet"[^>]*>([^<]+)/g);
        if (snippetMatch) {
          for (const s of snippetMatch) {
            const text = s.replace(/class="result__snippet"[^>]*>/, '');
            if (!b.facebook) {
              const fbMatch = text.match(/facebook\.com\/[^\s<"]+/i);
              if (fbMatch) b.facebook = 'https://' + fbMatch[0];
            }
            if (!b.instagram) {
              const igMatch = text.match(/instagram\.com\/[^\s<"]+/i);
              if (igMatch) b.instagram = 'https://' + igMatch[0];
            }
          }
        }
      } catch {}
    });
    await Promise.all(promises);
    // DuckDuckGo rate limit: be gentle
    if (i + BATCH < maxEnrich) await wait(2000);
    onProgress?.(85, `Web enrichment… ${Math.min(i + BATCH, maxEnrich)}/${maxEnrich} (${found} found)`);
  }
}

// ── Skip enrichment in discovery mode (fast count only) ──
  if (skipEnrichment) {
    onProgress?.(100, `Found ${totalBiz} businesses`);
    return results;
  }

// ── Enrichment: reverse-geocode ALL businesses for contact data ──
  const allBizList: Business[] = [];
  for (const bizs of results.values()) {
    for (const b of bizs) allBizList.push(b);
  }

  // English city name for enrichment passes
  const selectedCityEn = allBizList.length > 0 ? getEnglishCityName((allBizList[0].address || '').split(',').pop()?.trim() || '') : '';

  // ── Enrichment progress tracker ──
  const _ep: EnrichmentProgress = {
    activePass: 'Initializing…',
    passNumber: 0,
    totalPasses: 8,
    engines: [
      { name: 'DuckDuckGo', icon: '🦆', status: 'idle', found: 0 },
      { name: 'Brave', icon: '🦁', status: 'idle', found: 0 },
      ...(SERPER_API_KEY ? [{ name: 'Serper', icon: '⚡', status: 'idle' as const, found: 0 }] : []),
      ...(TAVILY_API_KEY ? [{ name: 'Tavily', icon: '🧭', status: 'idle' as const, found: 0 }] : []),
      { name: 'Bing', icon: '🔍', status: 'idle', found: 0 },
      { name: 'DDG Lite', icon: '🌐', status: 'idle', found: 0 },
      { name: '2GIS', icon: '📍', status: 'idle', found: 0 },
      { name: 'Yandex', icon: '🔴', status: 'idle', found: 0 },
      { name: 'Website Scraper', icon: '🕸️', status: 'idle', found: 0 },
    ],
    contacts: { emails: 0, phones: 0, websites: 0, social: 0, total: 0 },
    businessesProcessed: 0,
    businessesTotal: allBizList.length,
    percent: 0,
    recentBusinesses: [],
    currentBusiness: undefined,
    recentQueries: [],
  };

  // Helper: log a search query (audit trail in the live feed)
  function logQuery(q: string, engine?: string) {
    if (!q) return;
    const prefix = engine ? `[${engine}] ` : '';
    _ep.recentQueries = [`${prefix}${q}`, ..._ep.recentQueries].slice(0, 12);
  }

  // Helper: record a business as it's being parsed / finished
  const _lastEngineByBiz = new WeakMap<Business, string>();
  function lastSuccessfulEngineFor(b: Business): string | undefined {
    return _lastEngineByBiz.get(b);
  }
  function markEngine(b: Business, engine: string) {
    _lastEngineByBiz.set(b, engine);
  }

  function recordBusiness(b: Business, status: 'parsing' | 'enriched' | 'partial' | 'minimal', engine?: string) {
    const hasEmail = !!b.email;
    const hasPhone = !!b.phone;
    const hasWebsite = !!b.website;
    const hasSocial = !!(b.facebook || b.instagram);
    const entry: RecentBusiness = {
      id: b.id,
      name: b.name || 'Unnamed',
      category: b.category,
      status,
      hasEmail, hasPhone, hasWebsite, hasSocial,
      viaEngine: engine,
      ts: Date.now(),
    };
    // Remove any prior entry for same id (status update)
    _ep.recentBusinesses = [entry, ..._ep.recentBusinesses.filter(r => r.id !== b.id)].slice(0, 30);
    _ep.currentBusiness = status === 'parsing' ? {
      id: b.id,
      name: b.name || 'Unnamed',
      engine,
      stage: !hasPhone ? 'phone' : !hasEmail ? 'email' : !hasWebsite ? 'website' : !hasSocial ? 'social' : 'done',
    } : undefined;
  }

  function emitEP() {
    // Recount contacts from live data
    _ep.contacts.emails = allBizList.filter(b => b.email).length;
    _ep.contacts.phones = allBizList.filter(b => b.phone).length;
    _ep.contacts.websites = allBizList.filter(b => b.website).length;
    _ep.contacts.social = allBizList.filter(b => b.facebook || b.instagram).length;
    _ep.contacts.total = _ep.contacts.emails + _ep.contacts.phones + _ep.contacts.websites + _ep.contacts.social;
    onEnrichProgress?.({
      ..._ep,
      engines: _ep.engines.map(e => ({ ...e })),
      recentBusinesses: _ep.recentBusinesses.slice(),
      recentQueries: _ep.recentQueries.slice(),
      currentBusiness: _ep.currentBusiness ? { ..._ep.currentBusiness } : undefined,
    });
  }

  _ep.activePass = 'Filling missing addresses'; _ep.passNumber = 0; _ep.percent = 70; emitEP();
  if (allBizList.length > 0) {
    // Use Photon (separate infrastructure from Nominatim) for address filling
    // This NEVER conflicts with city search rate limits
    const maxEnrich = Math.min(allBizList.length, 150);
    const CONCURRENCY = 5; // Photon allows more parallel requests
    for (let i = 0; i < maxEnrich; i += CONCURRENCY) {
      if (isCancelled()) break;
      const batch = allBizList.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (b) => {
        if (b.address) return; // already has address
        try {
          const r = await fetch(`https://photon.komoot.io/reverse?lat=${b.lat}&lon=${b.lon}&lang=en`, {
            signal: AbortSignal.timeout(3000),
          });
          if (r.ok) {
            const d = await r.json();
            const f = d.features?.[0]?.properties;
            if (f) {
              const parts = [f.name, f.housenumber, f.district || f.locality, f.city].filter(Boolean);
              b.address = parts.join(', ') || '';
            }
          }
        } catch {}
      }));
      if (i + CONCURRENCY < maxEnrich) await wait(500);
      onProgress?.(75, `Filling addresses… ${Math.min(i + CONCURRENCY, maxEnrich)}/${maxEnrich}`);
      _ep.businessesProcessed = Math.min(i + CONCURRENCY, maxEnrich);
      emitEP();
    }
  }

  onProgress?.(80, `Found ${totalBiz} businesses — enriching data in parallel…`);

  // ── Per-business enrichment pipeline ──
  // Priority: Brave API → scrape website → DDG → scrape → Bing → DDG Lite → social → regional
  // Each business follows the SAME priority chain, maximizing data per business
  if (isCancelled()) { onProgress?.(100, 'Cancelled'); return results; }

  const NEEDS_ENRICHMENT = allBizList.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  const maxEnrich = Math.min(NEEDS_ENRICHMENT.length, 200);
  const _EXCLUDE = /example\.com|wixpress|sentry\.io|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress/i;

  _ep.activePass = 'Enriching contacts (priority pipeline)'; _ep.passNumber = 1; _ep.percent = 80;
  _ep.engines.forEach(e => { e.status = 'active'; e.found = 0; });
  emitEP();

  const _BATCH = 10;
  let enrichedCount = 0;

  for (let i = 0; i < maxEnrich; i += _BATCH) {
    if (isCancelled()) break;
    const batch = NEEDS_ENRICHMENT.slice(i, i + _BATCH);
    // ── Live discovery feed: mark these businesses as currently being parsed ──
    batch.forEach(b => recordBusiness(b, 'parsing'));
    logQuery(buildSearchQuery(batch[0]), `${batch.length} businesses`);
    await Promise.all(batch.map(async (b) => {
      try {
        // Helper: check if business has sufficient data (phone OR email + website)
        const hasSufficientData = () => (b.phone && b.email) || (b.phone && b.website) || (b.email && b.website);
        let websiteScraped = false;
        const scrapeWebsiteOnce = async () => {
          if (websiteScraped || !b.website) return;
          websiteScraped = true;
          if (!b.email || !b.phone || !b.facebook) {
            try { await enrichFromWebsiteDeep(b); } catch {}
          }
          if (!b.email && b.website) {
            try { await scrapeContactPageForEmail(b); } catch {}
          }
        };

        // ═══ PHASE 1: ALL search engines in PARALLEL (3-4s total, not 20s) ═══
        const q = buildSearchQuery(b);
        await Promise.all([
          // Brave API
          (async () => {
            try {
              const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
                headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
                signal: AbortSignal.timeout(3000),
              });
              if (r.ok) {
                const data = await r.json();
                let touched = false;
                for (const res of (data.web?.results || [])) {
                  if (extractFromText((res.description || '') + ' ' + (res.title || ''), b)) touched = true;
                  if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('google.com/maps') && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
                }
                if (!b.website && data.knowledge_graph?.url && !_EXCLUDE.test(data.knowledge_graph.url)) b.website = data.knowledge_graph.url;
                if (touched || b.website) markEngine(b, 'Brave');
              }
            } catch {}
          })(),
          // DuckDuckGo HTML
          (async () => {
            try {
              const r = await corsFetch('https://html.duckduckgo.com/html/?q=' + q, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(4000),
              });
              if (r.ok && extractFromHtml(await r.text(), b)) markEngine(b, 'DuckDuckGo');
            } catch {}
          })(),
          // Bing
          (async () => {
            try {
              const bingResults = await searchBing(q);
              let touched = false;
              for (const res of bingResults) {
                if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) touched = true;
                if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('bing.com') && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
              }
              if (touched || b.website) markEngine(b, 'Bing');
            } catch {}
          })(),
          // DDG Lite
          (async () => {
            try {
              const spResults = await searchDDGLite(decodeURIComponent(q));
              let touched = false;
              for (const res of spResults) {
                if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) touched = true;
                if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('duckduckgo.com/lite') && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
              }
              if (touched || b.website) markEngine(b, 'DDG Lite');
            } catch {}
          })(),
          // Serper (Google SERP API — free tier, optional key)
          ...(SERPER_API_KEY ? [(async () => {
            const before = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            await enrichFromSerper([b]);
            const after = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            if (before !== after) markEngine(b, 'Serper');
          })()] : []),
          // Tavily (AI search API — free tier, optional key)
          ...(TAVILY_API_KEY ? [(async () => {
            const before = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            await enrichFromTavily([b]);
            const after = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            if (before !== after) markEngine(b, 'Tavily');
          })()] : []),
        ]);

        // ═══ PHASE 2: Scrape website ONCE ═══
        await scrapeWebsiteOnce();

        // EARLY EXIT
        if (hasSufficientData()) { enrichedCount++; return; }

        // ═══ PHASE 3: Email-focused search (targets contact pages) ═══
        if (!b.email) {
          const emailQ = buildEmailQuery(b);
          await Promise.all([
            (async () => {
              try {
                const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${emailQ}&count=5`, {
                  headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
                  signal: AbortSignal.timeout(3000),
                });
                if (r.ok) {
                  const data = await r.json();
                  for (const res of (data.web?.results || [])) {
                    extractFromText((res.description || '') + ' ' + (res.title || ''), b);
                    if (!b.email && res.url && /contact|about|team/i.test(res.url)) {
                      try {
                        const pageR = await corsFetch(res.url, { signal: AbortSignal.timeout(3000) });
                        if (pageR.ok) extractFromHtml(await pageR.text(), b);
                      } catch {}
                    }
                  }
                }
              } catch {}
            })(),
            (async () => {
              try {
                const r = await corsFetch('https://html.duckduckgo.com/html/?q=' + emailQ, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(4000),
                });
                if (r.ok) extractFromHtml(await r.text(), b);
              } catch {}
            })(),
          ]);
        }

        // EARLY EXIT
        if (hasSufficientData()) { enrichedCount++; return; }

        // ═══ PHASE 4: Domain probing + contact page email search ═══
        if (!b.website) {
          try { await probeDomains(b); } catch {}
          await scrapeWebsiteOnce();
        }

        if (!b.email && b.website) {
          if (!websiteScraped) {
            try { await scrapeContactPageForEmail(b); } catch {}
          }
          // Try common email patterns by scraping contact pages
          if (!b.email) {
            try { await tryCommonEmailPatterns(b); } catch {}
          }
        }

        // ═══ PHASE 5: Social media (only if still missing) ═══
        if (!b.facebook && !b.instagram && !hasSufficientData()) {
          try {
            const nameEn2 = getEnglishCityName(b.name);
            const cityEn2 = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
            const parts2 = ["'" + (nameEn2 || b.name) + "'"];
            if (cityEn2) parts2.push(cityEn2);
            parts2.push('facebook instagram social');
            const sq = encodeURIComponent(parts2.join(' '));
            const sr = await corsFetch('https://html.duckduckgo.com/html/?q=' + sq, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(3000),
            });
            if (sr.ok) extractFromHtml(await sr.text(), b);
          } catch {}
        }

        if (b.phone || b.email || b.website) enrichedCount++;
        // ── Live discovery feed: record finished business ──
        const fieldsFound = [b.email, b.phone, b.website, b.facebook || b.instagram].filter(Boolean).length;
        const finalStatus: 'parsing' | 'enriched' | 'partial' | 'minimal' =
          fieldsFound >= 3 ? 'enriched' : fieldsFound >= 1 ? 'partial' : 'minimal';
        recordBusiness(b, finalStatus, lastSuccessfulEngineFor(b));
      } catch {}
    }));

    if (i + _BATCH < maxEnrich) await wait(200);
    _ep.businessesProcessed = Math.min(i + _BATCH, maxEnrich);
    _ep.engines.find(e => e.name === 'DuckDuckGo')!.found = _ep.contacts.emails;
    _ep.engines.find(e => e.name === 'Brave')!.found = _ep.contacts.phones;
    _ep.engines.find(e => e.name === 'Bing')!.found = _ep.contacts.websites;
    _ep.engines.find(e => e.name === 'Website Scraper')!.found = _ep.contacts.social;
    emitEP();
    onProgress?.(80 + Math.round(10 * Math.min(i + _BATCH, maxEnrich) / maxEnrich),
      `Enriching… ${Math.min(i + _BATCH, maxEnrich)}/${maxEnrich} (📧${_ep.contacts.emails} 📞${_ep.contacts.phones} 🌐${_ep.contacts.websites} 👤${_ep.contacts.social})`);
  }

  _ep.engines.find(e => e.name === 'DuckDuckGo')!.status = 'done';
  _ep.engines.find(e => e.name === 'Brave')!.status = 'done';
  _ep.engines.find(e => e.name === 'Bing')!.status = 'done';
  _ep.engines.find(e => e.name === 'DDG Lite')!.status = 'done';

  if (isCancelled()) { onProgress?.(100, 'Cancelled'); return results; }

  // ═══ Regional fallbacks for businesses with zero data ═══

  // ── 2GIS (excellent for Georgia, Russia, CIS countries) ──
  const need2GIS = allBizList.filter(b => !b.phone && !b.email && !b.website);
  if (need2GIS.length > 0) {
    _ep.activePass = 'Pass 2: Regional (2GIS)'; _ep.passNumber = 2; _ep.percent = 92;
    _ep.engines.find(e => e.name === '2GIS')!.status = 'active'; emitEP();
    for (let i2 = 0; i2 < Math.min(need2GIS.length, 40); i2 += _BATCH) {
      if (isCancelled()) break;
      const batch2 = need2GIS.slice(i2, i2 + _BATCH);
      await Promise.all(batch2.map(async (b) => {
        try {
          const nameEn3 = getEnglishCityName(b.name);
          const q2 = encodeURIComponent((nameEn3 || b.name) + ' ' + (b.address?.split(',').pop() || ''));
          const r2 = await corsFetch('https://catalog.api.2gis.com/3.0/items?q=' + q2 + '&key=rurbbn3446&fields=items.contact_groups,items.reviews', {
            signal: AbortSignal.timeout(6000),
          });
          if (r2.ok) {
            const d2 = await r2.json();
            const items2 = d2.result?.items || [];
            for (const item of items2) {
              const itemName = (item.name || '').toLowerCase();
              const bizName = (nameEn3 || b.name).toLowerCase();
              if (itemName.includes(bizName.substring(0, 5)) || bizName.includes(itemName.substring(0, 5))) {
                if (!b.phone && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of (grp.contacts || [])) {
                      if (contact.type === 'phone' && contact.value && contact.value.replace(/\D/g, '').length >= 8) {
                        b.phone = contact.value;
                      }
                    }
                  }
                }
                if (!b.website && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of (grp.contacts || [])) {
                      if (contact.type === 'website' && contact.value && !contact.value.includes('2gis.com')) {
                        b.website = contact.value.startsWith('http') ? contact.value : 'https://' + contact.value;
                      }
                    }
                  }
                }
                if (!b.address && item.address_name) b.address = item.address_name;
                break;
              }
            }
          }
        } catch {}
      }));
      if (i2 + _BATCH < need2GIS.length) await wait(1000);
    }
    _ep.engines.find(e => e.name === '2GIS')!.status = 'done'; emitEP();
  }

  // ── Yandex (dominant in Georgia/Russia/CIS) ──
  const needYandex = allBizList.filter(b => !b.phone && !b.email && !b.website);
  if (needYandex.length > 0) {
    _ep.activePass = 'Pass 3: Regional (Yandex)'; _ep.passNumber = 3; _ep.percent = 94;
    _ep.engines.find(e => e.name === 'Yandex')!.status = 'active'; emitEP();
    for (let i3 = 0; i3 < Math.min(needYandex.length, 30); i3 += _BATCH) {
      if (isCancelled()) break;
      const batch3 = needYandex.slice(i3, i3 + _BATCH);
      await Promise.all(batch3.map(async (b) => {
        try {
          const nameEn4 = getEnglishCityName(b.name);
          const cityEn3 = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
          const q3 = encodeURIComponent(`site:yandex.* ${nameEn4 || b.name} ${cityEn3 || ''} phone`);
          const r3 = await corsFetch('https://html.duckduckgo.com/html/?q=' + q3, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(6000),
          });
          if (r3.ok) {
            const html3 = await r3.text();
            extractFromHtml(html3, b);
          }
        } catch {}
      }));
      if (i3 + _BATCH < needYandex.length) await wait(1200);
    }
    _ep.engines.find(e => e.name === 'Yandex')!.status = 'done'; emitEP();
  }

  // ── Pass 4: Verification (keyless 2026 additions) ──
  // Wikidata SPARQL: official contacts for notable businesses (chains, hotels)
  const needVerify = allBizList.filter(b => b.website && (!b.email || !b.phone));
  if (needVerify.length > 0) {
    _ep.activePass = 'Pass 4: Verify (Wikidata + Wayback)'; _ep.passNumber = 4; _ep.percent = 96;
    const wdEngine: EngineStatus = { name: 'Wikidata', icon: '🔗', status: 'active', found: 0 };
    _ep.engines.push(wdEngine); emitEP();
    const maxVerify = Math.min(needVerify.length, 24);
    for (let i4 = 0; i4 < maxVerify; i4 += _BATCH) {
      if (isCancelled()) break;
      const batch4 = needVerify.slice(i4, i4 + _BATCH);
      await Promise.all(batch4.map(async (b) => {
        const before = b.email + '|' + b.phone;
        await wikidataContacts(b);
        if (b.email + '|' + b.phone !== before) wdEngine.found++;
      }));
      if (i4 + _BATCH < maxVerify) await wait(1500);
      emitEP();
    }
    wdEngine.status = 'done'; emitEP();
    // Wayback: recover contacts for dead/unreachable websites
    const deadSites = allBizList.filter(b => b.website && !b.email && !b.phone && !b.facebook).slice(0, 15);
    if (deadSites.length > 0) {
      const wbEngine: EngineStatus = { name: 'Wayback', icon: '🕰️', status: 'active', found: 0 };
      _ep.engines.push(wbEngine); emitEP();
      for (const b of deadSites) {
        if (isCancelled()) break;
        const before = b.email + '|' + b.phone;
        await waybackContacts(b);
        if (b.email + '|' + b.phone !== before) wbEngine.found++;
        emitEP();
      }
      wbEngine.status = 'done'; emitEP();
    }
  }

  _ep.activePass = 'Complete'; _ep.percent = 100;
  _ep.engines.forEach(e => { if (e.status === 'active') e.status = 'done'; });
  _ep.engines.find(e => e.name === 'Website Scraper')!.status = 'done';
  emitEP();
  return results;
}


// ─── AI-Powered Opportunity Analysis ───────────────────────────
// Uses Pollinations (free, keyless LLM) for genuine model-generated
// analysis. Falls back to a deterministic data brief (labeled as such by
// the caller) — the two paths are visually distinguished in the UI.
// ─── Discovery phases (Demand signals → Scoring → AI) ──────────
// Streams DiscoveryProgress updates to onProgress so the UI can render
// each phase in real time. Returns the final opportunity list.
export async function runDiscoveryPhases(
  businesses: Map<string, Business[]>,
  population: number,
  cityName: string,
  countryName: string,
  onProgress?: (dp: DiscoveryProgress) => void,
  abortSignal?: AbortSignal,
): Promise<{ opportunities: OpportunityResult[]; demandSignals: Map<string, DemandSignal>; aiInsights: string; aiAnalysis?: AIAnalysis }> {
  const isCancelled = () => abortSignal?.aborted ?? false;

  // Identify top categories by existing business count
  const topCats = Array.from(businesses.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([cat]) => cat);

  const _dp: DiscoveryProgress = {
    phase: 'demand',
    osmBatches: {
      foodHealth:  { status: 'done', found: 0 },
      shopsRetail: { status: 'done', found: 0 },
      hotelsGyms:  { status: 'done', found: 0 },
    },
    totalFound: Array.from(businesses.values()).reduce((s, a) => s + a.length, 0),
    demand: topCats.map(c => ({ category: c, label: getCategoryLabel(c), status: 'pending' as const })),
    demandTotal: topCats.length,
    demandDone: 0,
    topOpps: [],
    ai: 'idle',
    percent: 70,
    recentQueries: [],
  };
  function emitDP(overrides?: Partial<DiscoveryProgress>) {
    if (!onProgress) return;
    onProgress({ ..._dp, ...overrides,
      osmBatches: { ..._dp.osmBatches },
      demand: _dp.demand.slice(),
      topOpps: _dp.topOpps.slice(),
      recentQueries: _dp.recentQueries.slice(),
    });
  }
  emitDP();

  // Phase B: measure demand signals in parallel (incremental)
  const signals = new Map<string, DemandSignal>();
  const catLabelFor = (cat: string) => getCategoryLabel(cat);
  await Promise.all(topCats.map(async (cat, i) => {
    if (isCancelled()) return;
    _dp.demand[i] = { ..._dp.demand[i], status: 'measuring' };
    const label = catLabelFor(cat);
    const q = `${label} ${cityName}`;
    _dp.recentQueries = [`[demand] ${q}`, ..._dp.recentQueries].slice(0, 8);
    emitDP();
    try {
      const sig = await getDemandSignals(label, cityName);
      signals.set(cat, sig);
      const sources: string[] = [];
      if (sig.wikipedia > 0) sources.push('wikipedia');
      if (sig.reddit > 0) sources.push('reddit');
      if (sig.webSearch > 0) sources.push('web');
      _dp.demand[i] = { category: cat, label, status: 'done', score: sig.score, sources };
    } catch {
      _dp.demand[i] = { category: cat, label, status: 'error' };
    }
    _dp.demandDone++;
    emitDP({ percent: 70 + Math.round(15 * _dp.demandDone / Math.max(_dp.demandTotal, 1)) });
  }));
  if (isCancelled()) return { opportunities: [], demandSignals: new Map(), aiInsights: '' };

  // Phase C: compute opportunity scores (incremental — emit after each)
  _dp.phase = 'score';
  emitDP({ percent: 86 });
  const opportunities = computeOpportunities(businesses, population, signals);

  // Top-5 leaderboard + biggest-gap callout
  const sorted = [...opportunities].sort((a, b) => b.score - a.score);
  _dp.topOpps = sorted.slice(0, 5).map(o => ({
    category: o.category,
    categoryLabel: o.categoryLabel,
    existing: o.existing,
    gap: o.gap ?? 0,
    score: o.score,
  }));
  const gapSorted = [...opportunities].filter(o => (o.gap ?? 0) > 0).sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0));
  const biggest = gapSorted[0];
  if (biggest) {
    _dp.biggestGap = {
      categoryLabel: biggest.categoryLabel,
      gap: biggest.gap ?? 0,
      existing: biggest.existing,
      score: biggest.score,
    };
  }
  emitDP({ percent: 90 });

  // Phase D: smart AI analysis (structured insights/patterns/risks/actions)
  _dp.phase = 'ai';
  _dp.ai = 'thinking';
  emitDP({ percent: 92 });
  let aiInsights = '';
  let aiAnalysis: AIAnalysis | undefined;
  try {
    const facts = computeMarketFacts(businesses, population, cityName, countryName, signals);
    // Attach real opportunity scores to the facts (LLM sees exact numbers)
    const scoreByCat = new Map(opportunities.map(o => [o.category, o.score]));
    facts.categories.forEach(c => { c.score = scoreByCat.get(c.category) ?? 0; });
    const analysis = await getSmartAIAnalysis(facts, opportunities, { signal: abortSignal });
    aiAnalysis = analysis;
    aiInsights = analysis.insights.map(i => `**${i.title}** — ${i.detail}`).join('\n\n');
    _dp.ai = 'done';
    _dp.aiPreview = analysis.insights[0]
      ? `${analysis.insights[0].title}: ${analysis.insights[0].detail}`.slice(0, 140)
      : 'Analysis complete';
    _dp.aiInsightsFull = analysis; // full structured result for the UI
  } catch {
    _dp.ai = 'error';
  }
  emitDP({ percent: 100, phase: 'done' });
  return { opportunities, demandSignals: signals, aiInsights, aiAnalysis };
}

export async function getAIAnalysis(
  cityName: string,
  countryName: string,
  topOpps: Array<{ category: string; label: string; existing: number; gap: number | null; score: number }>,
  population: number
): Promise<string> {
  try {
    // Build a prompt from the data
    const oppText = topOpps.slice(0, 8).map(o =>
      `${o.label}: ${o.existing} existing, gap of ${o.gap ?? 'unknown (no population data)'}, score ${o.score}/100`
    ).join('\n');

    const prompt = `You are a market analyst. Analyze business opportunities in ${cityName}, ${countryName} (population ${population.toLocaleString()}). Market data (businesses found, estimated supply gap, opportunity score):\n${oppText}\n\nProvide 3-5 concise, specific insights about the best opportunities, underserved segments, and risks. Use only the numbers given. Format as bullet points.`;

    // Pollinations text API: GET https://text.pollinations.ai/<prompt>
    const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt), {
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error('pollinations ' + r.status);
    const text = (await r.text()).trim();
    // Real model output: substantive, not an error page
    if (text && text.length > 120 && !/^\s*<!doctype|<html/i.test(text)) {
      return text;
    }
    // Fallback: deterministic brief from the same real data
    return generateLocalAnalysis(cityName, countryName, topOpps, population);
  } catch {
    return generateLocalAnalysis(cityName, countryName, topOpps, population);
  }
}

// Local analysis fallback (no API needed) — deterministic brief from real
// data, clearly labeled by the caller as data-derived (not model output)
function generateLocalAnalysis(
  cityName: string,
  countryName: string,
  topOpps: Array<{ category: string; label: string; existing: number; gap: number | null; score: number }>,
  population: number
): string {
  const insights: string[] = [];

  // Find biggest gap (null gaps = unknown population, excluded)
  const gapped = topOpps.filter(o => o.gap != null);
  const biggestGap = gapped.length
    ? gapped.reduce((best, o) => (o.gap as number) > (best.gap as number) ? o : best, gapped[0])
    : null;
  if (biggestGap) {
    insights.push(`🔍 **Biggest opportunity**: ${biggestGap.label} — only ${biggestGap.existing} exist but ${(biggestGap.gap as number) + biggestGap.existing} are expected for a city of ${population.toLocaleString()}. Gap score: ${biggestGap.score}/100.`);
  }

  // Find underserved categories
  const underserved = topOpps.filter(o => o.score >= 60);
  if (underserved.length > 0) {
    insights.push(`📊 **${underserved.length} underserved categories** (score ≥60): ${underserved.map(o => o.label).join(', ')}.`);
  }

  // Market density (only meaningful with real population)
  const totalExisting = topOpps.reduce((s, o) => s + o.existing, 0);
  if (population > 0) {
    const per10k = ((totalExisting / population) * 10000).toFixed(1);
    insights.push(`📈 Market density: ${totalExisting} businesses across ${topOpps.length} categories = ${per10k} per 10k residents.`);
  }

  // Competition level
  const lowComp = topOpps.filter(o => o.existing < 5);
  if (lowComp.length > 0) {
    insights.push(`🏆 **Low competition** (<5 businesses): ${lowComp.map(o => o.label).join(', ')}. First-mover advantage available.`);
  }

  // Population insight (only with real population)
  if (population > 500000) {
    insights.push(`👥 Large population (${(population/1000000).toFixed(1)}M) supports specialized niches — consider premium/quality positioning.`);
  } else if (population > 0 && population < 100000) {
    insights.push(`🏘️ Smaller market (${population.toLocaleString()}) — focus on essential services with proven demand.`);
  }

  return insights.join('\n\n');
}


// ═════════════════════════════════════════════════════════════════
// ─── Smart AI Engine (OpenRouter, free tier) ─────────────────────
// Multi-turn reasoning over the REAL scan data with:
//   1. Model fallback chain (handles upstream 429 rate limits)
//   2. Structured JSON output (typed insights/patterns/risks/actions)
//   3. Domain-aware prompts (market-analysis + pattern detection)
//   4. Automatic retry with exponential backoff
//   5. Deterministic fallback when ALL models are down
// ═════════════════════════════════════════════════════════════════

const OPENROUTER_API_KEY = (import.meta as any).env?.VITE_OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = (import.meta as any).env?.VITE_OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

// Ordered chain: try the configured model first, then the known-good
// free-tier models as fallbacks. This keeps the app usable when one
// provider is upstream-rate-limited (common on free tiers).
const AI_MODEL_CHAIN: string[] = [
  OPENROUTER_MODEL,
  'google/gemma-4-31b-it:free',
  'minimax/minimax-m2.7:free',
  'z-ai/glm-5.2:free',
];

// One shared call site: sends a chat completion, walks the model chain on
// 429/5xx, retries with exponential backoff, and returns raw text.
// `validate` lets callers reject a successful-but-unusable reply (e.g. JSON
// that didn't parse) so the chain moves on to the next model instead of
// returning garbage.
async function llmCall(
  systemPrompt: string,
  userPrompt: string,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    validate?: (text: string) => boolean;
  },
): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error('no-key');
  const maxTokens = opts?.maxTokens ?? 900;
  const temperature = opts?.temperature ?? 0.3;
  const validate = opts?.validate;

  for (let mi = 0; mi < AI_MODEL_CHAIN.length; mi++) {
    const model = AI_MODEL_CHAIN[mi];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts?.signal?.aborted) throw new Error('Cancelled');
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: maxTokens,
            temperature,
          }),
          signal: opts?.signal ?? AbortSignal.timeout(45000),
        });

        if (r.ok) {
          const d = await r.json();
          const text = d?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim().length > 0) {
            // If the caller supplied a validator and the reply fails it,
            // treat this model as unusable for this request and move on.
            if (validate && !validate(text)) {
              break;
            }
            return text;
          }
          // Empty reply — try next model
          break;
        }

        // Rate-limited upstream — brief pause then retry same model
        if (r.status === 429) {
          await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
          continue;
        }
        // 4xx (except 429) or 5xx — try next model in chain
        break;
      } catch (e: any) {
        if (e?.name === 'AbortError' || e?.message === 'Cancelled') throw new Error('Cancelled');
        // network error — try next model
        break;
      }
    }
  }
  throw new Error('all-models-failed');
}

// Strip reasoning blocks some free models emit (<think>…</think>, etc.)
function stripThinkBlocks(t: string): string {
  return t
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|?begin_of_thought\|?>[\s\S]*?<\|?end_of_thought\|?>/gi, '')
    .trim();
}

// Extract the first JSON object/array from an LLM reply that may be wrapped
// in markdown fences, <think> blocks, or prose. Returns null when no JSON found.
function extractJson(text: string): any | null {
  // Strip reasoning blocks first — some free models (GLM, Qwen) emit them
  let cleaned = stripThinkBlocks(String(text || ''));
  // Strip markdown code fences
  cleaned = cleaned.replace(/```(?:json)?/gi, '').trim();
  // Try whole-string parse first
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  // Then find the outermost {...} or [...]
  const objStart = cleaned.indexOf('{');
  const arrStart = cleaned.indexOf('[');
  const start = objStart === -1 ? arrStart
    : arrStart === -1 ? objStart
    : Math.min(objStart, arrStart);
  if (start === -1) return null;
  const objEnd = cleaned.lastIndexOf('}');
  const arrEnd = cleaned.lastIndexOf(']');
  const end = objEnd === -1 ? arrEnd
    : arrEnd === -1 ? objEnd
    : Math.max(objEnd, arrEnd);
  if (end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { /* fall through */ }
  // Repair pass: strip trailing commas (common free-model quirk)
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

// ─── Typed AI output ────────────────────────────────────────────
export interface AIInsight {
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  categories?: string[];
}
export interface AIPattern {
  name: string;
  description: string;
  categories?: string[];
}
export interface AIAction {
  action: string;
  rationale: string;
  timeframe?: string;
}
export interface AIAnalysis {
  model: string;           // model id that produced this output
  insights: AIInsight[];
  patterns: AIPattern[];
  risks: string[];
  actions: AIAction[];
  isAI: boolean;           // false => deterministic fallback was used
}

// Statistical pre-computation fed to the LLM as compact facts. Detecting
// patterns BEFORE the model call (a) shrinks the prompt, (b) grounds the
// model in real numbers, (c) keeps output tied to this app's data.
export interface MarketFacts {
  cityName: string;
  countryName: string;
  population: number;
  totalBusinesses: number;
  categories: Array<{
    category: string;
    label: string;
    existing: number;
    per10k: number;
    expected: number | null;
    gap: number | null;
    score: number;
    demandScore?: number;
    demandSources?: string[];
  }>;
  // Pre-computed patterns (deterministic, from real data)
  saturationCluster: string[];   // categories ≥ 2× baseline density
  underservedCluster: string[];  // categories with gap ≥ 25% of expected
  lowCompetition: string[];      // < 5 existing businesses
  hubStats: {                    // geo-clustering from business coordinates
    clusters: number;
    dominant: string | null;     // label of biggest cluster
    concentration: number;       // 0-100, share of businesses in top cluster
  };
  contactCoverage: { emails: number; phones: number; websites: number };
}

// Deterministic pattern detection over the real scan results — the numbers
// the LLM reasons over, computed locally so they are always exact.
export function computeMarketFacts(
  businesses: Map<string, Business[]>,
  population: number,
  cityName: string,
  countryName: string,
  demandSignals?: Map<string, DemandSignal>,
): MarketFacts {
  const totalBusinesses = Array.from(businesses.values()).reduce((s, a) => s + a.length, 0);

  // Per-category stats. Expected/gap mirror the exact baselines used by
  // computeOpportunities() so facts and scores stay consistent.
  const pop = population > 0 ? population : null;
  const per10kValues: number[] = [];
  for (const [, bizs] of businesses) {
    per10kValues.push((bizs.length / Math.max(pop || 1, 1)) * 10000);
  }
  per10kValues.sort((a, b) => a - b);
  const cityMedian = per10kValues.length > 0
    ? per10kValues[Math.floor(per10kValues.length / 2)]
    : 5;
  const BASELINES: Record<string, number> = {
    cafe: 4, restaurant: 5, bar: 2, pub: 1.5, fast_food: 3,
    hotel: 1, gym: 1.5, beauty_salon: 2, hair_salon: 2,
    pharmacy: 1.5, bank: 1, supermarket: 1.5, clothing: 3,
    electronics: 2, bakery: 1.5, cinema: 0.3,
  };

  const cats: MarketFacts['categories'] = [];
  const saturationCluster: string[] = [];
  const underservedCluster: string[] = [];
  const lowCompetition: string[] = [];
  for (const [cat, bizs] of businesses) {
    const existing = bizs.length;
    const per10k = pop ? (existing / pop) * 10000 : 0;
    const demand = demandSignals?.get(cat);
    const baseline = BASELINES[cat] || cityMedian;
    const expected = pop ? Math.round((baseline * pop) / 10000) : null;
    const gap = expected != null ? Math.max(0, expected - existing) : null;

    cats.push({
      category: cat,
      label: getCategoryLabel(cat),
      existing, per10k: Math.round(per10k * 100) / 100, expected, gap,
      score: 0, // filled by caller from opportunities list
      demandScore: demand?.score,
      demandSources: demand?.sources,
    });

    if (per10k > 0 && existing >= 8 && per10k >= 4) saturationCluster.push(cat);
    if (gap != null && gap / Math.max(expected ?? 1, 1) >= 0.25) underservedCluster.push(cat);
    if (existing > 0 && existing < 5) lowCompetition.push(cat);
  }

  // Geo-clustering: rough density detection via lat/lon grid cells
  const gridCells = new Map<string, number>();
  const gridLabels = new Map<string, string>();
  let totalPoints = 0;
  for (const [cat, bizs] of businesses) {
    for (const b of bizs) {
      const cell = `${Math.round(b.lat * 50)}_${Math.round(b.lon * 50)}`;
      gridCells.set(cell, (gridCells.get(cell) || 0) + 1);
      if (!gridLabels.has(cell)) gridLabels.set(cell, getCategoryLabel(cat));
      totalPoints++;
    }
  }
  const clusters = Array.from(gridCells.values()).filter(n => n >= 5).length;
  const topCell = Array.from(gridCells.entries()).sort((a, b) => b[1] - a[1])[0];
  const concentration = totalPoints > 0 && topCell ? Math.round((topCell[1] / totalPoints) * 100) : 0;

  // Contact coverage (enrichment results)
  let emails = 0, phones = 0, websites = 0;
  for (const bizs of businesses.values()) {
    for (const b of bizs) {
      if (b.email) emails++;
      if (b.phone) phones++;
      if (b.website) websites++;
    }
  }

  return {
    cityName, countryName, population, totalBusinesses, categories: cats,
    saturationCluster, underservedCluster, lowCompetition,
    hubStats: {
      clusters,
      dominant: topCell ? gridLabels.get(topCell[0]) ?? null : null,
      concentration,
    },
    contactCoverage: { emails, phones, websites },
  };
}

// Compact facts → prompt text. Numbers stay exact; no rounding of inputs.
function factsToPrompt(f: MarketFacts, opps: OpportunityResult[]): string {
  const catLines = f.categories
    .slice(0, 18)
    .map(c => {
      const opp = opps.find(o => o.category === c.category);
      const gapTxt = c.gap != null ? `gap=${c.gap}` : 'gap=unknown';
      const demTxt = c.demandScore != null ? ` demand=${c.demandScore}/100${c.demandSources?.length ? ` (${c.demandSources.join('+')})` : ''}` : '';
      return `- ${c.label} (${c.category}): existing=${c.existing}, per10k=${c.per10k}, ${gapTxt}, score=${opp?.score ?? '?'}/100${demTxt}`;
    })
    .join('\n');

  const satTxt = f.saturationCluster.length ? f.saturationCluster.map(c => getCategoryLabel(c)).join(', ') : 'none';
  const undTxt = f.underservedCluster.length ? f.underservedCluster.map(c => getCategoryLabel(c)).join(', ') : 'none';
  const lowTxt = f.lowCompetition.length ? f.lowCompetition.map(c => getCategoryLabel(c)).join(', ') : 'none';

  return `CITY: ${f.cityName}, ${f.countryName}
POPULATION: ${f.population > 0 ? f.population.toLocaleString() : 'unknown'}
TOTAL BUSINESSES SCANNED: ${f.totalBusinesses}

CATEGORY DATA (top ${Math.min(f.categories.length, 18)}):
${catLines}

PRE-DETECTED PATTERNS (deterministic, from real data):
- Saturated (high density ≥4/10k with ≥8 existing): ${satTxt}
- Underserved (gap ≥25% of expected): ${undTxt}
- Low competition (<5 existing): ${lowTxt}
- Geo-clusters detected: ${f.hubStats.clusters} (dominant: ${f.hubStats.dominant ?? 'none'}, concentration ${f.hubStats.concentration}%)
- Contact coverage: ${f.contactCoverage.emails} emails, ${f.contactCoverage.phones} phones, ${f.contactCoverage.websites} websites`;

}

// System prompt — domain-tuned for market-opportunity analysis.
const AI_SYSTEM_PROMPT = `You are a senior market analyst specializing in blue-ocean opportunity discovery for small businesses.

You analyze real OpenStreetMap scan data about businesses in a city, plus measured demand signals from Wikipedia, Reddit, and web search.

Your job:
1. Find non-obvious PATTERNS in the data (complementary-category pairs, saturation vs gap asymmetries, geo-clustering effects, demographic implications).
2. Identify specific OPPORTUNITY INSIGHTS with severity ratings.
3. Flag RISKS and caveats (population unknown, sample bias, OSM coverage gaps).
4. Recommend concrete NEXT ACTIONS with rationale and timeframe.

Rules:
- Use ONLY the numbers given. NEVER invent statistics.
- When population is unknown, treat gap/expected as unreliable.
- Be specific: prefer "this city has 3x fewer gyms per capita than the median city" style over generic advice.
- Keep every string under 200 chars. Be concise but analytical.`;

// Main entry: runs the full AI analysis pipeline.
export async function getSmartAIAnalysis(
  facts: MarketFacts,
  opportunities: OpportunityResult[],
  opts?: { signal?: AbortSignal },
): Promise<AIAnalysis> {
  const userPrompt = factsToPrompt(facts, opportunities) + `

TASK: Analyze this market data and return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:
{
  "insights": [
    {"title": "string", "detail": "string", "severity": "high" | "medium" | "low", "categories": ["cat_id", ...]}
  ],
  "patterns": [
    {"name": "string", "description": "string", "categories": ["cat_id", ...]}
  ],
  "risks": ["string", ...],
  "actions": [
    {"action": "string", "rationale": "string", "timeframe": "immediate" | "1-3 months" | "6-12 months"}
  ]
}

Generate 3-5 insights, 2-4 patterns, 2-3 risks, 2-4 actions. Every claim must trace back to the numbers above.`;

  try {
    // Walk the model chain; a reply only counts when its JSON parses AND
    // contains at least one usable insight/pattern — otherwise the chain
    // moves to the next model instead of feeding garbage downstream.
    const raw = await llmCall(AI_SYSTEM_PROMPT, userPrompt, {
      maxTokens: 3000,
      temperature: 0.4,
      signal: opts?.signal,
      validate: (text) => {
        const parsed = extractJson(text);
        return !!parsed
          && Array.isArray(parsed.insights)
          && parsed.insights.length > 0
          && Array.isArray(parsed.patterns)
          && parsed.patterns.length > 0;
      },
    });
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('no-json');

    // Validate + normalize the model output
    const insights: AIInsight[] = (parsed.insights || [])
      .filter((x: any) => x && typeof x.title === 'string' && typeof x.detail === 'string')
      .slice(0, 5)
      .map((x: any) => ({
        title: String(x.title).slice(0, 120),
        detail: String(x.detail).slice(0, 400),
        severity: (['high', 'medium', 'low'] as const).includes(x.severity) ? x.severity : 'medium',
        categories: Array.isArray(x.categories)
          ? x.categories.filter((c: any) => typeof c === 'string').slice(0, 4)
          : undefined,
      }));
    const patterns: AIPattern[] = (parsed.patterns || [])
      .filter((x: any) => x && typeof x.name === 'string' && typeof x.description === 'string')
      .slice(0, 4)
      .map((x: any) => ({
        name: String(x.name).slice(0, 120),
        description: String(x.description).slice(0, 400),
        categories: Array.isArray(x.categories)
          ? x.categories.filter((c: any) => sortableStrictCategories(c)).slice(0, 4)
          : undefined,
      }));
    const risks: string[] = (parsed.risks || [])
      .filter((x: any) => typeof x === 'string')
      .slice(0, 4)
      .map((x: any) => String(x).slice(0, 300));
    const actions: AIAction[] = (parsed.actions || [])
             .filter((x: any) => x && typeof x.action === 'string' && typeof x.rationale === 'string')
      .slice(0, 4)
      .map((x: any) => ({
        action: String(x.action).slice(0, 200),
        rationale: String(x.rationale).slice(0, 400),
        timeframe: (['immediate', '1-3 months', '6-12 months'] as const).includes(x.timeframe)
          ? x.timeframe : undefined,
      }));

    if (insights.length === 0 && patterns.length === 0) throw new Error('empty-analysis');

    return { model: 'openrouter', insights, patterns, risks, actions, isAI: true };
  } catch {
    // Deterministic fallback — same real data, rules-based analysis
    return deterministicAIAnalysis(facts, opportunities);
  }
}

// A tiny helper used in normalizing model output (kept strict so invalid
// category ids don't leak into the UI).
function sortableStrictCategories(c: any): boolean {
  return typeof c === 'string' && c.length > 0 && c.length < 40;
}

// Rules-based fallback with the same output shape — used when all free
// models are rate-limited. Still grounded in the exact same real data.
function deterministicAIAnalysis(
  facts: MarketFacts,
  opportunities: OpportunityResult[],
): AIAnalysis {
  const insights: AIInsight[] = [];
  const patterns: AIPattern[] = [];
  const risks: string[] = [];
  const actions: AIAction[] = [];
  const label = (c: string) => getCategoryLabel(c);

  // 1. Biggest gap
  const gapped = opportunities.filter(o => o.gap != null && (o.gap as number) > 0);
  if (gapped.length > 0) {
    const big = gapped.reduce((best, o) => (o.gap as number) > (best.gap as number) ? o : best, gapped[0]);
    insights.push({
      title: `Largest underserved category: ${big.categoryLabel}`,
      detail: `Only ${big.existing} existing vs ${((big.gap as number) + big.existing).toLocaleString()} expected (${(big.gap as number)} gap). Per-capita density ${big.per10k}/10k.`,
      severity: big.score >= 70 ? 'high' : 'medium',
      categories: [big.category],
    });
  }

  // 2. Saturation warning
  if (facts.saturationCluster.length > 0) {
    insights.push({
      title: `${facts.saturationCluster.length} saturated categories detected`,
      detail: `High density detected in: ${facts.saturationCluster.map(label).join(', ')}. These markets show signs of being crowded — differentiate or avoid.`,
      severity: 'medium',
      categories: facts.saturationCluster.slice(0, 4),
    });
  }

  // 3. Low-competition (blue-ocean) list
  if (facts.lowCompetition.length > 0) {
    insights.push({
      title: `${facts.lowCompetition.length} low-competition categories`,
      detail: `Fewer than 5 businesses found: ${facts.lowCompetition.slice(0, 5).map(label).join(', ')}. First-mover positioning is available.`,
      severity: facts.lowCompetition.length >= 3 ? 'medium' : 'low',
      categories: facts.lowCompetition.slice(0, 4),
    });
  }

  // 4. Geo-concentration insight
  if (facts.hubStats.concentration >= 25) {
    insights.push({
      title: `High geo-concentration (${facts.hubStats.concentration}%)`,
      detail: `${facts.hubStats.clusters} distinct clusters detected; the largest (dominated by ${facts.hubStats.dominant ?? 'mixed categories'}) holds ${facts.hubStats.concentration}% of all businesses. Outlying districts are underserved.`,
      severity: 'medium',
    });
  }

  // ── Patterns (deterministic) ──
  // P1: saturation vs underservice asymmetry
  if (facts.saturationCluster.length > 0 && facts.underservedCluster.length > 0) {
    patterns.push({
      name: 'Saturation–gap asymmetry',
      description: `Saturated categories (${facts.saturationCluster.slice(0, 2).map(label).join(', ')}) coexist with underserved ones (${facts.underservedCluster.slice(0, 2).map(label).join(', ')}) — capital and attention are flowing to crowded markets while gaps persist elsewhere.`,
      categories: [...facts.saturationCluster.slice(0, 2), ...facts.underservedCluster.slice(0, 2)],
    });
  }

  // P2: complementary-category pairing (food + fitness, pharmacy + clinic…)
  const COMPLEMENTARY: Array<[string, string]> = [
    ['restaurant', 'gym'], ['cafe', 'coworking'], ['fast_food', 'gym'],
    ['pharmacy', 'clinic'], ['bakery', 'cafe'], ['hotel', 'restaurant'],
    ['supermarket', 'bakery'], ['beauty_salon', 'hair_salon'],
  ];
  const have = new Set(facts.categories.map(c => c.category));
  const pair = COMPLEMENTARY.find(([a, b]) => have.has(a) && have.has(b));
  if (pair) {
    const [a, b] = pair;
    const ca = facts.categories.find(c => c.category === a)!;
    const cb = facts.categories.find(c => c.category === b)!;
    patterns.push({
      name: `Complementary pair: ${label(a)} ↔ ${label(b)}`,
      description: `${ca.existing} ${label(a)} and ${cb.existing} ${label(b)} businesses. Traffic from one typically feeds the other — co-location or bundled positioning can capture spillover demand.`,
      categories: [a, b],
    });
  }

  // P3: contact coverage gap
  const coverage = facts.contactCoverage;
  if (facts.totalBusinesses > 10 && coverage.emails / facts.totalBusinesses < 0.3) {
    patterns.push({
      name: 'Low digital presence',
      description: `Only ${coverage.emails}/${facts.totalBusinesses} businesses have a discoverable email and ${coverage.websites} have websites. Widespread low digital maturity = opening for digital-first competitors.`,
    });
  }

  // ── Risks (deterministic) ──
  if (facts.population === 0) {
    risks.push('Population unknown for this city — per-capita gap estimates are unreliable; verify demographics before investing.');
  }
  risks.push('OpenStreetMap coverage is volunteered data — informal or newly opened businesses may be missing from the scan.');
  if (coverage.emails + coverage.phones + coverage.websites < facts.totalBusinesses * 0.5) {
    risks.push('Contact enrichment is incomplete — reachability estimates may understate the actual competitive set.');
  }

  // ── Actions (deterministic) ──
  if (gapped.length > 0) {
    const top = gapped[0];
    actions.push({
      action: `Validate demand for ${top.categoryLabel}`,
      rationale: `Highest-scoring gap (${top.gap} businesses missing, score ${top.score}/100). Confirm with 10-20 customer interviews before committing.`,
      timeframe: 'immediate',
    });
  }
  if (facts.lowCompetition.length > 0) {
    actions.push({
      action: `Pilot a ${label(facts.lowCompetition[0])} offering`,
      rationale: `Only ${facts.categories.find(c => c.category === facts.lowCompetition[0])?.existing ?? 0} competitors — a low-cost pilot can test the market with minimal exposure.`,
      timeframe: '1-3 months',
    });
  }
  if (facts.hubStats.concentration >= 25) {
    actions.push({
      action: 'Scout locations outside the main cluster',
      rationale: `${facts.hubStats.concentration}% of businesses concentrate in one area — outlying districts have demand but little supply.`,
      timeframe: '1-3 months',
    });
  }

  return { model: 'deterministic', insights, patterns, risks, actions, isAI: false };
}


export function getGoogleMapsUrl(b: Business): string {
  if (b.name) {
    const query = [b.name, b.address].filter(Boolean).join(' ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }
  return `https://www.google.com/maps?q=${b.lat},${b.lon}`;
}

// ─── Demand Signals ────────────────────────────────────────────────

export interface DemandSignal {
  score: number;
  confidence: number;
  wikipedia: number;
  reddit: number;
  webSearch: number;
  explanation: string;
  sources: string[];
}

export async function getDemandSignals(categoryLabel: string, cityName: string): Promise<DemandSignal> {
  const signals: DemandSignal = {
    score: 0, confidence: 0, wikipedia: 0, reddit: 0, webSearch: 0,
    explanation: '', sources: [],
  };

  // Wikipedia pageviews — ROLLING 12-month window ending last month
  // (the old hardcoded 20240101/20260101 window went stale by construction)
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start = new Date(now.getFullYear(), now.getMonth() - 13, 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const wikiP = fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(categoryLabel.replace(/ /g, '_'))}/monthly/${fmt(start)}/${fmt(end)}`,
    { headers: { 'User-Agent': 'BlueOcean/1.0' } }
  ).then(async r => {
    if (r.ok) {
      const d = await r.json();
      const t = d.items?.reduce((s: number, i: any) => s + (i.views || 0), 0) || 0;
      signals.wikipedia = Math.min(100, Math.round(Math.log10(t + 1) * 16.7));
      signals.sources.push('Wikipedia');
    }
  }).catch(() => {});

  // Reddit mentions
  const redditP = fetch(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(`${categoryLabel} ${cityName}`)}&sort=new&t=month&limit=25`,
    { headers: { 'User-Agent': 'BlueOcean/1.0' } }
  ).then(async r => {
    if (r.ok) {
      const d = await r.json();
      signals.reddit = Math.min(100, (d.data?.children?.length || 0) * 5);
      signals.sources.push('Reddit');
    }
  }).catch(() => {});

  // DuckDuckGo web search density
  const ddgP = corsFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${categoryLabel}" "${cityName}"`)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then(async r => {
    if (r.ok) {
      const h = await r.text();
      signals.webSearch = Math.min(100, (h.match(/class="result__snippet"/g)?.length || 0) * 10);
      signals.sources.push('Web Search');
    }
  }).catch(() => {});

  // Google Trends removed (dead endpoint, CORS-blocked)
  const gtP = Promise.resolve();

  await Promise.race([
    Promise.all([wikiP, redditP, ddgP, gtP]),
    new Promise(r => setTimeout(r, 10000))
  ]);

  signals.score = Math.round(
    0.30 * signals.webSearch +
    0.30 * signals.wikipedia +
    0.25 * signals.reddit +
    0.15 * Math.max(signals.webSearch, signals.wikipedia, signals.reddit)
  );
  signals.confidence = Math.round(
    ([signals.wikipedia, signals.reddit, signals.webSearch].filter(s => s > 0).length / 3) * 100
  );

  const p: string[] = [];
  if (signals.webSearch > 50) p.push('Strong web presence');
  else if (signals.webSearch > 20) p.push('Moderate web presence');
  if (signals.wikipedia > 30) p.push('Active knowledge-seeking');
  if (signals.reddit > 20) p.push(`${signals.reddit} community discussions`);
  signals.explanation = p.length ? p.join(', ') : 'Limited demand data available';

  return signals;
}

// ─── Opportunity Scoring ───────────────────────────────────────────

export interface OpportunityResult {
  category: string;
  categoryLabel: string;
  existing: number;
  per10k: number;
  expected: number | null;   // null when population unknown (never fabricated)
  gap: number | null;        // null when population unknown
  gapPct: number;
  score: number;
  demandBonus: number;
  populationKnown: boolean;
}

export function computeOpportunities(
  businesses: Map<string, Business[]>,
  population: number,
  demandSignals: Map<string, DemandSignal>
): OpportunityResult[] {
  const results: OpportunityResult[] = [];

  // Population honesty: when the area has no known population we do NOT
  // fabricate one. Per-capita metrics (expected/gap) are computed only with
  // a real figure; without one, gap/size criteria score neutral (50) and
  // results carry populationKnown=false so the UI can warn the user.
  const pop = population && population > 0 ? population : null;

  // Calculate per-10k density for all categories
  const per10kValues: number[] = [];
  for (const [, bizs] of businesses) {
    per10kValues.push((bizs.length / Math.max(pop || 1, 1)) * 10000);
  }
  per10kValues.sort((a, b) => a - b);
  const median = per10kValues.length > 0
    ? per10kValues[Math.floor(per10kValues.length / 2)]
    : 5;

  // Category baselines (per 10k residents) — heuristic starting points,
  // replaced by the live city median for any category not listed.
  const GLOBAL_BASELINES: Record<string, number> = {
    cafe: 4, restaurant: 5, bar: 2, pub: 1.5, fast_food: 3,
    hotel: 1, gym: 1.5, beauty_salon: 2, hair_salon: 2,
    pharmacy: 1.5, bank: 1, supermarket: 1.5, clothing: 3,
    electronics: 2, bakery: 1.5, cinema: 0.3,
  };

  for (const [cat, bizs] of businesses) {
    const existing = bizs.length;
    const per10k = (existing / Math.max(pop || 1, 1)) * 10000;
    const baseline = GLOBAL_BASELINES[cat] || median;
    const expected = pop ? Math.round((baseline * pop) / 10000) : null;
    const gap = expected != null ? Math.max(0, expected - existing) : null;
    const gapPct = expected ? (gap as number) / expected : 0;

    // Gap score: how underserved (0-100); neutral without population
    const gapScore = pop ? Math.min(100, Math.round(gapPct * 120)) : 50;

    // Size score: bigger city = bigger opportunity (0-100); neutral without
    // population
    const sizeScore = pop ? Math.min(100, Math.round(Math.log10(Math.max(pop, 1)) * 18)) : 50;

    // Competition score: fewer existing = less competition (0-100)
    const compScore = existing === 0 ? 90 : Math.max(0, Math.round(100 - existing * 3));

    let score = Math.round(0.45 * gapScore + 0.25 * sizeScore + 0.30 * compScore);

    // Demand bonus only from REAL measured signals (confidence > 0) —
    // a dead-network zero must not drag scores down (M7).
    const demand = demandSignals.get(cat);
    const demandBonus = demand && demand.confidence > 0 ? Math.round(demand.score * 0.15) : 0;
    score = Math.min(100, score + demandBonus);

    results.push({
      category: cat,
      categoryLabel: getCategoryLabel(cat),
      existing,
      per10k: Math.round(per10k * 100) / 100,
      expected,
      gap,
      gapPct: Math.round(gapPct * 100),
      score,
      demandBonus,
      populationKnown: pop != null,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// Sanity gate for phones scraped from arbitrary page text: rejects dates
// (2026-06-11), IP-like groups (23.58.223.22) and unix timestamps
// (1787851477009) that naive digit-count checks accept.
function plausiblePhone(p: string): boolean {
  const t = p.trim();
  const digits = t.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  // date-like: 2026-06-11 / 11.06.2026 / 2026/06/11
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(t)) return false;
  // IP-like: 23.58.223.22
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return false;
  // bare 1-prefixed 10-13 digit runs without + are usually timestamps/IDs
  // (real international numbers in our regions carry +995/+374/+90/+7)
  if (/^1\d{9,12}$/.test(digits) && !t.startsWith('+')) return false;
  return true;
}

// Junk emails: asset files and placeholder addresses that regexes pick up
const _EMAIL_FILE_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
const _EMAIL_JUNK_RE = /example\.com|noreply|no-reply|donotreply|wixpress|sentry\.io|cloudflare|privacy|abuse@|postmaster@/i;

// ─── Test-only exports (corsFetch is module-scope; extractFromHtml is
// published inside queryBusinesses, which owns its scope) ───
export const __internals: any = {};
__internals.corsFetch = corsFetch;
__internals.extractFromHtml = extractFromHtmlModule;

// ── Unified extraction: pull phone, email, website, social from any HTML/text ──
// (module-scope utility: pure parsing, no closure state — used by the
// enrichment pipeline inside queryBusinesses and by the parsing test harness)
function extractFromHtmlModule(html: string, b: Business): void {
  const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org|privacy.*policy|terms.*service|cookie/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;

  // Phone: tel: links, then text regex
  if (!b.phone) {
    // 1. tel: links (most reliable)
    const telM = html.match(/href="tel:([^"]+)"/);
    if (telM) b.phone = (() => { try { return decodeURIComponent(telM[1]).trim(); } catch { return telM[1].trim(); } })();
    // 2. Country-specific formats
    if (!b.phone) {
      const geoM = html.match(/\+995\s?\d{3}\s?\d{2}\s?\d{2}\s?\d{2}/);
      if (geoM) b.phone = geoM[0].trim();
    }
    if (!b.phone) {
      const armM = html.match(/\+374\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}/);
      if (armM) b.phone = armM[0].trim();
    }
    if (!b.phone) {
      const turM = html.match(/\+90\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/);
      if (turM) b.phone = turM[0].trim();
    }
    if (!b.phone) {
      const ruM = html.match(/\+7\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2}/);
      if (ruM) b.phone = ruM[0].trim();
    }
    // 3. Labeled phone patterns (Phone: +xxx, Tel: xxx, etc.)
    if (!b.phone) {
      const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls?|whatsapp|viber|contact)\s*[:;=\s"'>]*([+\d][\d\s\-\.()]{7,18})/i);
      if (labeledPh && labeledPh[1].replace(/[^\d]/g, '').length >= 8 && plausiblePhone(labeledPh[1])) b.phone = labeledPh[1].trim();
    }
    // 4. General phone regex (fallback). Unlabeled text is noisy: require a
    // leading '+' so floats/coordinates (2.3333…), IDs and fragments don't
    // match. Labeled/tel: paths above stay permissive for local formats.
    if (!b.phone) {
      const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
      if (phM) {
        for (const p of phM) {
          if (!p.includes('+')) continue;
          const digits = p.replace(/[^\d+]/g, '');
          if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(p) && !JUNK.test(p)) { b.phone = p.trim(); break; }
        }
      }
    }
  }

  // Email: structured extraction with verification
  // Strategy 1: Look for contact info in structured HTML (most reliable)
  if (!b.email) {
    // Contact section: look for labeled email near "contact" heading
    const contactSection = html.match(/<(?:div|section|footer|aside)[^>]*class="[^"]*contact[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|footer|aside)/i);
    if (contactSection) {
      const emails = contactSection[1].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
        }
      }
    }
  }

  // Email: mailto, text, Cloudflare decode, &#64; encode, JSON-LD
  if (!b.email) {
    // 1. mailto: links (most reliable)
    const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
    if (mailM && !JUNK.test(mailM[1]) && !EMAIL_FILE.test(mailM[1])) b.email = mailM[1].trim();
    // 2. Labeled email patterns (Email: xxx@yyy.com)
    if (!b.email) {
      const labelM = html.match(/(?:email|e-mail|mail|contact)\s*[:;=\s"'>]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (labelM && !JUNK.test(labelM[1]) && !EMAIL_FILE.test(labelM[1])) b.email = labelM[1];
    }
    // 3. JSON-LD structured data
    if (!b.email) {
      const jsonLdEmails = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of jsonLdEmails) {
        try {
          const data = JSON.parse(m[1]);
          const entities = Array.isArray(data) ? data : [data];
          for (const e of entities) {
            if (e.email && !JUNK.test(e.email) && !EMAIL_FILE.test(e.email)) { b.email = e.email; break; }
          }
        } catch {}
        if (b.email) break;
      }
    }
    // 4. General email regex (fallback)
    if (!b.email) {
      const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
        }
      }
    }
    // 5. Cloudflare encoded emails
    if (!b.email) {
      const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
      if (cfM) {
        try {
          const bytes = cfM[1].match(/.{2}/g)!.map(h => parseInt(h, 16));
          const key = bytes[0];
          const decoded = bytes.slice(1).map(x => x ^ key).map(x => String.fromCharCode(x)).join('');
          if (decoded.includes('@') && !JUNK.test(decoded)) b.email = decoded;
        } catch {}
      }
    }
    // 6. HTML entity encoded (@)
    if (!b.email) {
      const entM = html.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (entM && !JUNK.test(entM[0])) b.email = entM[1] + '@' + entM[2];
    }
    // 7. JavaScript string literals
    if (!b.email) {
      const jsEmailM = html.match(/['"]([\w][\w._%+-]*@[\w.-]+\.[a-zA-Z]{2,})['"]/);
      if (jsEmailM && !JUNK.test(jsEmailM[1]) && !EMAIL_FILE.test(jsEmailM[1]) && jsEmailM[1].length > 6) b.email = jsEmailM[1];
    }
    // 8. data-email attributes
    if (!b.email) {
      const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
      if (dataEmailM && !JUNK.test(dataEmailM[1]) && !EMAIL_FILE.test(dataEmailM[1])) b.email = dataEmailM[1];
    }
  }

  // Website: extract from links. Self-contained denylist (this variant must
  // not depend on the nested DIRECTORY_SITES/_EXCLUDE helpers).
  if (!b.website) {
    const links = html.matchAll(/href="([^"]+)"/g);
    const DENY = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest\.com|tumblr|reddit\.com|quora|wikipedia\.org|youtube\.com|tiktok\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|snapchat|threads|medium\.com|substack|archive\.org|amazon\.|ebay\.|aliexpress|2gis\.|yandex\.|uber\.com|doordash|grubhub|glassdoor|indeed\.com|thumbtack|bbb\.org|trustpilot|google\.|gstatic|apple\.com|microsoft\.com/i;
    for (const link of links) {
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!url.startsWith('http')) continue;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
      if (DENY.test(host)) continue;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
      b.website = url; break;
    }
  }

  // Facebook
  if (!b.facebook) {
    const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
    if (fbM && !fbM[0].includes('login') && !fbM[0].includes('sharer') && !fbM[0].includes('dialog')) {
      b.facebook = 'https://facebook.com/' + fbM[1].replace(/\/$/, '');
    }
  }

  // Instagram
  if (!b.instagram) {
    const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
    if (igM && !igM[0].includes('accounts') && !igM[0].includes('explore')) {
      b.instagram = 'https://instagram.com/' + igM[1].replace(/\/$/, '');
    }
  }

  // Twitter/X
  if (!b.twitter) {
    const twM = html.match(/(?:twitter|x)\.com\/([a-zA-Z0-9._]+)/i);
    if (twM && !twM[0].includes('login') && !twM[0].includes('intent') && !twM[0].includes('share')) {
      b.twitter = 'https://twitter.com/' + twM[1].replace(/\/$/, '');
    }
  }

  // Pinterest
  if (!b.pinterest) {
    const pinM = html.match(/pinterest\.com\/([a-zA-Z0-9._]+)/i);
    if (pinM && !pinM[0].includes('login')) {
      b.pinterest = 'https://pinterest.com/' + pinM[1].replace(/\/$/, '');
    }
  }

  // Rating from meta/structured data
  if (!b.rating) {
    const ratingM = html.match(/(?:ratingValue|rating)["\s:=]*(?:content)?["\s:=]*(\d\.\d)/i)
      || html.match(/(\d\.\d)\s*(?:out of|\/)\s*5/i);
    if (ratingM) {
      const val = parseFloat(ratingM[1]);
      if (val >= 1 && val <= 5) b.rating = val;
    }
  }
  // Review count
  if (!b.reviewCount) {
    const revM = html.match(/(?:reviewCount|ratingCount)["\s:=]+(\d+)/i)
      || html.match(/(\d[\d,]*)\s*reviews?/i);
    if (revM) {
      const val = parseInt(revM[1].replace(/,/g, ''));
      if (val > 0 && val < 100000) b.reviewCount = val;
    }
  }
}
