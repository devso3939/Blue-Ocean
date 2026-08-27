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

function extractPhone(tags: Record<string, string>): string {
  return tags.phone || tags['contact:phone'] || tags['contact:mobile'] ||
         tags['phone:mobile'] || tags['phone:international'] ||
         tags['contact:landline'] || tags['contact:fax'] ||
         tags['contact:whatsapp'] || tags['contact:viber'] || '';
}

function extractEmail(tags: Record<string, string>): string {
  return tags.email || tags['contact:email'] || tags['email:office'] || '';
}

function extractWebsite(tags: Record<string, string>): string {
  return tags.website || tags['contact:website'] || tags.url || '';
}

function extractFacebook(tags: Record<string, string>): string {
  const raw = tags['contact:facebook'] || tags.facebook || '';
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('www.')) return `https://${raw}`;
  return `https://facebook.com/${raw.replace(/^\/+/, '')}`;
}

function extractInstagram(tags: Record<string, string>): string {
  const raw = tags['contact:instagram'] || tags.instagram || '';
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  return `https://instagram.com/${raw.replace(/^@+/, '')}`;
}

// Extract LinkedIn from OSM tags
function extractLinkedIn(tags: Record<string, string>): string {
  const raw = tags['contact:linkedin'] || tags.linkedin || '';
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  return `https://linkedin.com/company/${raw.replace(/^@+/, '')}`;
}

// Extract YouTube from OSM tags
function extractYouTube(tags: Record<string, string>): string {
  const raw = tags['contact:youtube'] || tags.youtube || '';
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  return `https://youtube.com/@${raw.replace(/^@+/, '')}`;
}

// Extract TikTok from OSM tags
function extractTikTok(tags: Record<string, string>): string {
  const raw = tags['contact:tiktok'] || tags.tiktok || '';
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  return `https://tiktok.com/@${raw.replace(/^@+/, '')}`;
}

function formatAddress(tags: Record<string, string>): string {
  const parts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city'], tags['addr:postcode']].filter(Boolean);
  return parts.join(', ') || '';
}

// ─── Overpass Query ────────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
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

  // 3) Try cors.sh (working as of 2026)
  try {
    const r = await fetch('https://cors.sh/' + url, { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) return r;
  } catch {}

  // 4) Try allorigins (flaky, last resort)
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
  onEnrichProgress?: (ep: EnrichmentProgress) => void
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
    onProgress?.(10, 'Scanning food, healthcare & entertainment…');
    const d1 = await fetchOverpass(qFood, 90, (msg) => onProgress?.(15, msg));
    if (d1?.elements) allElements.push(...d1.elements);

    await wait(1500);
    onProgress?.(30, 'Scanning shops & retail…');
    const d2 = await fetchOverpass(qShops, 90, (msg) => onProgress?.(35, msg));
    if (d2?.elements) allElements.push(...d2.elements);

    await wait(1500);
    onProgress?.(50, 'Scanning hotels, gyms & services…');
    const d3 = await fetchOverpass(qOther, 60, (msg) => onProgress?.(55, msg));
    if (d3?.elements) allElements.push(...d3.elements);

    // ── Tier 2: Fallback ──
    if (allElements.length === 0) {
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
      phone: extractPhone(tags),
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
      twitter: '',
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
            if (!JUNK.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
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
              if (!JUNK.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
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
function extractFromHtml(html: string, b: Business): void {
  const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org|privacy.*policy|terms.*service|cookie/i;

  // Phone: tel: links, then text regex
  if (!b.phone) {
    // 1. tel: links (most reliable)
    const telM = html.match(/href="tel:([^"]+)"/);
    if (telM) b.phone = telM[1].trim();
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
      if (labeledPh && labeledPh[1].replace(/[^\d]/g, '').length >= 8) b.phone = labeledPh[1].trim();
    }
    // 4. General phone regex (fallback)
    if (!b.phone) {
      const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
      if (phM) {
        for (const p of phM) {
          const digits = p.replace(/[^\d+]/g, '');
          if (digits.length >= 8 && digits.length <= 15 && !JUNK.test(p)) { b.phone = p.trim(); break; }
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
          if (!JUNK.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
        }
      }
    }
  }

  // Email: mailto, text, Cloudflare decode, &#64; encode, JSON-LD
  if (!b.email) {
    // 1. mailto: links (most reliable)
    const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
    if (mailM && !JUNK.test(mailM[1])) b.email = mailM[1].trim();
    // 2. Labeled email patterns (Email: xxx@yyy.com)
    if (!b.email) {
      const labelM = html.match(/(?:email|e-mail|mail|contact)\s*[:;=\s"'>]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (labelM && !JUNK.test(labelM[1])) b.email = labelM[1];
    }
    // 3. JSON-LD structured data
    if (!b.email) {
      const jsonLdEmails = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of jsonLdEmails) {
        try {
          const data = JSON.parse(m[1]);
          const entities = Array.isArray(data) ? data : [data];
          for (const e of entities) {
            if (e.email && !JUNK.test(e.email)) { b.email = e.email; break; }
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
          if (!JUNK.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
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
      if (jsEmailM && !JUNK.test(jsEmailM[1]) && jsEmailM[1].length > 6) b.email = jsEmailM[1];
    }
    // 8. data-email attributes
    if (!b.email) {
      const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
      if (dataEmailM && !JUNK.test(dataEmailM[1])) b.email = dataEmailM[1];
    }
  }

  // Website: extract from DDG result links (only validated URLs)
  if (!b.website) {
    const links = html.matchAll(/href="([^"]+)"/g);
    for (const link of links) {
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (url.startsWith('http') && !_EXCLUDE.test(url) && !DIRECTORY_SITES.test(url) && isLikelyBusinessWebsite(url, b.name)) {
        b.website = url; break;
      }
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
    const ratingM = html.match(/(?:ratingValue|rating)["\s:=]+(\d\.\d)/i)
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
function extractFromText(text: string, b: Business): void {
  if (!b.phone) {
    const m = text.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
    if (m && m[0].length >= 8) b.phone = m[0].trim();
  }
  if (!b.email) {
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m && !m[0].includes('example.com') && !m[0].includes('google') && !m[0].includes('facebook') && !m[0].includes('instagram')) b.email = m[0];
  }
  if (!b.facebook) {
    const m = text.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
    if (m && !m[0].includes('login') && !m[0].includes('sharer')) b.facebook = 'https://facebook.com/' + m[1];
  }
  if (!b.instagram) {
    const m = text.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    if (m && !m[0].includes('accounts')) b.instagram = 'https://instagram.com/' + m[1];
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
    if (m) b.website = 'https://linkedin.com/company/' + m[1];
  }
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

// Domain probing - check if common domain patterns exist for a business
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
          method: 'HEAD',
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          b.website = domain;
          return;
        }
      } catch {}
    }
  }
}

// Brave API key: prefer VITE_BRAVE_API_KEY from client/.env (see README),
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
  parts.push('phone email website contact');
  return encodeURIComponent(parts.join(' '));
}

// Generate multiple query variations for a business (inspired by omkarcloud approach)
function buildSearchQueries(b: Business): string[] {
  const queries: string[] = [];
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);

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
  };
  function emitEP() {
    // Recount contacts from live data
    _ep.contacts.emails = allBizList.filter(b => b.email).length;
    _ep.contacts.phones = allBizList.filter(b => b.phone).length;
    _ep.contacts.websites = allBizList.filter(b => b.website).length;
    _ep.contacts.social = allBizList.filter(b => b.facebook || b.instagram).length;
    _ep.contacts.total = _ep.contacts.emails + _ep.contacts.phones + _ep.contacts.websites + _ep.contacts.social;
    onEnrichProgress?.({ ..._ep, engines: _ep.engines.map(e => ({ ...e })) });
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
                for (const res of (data.web?.results || [])) {
                  extractFromText((res.description || '') + ' ' + (res.title || ''), b);
                  if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('google.com/maps') && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
                }
                if (!b.website && data.knowledge_graph?.url && !_EXCLUDE.test(data.knowledge_graph.url)) b.website = data.knowledge_graph.url;
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
              if (r.ok) extractFromHtml(await r.text(), b);
            } catch {}
          })(),
          // Bing
          (async () => {
            try {
              const bingResults = await searchBing(q);
              for (const res of bingResults) {
                extractFromText((res.snippet || '') + ' ' + (res.title || ''), b);
                if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('bing.com') && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
              }
            } catch {}
          })(),
          // DDG Lite
          (async () => {
            try {
              const spResults = await searchDDGLite(decodeURIComponent(q));
              for (const res of spResults) {
                extractFromText((res.snippet || '') + ' ' + (res.title || ''), b);
                if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('duckduckgo.com/lite') && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
              }
            } catch {}
          })(),
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

  _ep.activePass = 'Complete'; _ep.percent = 100;
  _ep.engines.forEach(e => { if (e.status === 'active') e.status = 'done'; });
  _ep.engines.find(e => e.name === 'Website Scraper')!.status = 'done';
  emitEP();
  return results;
}


// ─── AI-Powered Opportunity Analysis ───────────────────────────
// Uses Hugging Face free inference API for market analysis
export async function getAIAnalysis(
  cityName: string,
  countryName: string,
  topOpps: Array<{ category: string; label: string; existing: number; gap: number; score: number }>,
  population: number
): Promise<string> {
  try {
    // Build a prompt from the data
    const oppText = topOpps.slice(0, 8).map(o =>
      `${o.label}: ${o.existing} existing, gap of ${o.gap}, score ${o.score}/100`
    ).join('\n');

    const prompt = `Analyze business opportunities in ${cityName}, ${countryName} (pop. ${population.toLocaleString()}). Market data:\n${oppText}\n\nProvide 3-5 concise insights about the best investment opportunities, underserved markets, and competitive advantages. Be specific and actionable. Format as bullet points.`;

    // Use Hugging Face free inference API
    const r = await fetch('https://api-inference.huggingface.co/models/facebook/bart-large-cnn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_length: 300, min_length: 50, do_sample: false },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      // Fallback: generate analysis from data directly
      return generateLocalAnalysis(cityName, countryName, topOpps, population);
    }

    const data = await r.json();
    if (data[0]?.summary_text) {
      return data[0].summary_text;
    }
    return generateLocalAnalysis(cityName, countryName, topOpps, population);
  } catch {
    return generateLocalAnalysis(cityName, countryName, topOpps, population);
  }
}

// Local analysis fallback (no API needed)
function generateLocalAnalysis(
  cityName: string,
  countryName: string,
  topOpps: Array<{ category: string; label: string; existing: number; gap: number; score: number }>,
  population: number
): string {
  const insights: string[] = [];

  // Find biggest gap
  const biggestGap = topOpps.reduce((best, o) => o.gap > best.gap ? o : best, topOpps[0]);
  if (biggestGap) {
    insights.push(`🔍 **Biggest opportunity**: ${biggestGap.label} — only ${biggestGap.existing} exist but ${biggestGap.gap + biggestGap.existing} are expected for a city of ${population.toLocaleString()}. Gap score: ${biggestGap.score}/100.`);
  }

  // Find underserved categories
  const underserved = topOpps.filter(o => o.score >= 60);
  if (underserved.length > 0) {
    insights.push(`📊 **${underserved.length} underserved categories** (score ≥60): ${underserved.map(o => o.label).join(', ')}.`);
  }

  // Market density
  const totalExisting = topOpps.reduce((s, o) => s + o.existing, 0);
  const per10k = ((totalExisting / Math.max(population, 1)) * 10000).toFixed(1);
  insights.push(`📈 Market density: ${totalExisting} businesses across ${topOpps.length} categories = ${per10k} per 10k residents.`);

  // Competition level
  const lowComp = topOpps.filter(o => o.existing < 5);
  if (lowComp.length > 0) {
    insights.push(`🏆 **Low competition** (<5 businesses): ${lowComp.map(o => o.label).join(', ')}. First-mover advantage available.`);
  }

  // Population insight
  if (population > 500000) {
    insights.push(`👥 Large population (${(population/1000000).toFixed(1)}M) supports specialized niches — consider premium/quality positioning.`);
  } else if (population < 100000) {
    insights.push(`🏘️ Smaller market (${population.toLocaleString()}) — focus on essential services with proven demand.`);
  }

  return insights.join('\n\n');
}


// ─── Google Maps URL ───────────────────────────────────────────────

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

  // Wikipedia pageviews
  const wikiP = fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(categoryLabel.replace(/ /g, '_'))}/monthly/20240101/20260101`,
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
  expected: number;
  gap: number;
  gapPct: number;
  score: number;
  demandBonus: number;
}

export function computeOpportunities(
  businesses: Map<string, Business[]>,
  population: number,
  demandSignals: Map<string, DemandSignal>
): OpportunityResult[] {
  const results: OpportunityResult[] = [];

  // Calculate per-10k density for all categories
  const per10kValues: number[] = [];
  for (const [, bizs] of businesses) {
    per10kValues.push((bizs.length / Math.max(population, 1)) * 10000);
  }
  per10kValues.sort((a, b) => a - b);
  const median = per10kValues.length > 0
    ? per10kValues[Math.floor(per10kValues.length / 2)]
    : 5;

  // Global baseline for well-served city (per 10k people)
  const GLOBAL_BASELINES: Record<string, number> = {
    cafe: 4, restaurant: 5, bar: 2, pub: 1.5, fast_food: 3,
    hotel: 1, gym: 1.5, beauty_salon: 2, hair_salon: 2,
    pharmacy: 1.5, bank: 1, supermarket: 1.5, clothing: 3,
    electronics: 2, bakery: 1.5, cinema: 0.3,
  };

  for (const [cat, bizs] of businesses) {
    const existing = bizs.length;
    const per10k = (existing / Math.max(population, 1)) * 10000;
    const baseline = GLOBAL_BASELINES[cat] || median;
    const expected = Math.round((baseline * population) / 10000);
    const gap = Math.max(0, expected - existing);
    const gapPct = expected > 0 ? gap / expected : 0;

    // Gap score: how underserved (0-100)
    const gapScore = Math.min(100, Math.round(gapPct * 120));

    // Size score: bigger city = bigger opportunity (0-100)
    const sizeScore = Math.min(100, Math.round(Math.log10(Math.max(population, 1)) * 18));

    // Competition score: fewer existing = less competition (0-100)
    const compScore = existing === 0 ? 90 : Math.max(0, Math.round(100 - existing * 3));

    let score = Math.round(0.45 * gapScore + 0.25 * sizeScore + 0.30 * compScore);

    const demand = demandSignals.get(cat);
    const demandBonus = demand ? Math.round(demand.score * 0.15) : 0;
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
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
