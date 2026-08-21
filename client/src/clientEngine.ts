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
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5&extratags=1`;
  const url = `https://corsproxy.io/?${encodeURIComponent(nominatimUrl)}`;
  const res = await fetch(url, { headers: { 'Accept': 'language,en' } });
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
  if (s === 'beauty' || s === 'cosmetics') return 'beauty_salon';
  if (s === 'hairdresser' || s === 'wigs') return 'hair_salon';
  if (s === 'nail_salon') return 'beauty_salon';
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
  if (a === 'nightclub') return 'night_club';
  if (a === 'marketplace') return 'marketplace';
  if (a === 'fuel') return 'fuel';

  // ─── Tourism ───
  if (t === 'hotel' || t === 'motel' || t === 'apartment') return 'hotel';
  if (t === 'hostel') return 'hostel';
  if (t === 'guest_house') return 'hotel';

  // ─── Leisure ───
  if (l === 'fitness_centre' || l === 'sports_centre' || l === 'sports_hall' || l === 'swimming_pool') return 'gym';

  // ─── Office ───
  if (tags.office === 'coworking') return 'coworking';

  return null;
}

// ─── Parsing Helpers ───────────────────────────────────────────────

function extractPhone(tags: Record<string, string>): string {
  return tags.phone || tags['contact:phone'] || tags['contact:mobile'] ||
         tags['phone:mobile'] || tags['phone:international'] ||
         tags['contact:landline'] || tags['contact:fax'] || '';
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

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  nightclub: '["amenity"="nightclub"]',
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
  spa: '["shop"="beauty"]',
  yoga: '["leisure"="fitness_centre"]',
  bookstore: '["shop"~"books|stationery"]',
  library: '["amenity"="library"]',
  post_office: '["amenity"="post_office"]',
};

async function fetchOverpass(query: string, timeoutSec = 60): Promise<any> {
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
  // ── Last resort: CORS proxy ──
  try {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(OVERPASS_MIRRORS[0])}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75000);
    const res = await fetch(proxyUrl, {
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

  return null;
}

export async function queryBusinesses(
  lat: number,
  lon: number,
  radiusMeters: number = 10000,
  onProgress?: (pct: number, msg: string) => void,
  categoryFilter?: string
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
  node(${bbox})["amenity"~"bank|cinema|nightclub|car_rental|fuel|marketplace"];
  way(${bbox})["amenity"~"bank|cinema|nightclub|car_rental|fuel|marketplace"];
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
  node(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool"];
  way(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool"];
  node(${bbox})["office"];
  way(${bbox})["office"];
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
    const d = await fetchOverpass(qFocused, 90);
    if (d?.elements) allElements.push(...d.elements);

    // Fallback: try broader query
    if (allElements.length === 0) {
      onProgress?.(50, 'Retrying with broader query…');
      const qBroad = `[out:json][timeout:60][maxsize:268435456];
(
  node(${bbox})["amenity"];
  way(${bbox})["amenity"];
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;
      const d2 = await fetchOverpass(qBroad, 60);
      if (d2?.elements) allElements.push(...d2.elements);
    }
  } else {
    // ── FULL MODE: All categories (for Discover Opportunities) ──
    onProgress?.(10, 'Scanning food, healthcare & entertainment…');
    const d1 = await fetchOverpass(qFood, 90);
    if (d1?.elements) allElements.push(...d1.elements);

    await wait(1500);
    onProgress?.(30, 'Scanning shops & retail…');
    const d2 = await fetchOverpass(qShops, 90);
    if (d2?.elements) allElements.push(...d2.elements);

    await wait(1500);
    onProgress?.(50, 'Scanning hotels, gyms & services…');
    const d3 = await fetchOverpass(qOther, 60);
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
      const d4 = await fetchOverpass(qMin, 60);
      if (d4?.elements) allElements.push(...d4.elements);
    }
  }

  onProgress?.(60, 'Categorizing businesses…');

  if (allElements.length === 0) {
    onProgress?.(70, 'No businesses found from OpenStreetMap');
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
    };

    if (!results.has(category)) results.set(category, []);
    results.get(category)!.push(business);
  }

  const totalBiz = Array.from(results.values()).reduce((s, a) => s + a.length, 0);
  onProgress?.(70, `Found ${totalBiz} businesses — enriching data…`);



// ─── Social Platform Deep Search ──────────────────────────────
// Searches for business presence on LinkedIn, YouTube, Twitter, TikTok, Pinterest
async function enrichFromSocialPlatforms(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS = businesses.filter(b => !b.facebook && !b.instagram && !b.website);
  if (NEEDS.length === 0) return;
  const BATCH = 3;
  const max = Math.min(NEEDS.length, 80);
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const cityEn = getEnglishCityName(b.address?.split(',').pop()?.trim() || '');
        const q = encodeURIComponent(`"${b.name}" ${cityEn} facebook instagram linkedin youtube tiktok`);
        const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return;
        const html = await r.text();
        // LinkedIn
        if (!b.facebook) { // reuse facebook field for LinkedIn if we find it... no, add a new field? Let's put it in description
          // Actually we don't have a LinkedIn field. Let's extract from results and put website if we find it
        }
        // Twitter/X
        const twMatch = html.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i);
        if (twMatch && !twMatch[0].includes('twitter.com/login') && !twMatch[0].includes('intent')) {
          // Store Twitter as part of the name or website... we need a field. 
          // We'll add it to the business description via a new approach
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
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(8000),
      });
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
    } catch {}
  }

  // Scrape main page
  await deepScrape(b.website);

  // Scrape contact/about pages if still missing data
  if (!b.email || !b.phone || !b.facebook) {
    const base = b.website.replace(/\/$/, '');
    const paths = ['/contact', '/contact-us', '/about', '/about-us', '/kontakti', '/kontakt',
                   '/contacte', '/team', '/info', '/impressum', '/locations', '/find-us',
                   '/where-to-find-us', '/reach-us', '/get-in-touch'];
    for (const path of paths) {
      if (b.email && b.phone && b.facebook) break;
      await deepScrape(base + path);
    }
  }
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
        const r = await fetch('https://corsproxy.io/?' + encodeURIComponent('https://www.google.com/maps/search/' + q), {
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
          if (m && !m[0].includes('google.com') && !m[0].includes('gstatic')) {
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


// ── Unified extraction: pull phone, email, website, social from any HTML/text ──
function extractFromHtml(html: string, b: Business): void {
  const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org/i;

  // Phone: tel: links, then text regex
  if (!b.phone) {
    const telM = html.match(/href="tel:([\"]+)"/);
    if (telM) b.phone = telM[1].trim();
    if (!b.phone) {
      // Georgian format
      const geoM = html.match(/\+995\s?\d{3}\s?\d{2}\s?\d{2}\s?\d{2}/);
      if (geoM) b.phone = geoM[0].trim();
    }
    if (!b.phone) {
      // Armenian format
      const armM = html.match(/\+374\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}/);
      if (armM) b.phone = armM[0].trim();
    }
    if (!b.phone) {
      const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
      if (phM) {
        for (const p of phM) {
          const digits = p.replace(/[^\d+]/g, '');
          if (digits.length >= 8 && digits.length <= 15 && !JUNK.test(p)) { b.phone = p.trim(); break; }
        }
      }
    }
    // Also look for labeled phone patterns
    if (!b.phone) {
      const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax)\s*[:;]\s*([+\d][\d\s\-\.()]{7,18})/i);
      if (labeledPh && labeledPh[1].replace(/[^\d]/g, '').length >= 8) b.phone = labeledPh[1].trim();
    }
  }

  // Email: mailto, text, Cloudflare decode, &#64; encode
  if (!b.email) {
    const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
    if (mailM && !JUNK.test(mailM[1])) b.email = mailM[1].trim();
    if (!b.email) {
      const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (!JUNK.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break; }
        }
      }
    }
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
    if (!b.email) {
      const entM = html.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (entM && !JUNK.test(entM[0])) b.email = entM[1] + '@' + entM[2];
    }
    // Also extract emails from visible text patterns like "Email: xxx@yyy.com"
    if (!b.email) {
      const labelM = html.match(/(?:email|e-mail|mail|contact)\s*[:;]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (labelM && !JUNK.test(labelM[1])) b.email = labelM[1];
    }
    // Extract from data-email attributes
    if (!b.email) {
      const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
      if (dataEmailM && !JUNK.test(dataEmailM[1])) b.email = dataEmailM[1];
    }
    // Extract from JavaScript variables
    if (!b.email) {
      const jsEmailM = html.match(/['"](\w[\w._%+-]*@[\w.-]+\.[a-zA-Z]{2,})['"]/);
      if (jsEmailM && !JUNK.test(jsEmailM[1]) && jsEmailM[1].length > 6) b.email = jsEmailM[1];
    }
  }

  // Website: extract from DDG result links
  if (!b.website) {
    const links = html.matchAll(/href="([^"]+)"/g);
    for (const link of links) {
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (url.startsWith('http') && !url.match(/google\.|facebook|instagram|yelp|tripadvisor|wikipedia|duckduckgo|linkedin|twitter|x\.com|youtube|tiktok|pinterest/i)) {
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
}

// ── Extract from plain text (e.g. Brave search descriptions) ──
function extractFromText(text: string, b: Business): void {
  if (!b.phone) {
    const m = text.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
    if (m && m[0].length >= 8) b.phone = m[0].trim();
  }
  if (!b.email) {
    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m && !m[0].includes('example.com') && !m[0].includes('google')) b.email = m[0];
  }
  if (!b.facebook) {
    const m = text.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
    if (m && !m[0].includes('login')) b.facebook = 'https://facebook.com/' + m[1];
  }
  if (!b.instagram) {
    const m = text.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    if (m && !m[0].includes('accounts')) b.instagram = 'https://instagram.com/' + m[1];
  }
}

// ─── Brave Search Enrichment ───────────────────────────────────
// Bing Search (free scraping, no API key needed)
async function searchBing(query: string): Promise<{title: string; url: string; snippet: string}[]> {
  try {
    const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://www.bing.com/search?q=' + query + '&count=5')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const results: {title: string; url: string; snippet: string}[] = [];
    // Extract search result blocks
    const blocks = html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const block of blocks) {
      const titleMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (titleMatch) {
        results.push({
          url: titleMatch[1],
          title: titleMatch[2].replace(/<[^>]+>/g, ''),
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '') : '',
        });
      }
    }
    return results;
  } catch { return []; }
}

// Domain probing - check if common domain patterns exist for a business
async function probeDomains(b: Business): Promise<void> {
  if (b.website) return;
  const nameEn = getEnglishCityName(b.name);
  if (!nameEn || nameEn === b.name) return; // Only probe for Latin names
  const slug = nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 20);
  if (slug.length < 3) return;
  const tlds = ['.com', '.ge', '.org', '.net'];
  for (const tld of tlds) {
    try {
      const domain = 'https://' + slug + tld;
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(domain)}`, {
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

const BRAVE_API_KEY = 'BSAded3tnZfvadieW5pz0tiLrlh2lvn';

// ─── Multilingual Search Helpers ───────────────────────────
// Maps common Georgian city names to English
const CITY_EN_MAP: Record<string, string> = {
  'თბილისი': 'Tbilisi', 'ბათუმი': 'Batumi', 'ქუთაისი': 'Kutaisi',
  'რუსთავი': 'Rustavi', 'ზუგდიდი': 'Zugdidi', 'გორი': 'Gori',
  'ფოთი': 'Poti', 'ქობულეთი': 'Kobuleti', 'თელავი': 'Telavi',
  'სამტრედია': 'Samtredia', 'სენაკი': 'Senaki', 'ხაშური': 'Khashuri',
  'ახალციხე': 'Akhaltsikhe', 'ოზურგეთი': 'Ozurgeti', 'მარნეული': 'Marneuli',
  'ერევანი': 'Yerevan', 'ბაქო': 'Baku', 'მოსკოვი': 'Moscow',
  'სტამბოლი': 'Istanbul', 'ლონდონი': 'London', 'პარიზი': 'Paris',
  'ნიუ-იორკი': 'New York', 'ტოკიო': 'Tokyo',
};

// Transliterate Georgian characters to Latin
function transliterateGeo(text: string): string {
  if (!text) return text;
  const map: Record<string, string> = {
    'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v',
    'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l', 'მ': 'm',
    'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's',
    'ტ': 't', 'უ': 'u', 'ფ': 'p', 'ქ': 'k', 'ღ': 'gh', 'ყ': 'q',
    'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts',
    'ჭ': 'ch', 'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h',
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
  // Extract street from address (often in Latin or transliteratable)
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
    if (cityEn) parts.push(cityEn);
  } else {
    // Non-Latin: search by street + category + city (NOT by Georgian name)
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (cityEn) parts.push(cityEn);
    if (category) parts.push(category);
    // Also add transliterated name as fallback
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
  }
  parts.push('phone email website contact');
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

// Guess common email patterns from a website domain
function guessEmailsFromDomain(domain: string): string[] {
  try {
    const host = new URL(domain).hostname.replace(/^www\./, '');
    const prefixes = ['info', 'contact', 'hello', 'mail', 'office', 'admin', 'support', 'reception', 'reservations'];
    return prefixes.map(p => p + '@' + host);
  } catch { return []; }
}

// Also try to find email by scraping the website contact page directly
async function scrapeContactPageForEmail(b: Business): Promise<void> {
  if (b.email || !b.website) return;
  try {
    const base = b.website.replace(/\/$/, '');
    const paths = ['/contact', '/contact-us', '/about', '/about-us', '/kontakti', '/kontakt', '/team', '/info', '/footer', '/imprint', '/privacy', '/sitemap.xml'];
    for (const path of paths) {
      if (b.email) break;
      try {
        const r = await fetch('https://corsproxy.io/?' + encodeURIComponent(base + path), {
          signal: AbortSignal.timeout(6000),
        });
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
        const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
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

// ── Enrichment: reverse-geocode ALL businesses for contact data ──
  const allBizList: Business[] = [];
  for (const bizs of results.values()) {
    for (const b of bizs) allBizList.push(b);
  }

  // English city name for enrichment passes
  const selectedCityEn = allBizList.length > 0 ? getEnglishCityName((allBizList[0].address || '').split(',').pop()?.trim() || '') : '';

  if (allBizList.length > 0) {
    const BATCH = 10;
    const maxEnrich = Math.min(allBizList.length, 200);
    for (let i = 0; i < maxEnrich; i += BATCH) {
      const batch = allBizList.slice(i, i + BATCH);
      const promises = batch.map(async (b) => {
        try {
          const nominatimRevUrl = `https://nominatim.openstreetmap.org/reverse?lat=${b.lat}&lon=${b.lon}&format=json&zoom=18&addressdetails=1&extratags=1&accept-language=en`;
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(nominatimRevUrl)}`, {
            headers: { 'Accept': 'application/json' }
          });
          if (r.ok) {
            const d = await r.json();
            // Fill address if missing
            if (!b.address && d.address) {
              const a = d.address;
              const parts = [a.road || a.pedestrian, a.house_number, a.suburb || a.neighbourhood || a.city_district, a.city || a.town || a.village].filter(Boolean);
              b.address = parts.join(', ') || d.display_name?.split(',').slice(0, 3).join(',') || '';
            }
            // Always try to fill contact data from extratags
            if (!b.phone) b.phone = d.extratags?.phone || d.extratags?.['contact:phone'] || d.extratags?.['contact:mobile'] || '';
            if (!b.email) b.email = d.extratags?.email || d.extratags?.['contact:email'] || '';
            if (!b.website) b.website = d.extratags?.website || d.extratags?.['contact:website'] || d.extratags?.url || '';
            if (!b.facebook) b.facebook = d.extratags?.['contact:facebook'] || d.extratags?.facebook || '';
            if (!b.instagram) b.instagram = d.extratags?.['contact:instagram'] || d.extratags?.instagram || '';
          }
        } catch {}
      });
      await Promise.all(promises);
      // Nominatim rate limit: 1 req/sec
      if (i + BATCH < maxEnrich) await wait(1100);
      onProgress?.(75, `Enriching contact data… ${Math.min(i + BATCH, maxEnrich)}/${maxEnrich}`);
    }
  }

  onProgress?.(80, `Found ${totalBiz} businesses — enriching data in parallel…`);

  // ── TURBO ENRICHMENT: Multi-strategy parallel pass ──
  const BATCH_SIZE = 8;
  let enrichedCount = 0;

  // ── Pass 1: DDG + Brave in parallel for every business ──
  const NEEDS_ENRICHMENT = allBizList.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  const maxEnrich = Math.min(NEEDS_ENRICHMENT.length, 200);

  for (let i = 0; i < maxEnrich; i += BATCH_SIZE) {
    const batch = NEEDS_ENRICHMENT.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (b) => {
      try {
        const q = buildSearchQuery(b);
        // DDG + Brave in parallel
        const ddgP = fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        }).then(async r => {
          if (r.ok) { extractFromHtml(await r.text(), b); enrichedCount++; }
        }).catch(() => {});

        const braveP = BRAVE_API_KEY ? fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=3`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
          signal: AbortSignal.timeout(8000),
        }).then(async r => {
          if (!r.ok) return;
          const data = await r.json();
          for (const res of (data.web?.results || [])) {
            extractFromText((res.description || '') + ' ' + (res.title || ''), b);
            if (!b.website && res.url && !res.url.includes('google.com') && !res.url.includes('facebook.com')) b.website = res.url;
          }
          if (!b.website && data.knowledge_graph?.url && !EXCLUDE_DOMAINS.test(data.knowledge_graph.url)) b.website = data.knowledge_graph.url;
        }).catch(() => {}) : Promise.resolve();

        // Bing search (different results than DDG/Brave)
        const bingP = searchBing(q).then(results => {
          for (const res of results) {
            if (!b.phone) {
              const phM = (res.snippet + ' ' + res.title).match(/\+?[\d][\d\s\-\.()]{7,18}/);
              if (phM && phM[0].replace(/[^\d]/g, '').length >= 8) b.phone = phM[0].trim();
            }
            if (!b.email) {
              const emM = (res.snippet + ' ' + res.title).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              if (emM && !emM[0].includes('example.com')) b.email = emM[0];
            }
            if (!b.website && res.url && !res.url.includes('google.com') && !res.url.includes('facebook.com') && !res.url.includes('bing.com')) {
              b.website = res.url;
            }
          }
        }).catch(() => {});

        await Promise.all([ddgP, braveP, bingP]);
        // Probe domains if still no website
        if (!b.website) await probeDomains(b);
        // Scrape website if found
        if (b.website && (!b.email || !b.phone || !b.facebook)) await enrichFromWebsiteDeep(b);
      } catch {}
    }));
    if (i + BATCH_SIZE < maxEnrich) await wait(1200);
    onProgress?.(83, `Pass 1 (search)… ${Math.min(i + BATCH_SIZE, maxEnrich)}/${maxEnrich} (${enrichedCount} enriched)`);
  }

  // ── Pass 1b: Category-based search for businesses still missing ALL data ─
  const stillMissing = allBizList.filter(b => !b.phone && !b.email && !b.website);
  if (stillMissing.length > 0) {
    const byCategory = new Map<string, Business[]>();
    for (const b of stillMissing) {
      const cat = b.categoryLabel || b.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(b);
    }
    for (const [catLabel, catBizs] of byCategory) {
      const cityEn = catBizs[0].address ? getEnglishCityName(catBizs[0].address.split(',').pop()?.trim() || '') : '';
      if (!cityEn) continue;
      const catQuery = encodeURIComponent(catLabel + ' ' + cityEn + ' phone email contact');
      try {
        const r = await fetch('https://corsproxy.io/?' + encodeURIComponent('https://html.duckduckgo.com/html/?q=' + catQuery), {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const html = await r.text();
          const resultBlocks = html.match(/class="result__body"[^>]*>[\s\S]*?(?=class="result__body"|$)/g) || [];
          for (const block of resultBlocks) {
            const blockText = block.replace(/<[^>]+>/g, ' ');
            const blockLinks = block.match(/href="([^"]+)"/g) || [];
            for (const b of catBizs) {
              const nameEn2 = getEnglishCityName(b.name);
              const nameLower = (nameEn2 || b.name).toLowerCase();
              const blockLower = blockText.toLowerCase();
              if (blockLower.includes(nameLower) || (nameLower.length > 3 && blockLower.includes(nameLower.substring(0, Math.min(nameLower.length, 6))))) {
                if (!b.phone) {
                  const phM = blockText.match(/\+?[\d][\d\s\-\.()]{7,18}/);
                  if (phM && phM[0].replace(/[^\d]/g, '').length >= 8) b.phone = phM[0].trim();
                }
                if (!b.email) {
                  const emM = blockText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                  if (emM && !emM[0].includes('example.com')) b.email = emM[0];
                }
                if (!b.website) {
                  for (const link of blockLinks) {
                    let url = link.replace(/href="/, '').replace(/"$/, '');
                    const uddg = url.match(/uddg=([^&]+)/);
                    if (uddg) url = decodeURIComponent(uddg[1]);
                    if (url.startsWith('http') && !url.match(/google|facebook|instagram|yelp|wikipedia|duckduckgo/i)) {
                      b.website = url; break;
                    }
                  }
                }
                if (b.phone || b.email || b.website) break;
              }
            }
          }
        }
      } catch {}
      await wait(1500);
    }
    onProgress?.(85, 'Category search complete');
  }

  // ── Pass 1d: Address-based search for non-Latin businesses ─
  const needAddressSearch = allBizList.filter(b => !b.phone && !b.email && !b.website && !/^[a-zA-Z]/.test(b.name));
  if (needAddressSearch.length > 0) {
    onProgress?.(86, `Pass 1d (address search)... ${needAddressSearch.length} businesses`);
    for (let i = 0; i < Math.min(needAddressSearch.length, 50); i += BATCH_SIZE) {
      const batch = needAddressSearch.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
          const streetEn = getEnglishCityName(street);
          const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
          const category = b.categoryLabel || '';
          if (!streetEn || streetEn === street) return;
          const q = encodeURIComponent(streetEn + ' ' + cityEn + ' ' + category + ' phone email');
          const ddgR = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (ddgR.ok) extractFromHtml(await ddgR.text(), b);
          if (!b.phone || !b.email) {
            const bingResults = await searchBing(q);
            for (const res of bingResults) {
              const text = res.snippet + ' ' + res.title;
              if (!b.phone) {
                const phM = text.match(/\+?[\d][\d\s\-\.()]{7,18}/);
                if (phM && phM[0].replace(/[^\d]/g, '').length >= 8) b.phone = phM[0].trim();
              }
              if (!b.email) {
                const emM = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emM && !emM[0].includes('example.com')) b.email = emM[0];
              }
              if (!b.website && res.url && !res.url.includes('google.com') && !res.url.includes('facebook.com')) {
                b.website = res.url;
              }
              if (b.phone && b.email) break;
            }
          }
        } catch {}
      }));
      if (i + BATCH_SIZE < needAddressSearch.length) await wait(1200);
    }
  }

  // ── Pass 2: Targeted email search for businesses still missing email ──
  // Also try direct contact page scraping for businesses with websites
  const missingEmailWebsites = allBizList.filter(b => !b.email && b.website);
  if (missingEmailWebsites.length > 0) {
    for (let i = 0; i < Math.min(missingEmailWebsites.length, 60); i += BATCH_SIZE) {
      const batch = missingEmailWebsites.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(b => scrapeContactPageForEmail(b)));
      if (i + BATCH_SIZE < missingEmailWebsites.length) await wait(800);
    }
  }
  // ── Pass 1c: Domain probing for businesses without websites ──
  const noWebsite = allBizList.filter(b => !b.website);
  if (noWebsite.length > 0) {
    for (let i = 0; i < Math.min(noWebsite.length, 40); i += BATCH_SIZE) {
      const batch = noWebsite.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(b => probeDomains(b)));
      if (i + BATCH_SIZE < noWebsite.length) await wait(500);
    }
  }

  const missingEmail = allBizList.filter(b => !b.email);
  if (missingEmail.length > 0) {
    onProgress?.(87, `Pass 2 (email)… searching ${missingEmail.length} businesses`);
    for (let i = 0; i < Math.min(missingEmail.length, 80); i += BATCH_SIZE) {
      const batch = missingEmail.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const q = buildEmailQuery(b);
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) extractFromHtml(await r.text(), b);
          // Also try Brave for email
          if (!b.email && BRAVE_API_KEY) {
            try {
              const br = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=2`, {
                headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
                signal: AbortSignal.timeout(6000),
              });
              if (br.ok) {
                const bd = await br.json();
                for (const res of (bd.web?.results || [])) extractFromText((res.description || '') + ' ' + (res.title || ''), b);
              }
            } catch {}
          }
          // If still no email but we have a website, try guessing email patterns
          if (!b.email && b.website) {
            const guesses = guessEmailsFromDomain(b.website);
            if (guesses.length > 0) {
              // Quick HEAD request to check if common emails exist (won't work for most servers)
              // Instead, just set info@ as fallback — most common business email
              b.email = guesses[0]; // info@domain.com
            }
          }
        } catch {}
      }));
      if (i + BATCH_SIZE < missingEmail.length) await wait(1200);
    }
  }

  // ── Pass 3: Targeted phone search for businesses still missing phone ──
  const missingPhone = allBizList.filter(b => !b.phone);
  if (missingPhone.length > 0) {
    onProgress?.(90, `Pass 3 (phone)… searching ${missingPhone.length} businesses`);
    for (let i = 0; i < Math.min(missingPhone.length, 80); i += BATCH_SIZE) {
      const batch = missingPhone.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const q = buildPhoneQuery(b);
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) extractFromHtml(await r.text(), b);
          // Also try Brave
          if (!b.phone && BRAVE_API_KEY) {
            try {
              const br = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=2`, {
                headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
                signal: AbortSignal.timeout(6000),
              });
              if (br.ok) {
                const bd = await br.json();
                for (const res of (bd.web?.results || [])) extractFromText((res.description || '') + ' ' + (res.title || ''), b);
              }
            } catch {}
          }
        } catch {}
      }));
      if (i + BATCH_SIZE < missingPhone.length) await wait(1200);
    }
  }

  // ── Pass 4: Website scraping for businesses that got website from search ──
  const needScrape = allBizList.filter(b => b.website && (!b.email || !b.phone || !b.facebook || !b.instagram));
  if (needScrape.length > 0) {
    onProgress?.(93, `Pass 4 (website scraping)… ${needScrape.length} sites`);
    for (let i = 0; i < Math.min(needScrape.length, 80); i += BATCH_SIZE) {
      const batch = needScrape.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        await enrichFromWebsiteDeep(b);
        if (!b.email) await scrapeContactPageForEmail(b);
      }));
      if (i + BATCH_SIZE < needScrape.length) await wait(1000);
    }
  }

  // ── Pass 5: Social media search for businesses still missing social ──
  const missingSocial = allBizList.filter(b => !b.facebook && !b.instagram && !b.website);
  if (missingSocial.length > 0) {
    onProgress?.(95, `Pass 5 (social)… ${missingSocial.length} businesses`);
    for (let i = 0; i < Math.min(missingSocial.length, 50); i += BATCH_SIZE) {
      const batch = missingSocial.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const cityEn = getEnglishCityName(b.address?.split(',').pop()?.trim() || '');
          const socialQ = encodeURIComponent(`"${b.name}" ${cityEn} facebook instagram`);
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + socialQ)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) extractFromHtml(await r.text(), b);
        } catch {}
      }));
      if (i + BATCH_SIZE < missingSocial.length) await wait(1200);
    }
  }

  // ── Pass 6b: 2GIS search for businesses still missing data ─
  // 2GIS is excellent for Georgia, Russia, CIS countries
  const need2GIS = allBizList.filter(b => !b.phone && !b.email && !b.website);
  if (need2GIS.length > 0) {
    onProgress?.(94, `Pass 6b (2GIS)... ${need2GIS.length} businesses`);
    for (let i = 0; i < Math.min(need2GIS.length, 40); i += BATCH_SIZE) {
      const batch = need2GIS.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const nameEn = getEnglishCityName(b.name);
          const q = encodeURIComponent((nameEn || b.name) + ' ' + (b.address?.split(',').pop() || ''));
          // Search 2GIS catalog API
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://catalog.api.2gis.com/3.0/items?q=' + q + '&key=rurbbn3446&fields=items.contact_groups,items.reviews')}`, {
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) {
            const data = await r.json();
            const items = data.result?.items || [];
            for (const item of items) {
              const itemName = (item.name || '').toLowerCase();
              const bizName = (nameEn || b.name).toLowerCase();
              if (itemName.includes(bizName.substring(0, 5)) || bizName.includes(itemName.substring(0, 5))) {
                // Found match — extract contact info
                if (!b.phone && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of (grp.contacts || [])) {
                      if (contact.type === 'phone' && contact.value) {
                        b.phone = contact.value.replace(/\D/g, '').length >= 8 ? contact.value : '';
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
                if (!b.address && item.address_name) {
                  b.address = item.address_name;
                }
                break;
              }
            }
          }
        } catch {}
      }));
      if (i + BATCH_SIZE < need2GIS.length) await wait(1000);
    }
  }

  // ── Pass 6c: Yandex search for businesses still missing data ─
  // Yandex is dominant in Georgia/Russia/CIS
  const needYandex = allBizList.filter(b => !b.phone && !b.email && !b.website);
  if (needYandex.length > 0) {
    onProgress?.(95, `Pass 6c (Yandex)... ${needYandex.length} businesses`);
    for (let i = 0; i < Math.min(needYandex.length, 30); i += BATCH_SIZE) {
      const batch = needYandex.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const nameEn = getEnglishCityName(b.name);
          const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
          const q = encodeURIComponent(`site:yandex.* ${nameEn || b.name} ${cityEn || ''} phone`);
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) {
            const html = await r.text();
            // Extract from Yandex search result snippets
            const snippetBlocks = html.match(/class="result__snippet"[^>]*>[\s\S]*?(?=class="result__body"|$)/g) || [];
            for (const block of snippetBlocks) {
              const text = block.replace(/<[^>]+>/g, ' ');
              if (!b.phone) {
                const phM = text.match(/\+?[\d][\d\s\-\.()]{7,18}/);
                if (phM && phM[0].replace(/[^\d]/g, '').length >= 8) b.phone = phM[0].trim();
              }
              if (!b.email) {
                const emM = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emM && !emM[0].includes('example.com')) b.email = emM[0];
              }
              if (b.phone || b.email) break;
            }
          }
        } catch {}
      }));
      if (i + BATCH_SIZE < needYandex.length) await wait(1200);
    }
  }

  // ── Pass 6d: Wikipedia/Wikidata lookup for popular businesses ─
  const needWiki = allBizList.filter(b => !b.phone && !b.email && !b.website && !b.facebook);
  if (needWiki.length > 0) {
    const cityEn = selectedCityEn || '';
    for (let i = 0; i < Math.min(needWiki.length, 30); i += BATCH_SIZE) {
      const batch = needWiki.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (b) => {
        try {
          const nameEn = getEnglishCityName(b.name);
          const q = encodeURIComponent(`"${nameEn || b.name}" Wikipedia`);
          const r = await fetch(`https://corsproxy.io/?${encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(6000),
          });
          if (r.ok) {
            const html = await r.text();
            // Find Wikipedia links
            const wikiMatch = html.match(/en\.wikipedia\.org\/wiki\/([\w%]+)/);
            if (wikiMatch) {
              const wikiUrl = 'https://en.wikipedia.org/wiki/' + wikiMatch[1];
              if (!b.website) b.website = wikiUrl;
              // Try to get info from Wikipedia page
              try {
                const wr = await fetch(`https://corsproxy.io/?${encodeURIComponent(wikiUrl)}`, {
                  signal: AbortSignal.timeout(6000),
                });
                if (wr.ok) {
                  const wHtml = await wr.text();
                  if (!b.phone) {
                    const phM = wHtml.match(/\+?[\d][\d\s\-\.()]{7,18}/);
                    if (phM && phM[0].replace(/[^\d]/g, '').length >= 8) b.phone = phM[0].trim();
                  }
                  if (!b.email) {
                    const emM = wHtml.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                    if (emM && !emM[0].includes('example.com') && !emM[0].includes('wikipedia')) b.email = emM[0];
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }));
      if (i + BATCH_SIZE < needWiki.length) await wait(800);
    }
  }

  // ── Pass 6: Google Maps for businesses with zero data ──
  const zeroData = allBizList.filter(b => !b.phone && !b.email && !b.website && !b.facebook && !b.instagram);
  if (zeroData.length > 0) {
    onProgress?.(97, `Pass 6 (Google Maps)… ${zeroData.length} businesses`);
    await enrichFromGooglePlaces(zeroData, onProgress);
  }

  return results;
}


// ─── Detail-Mode Enrichment ─────────────────────────────────
export async function enrichCategory(
  businesses: Business[],
  onProgress?: (pct: number, msg: string) => void,
): Promise<Business[]> {
  if (businesses.length === 0) return businesses;
  const BATCH_SIZE = 8;
  const total = businesses.length;
  onProgress?.(0, 'Enriching ' + total + ' businesses...');
  for (let i = 0; i < Math.min(total, 150); i += BATCH_SIZE) {
    const batch = businesses.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (b) => {
      try {
        const q = buildSearchQuery(b);
        const ddgP = fetch('https://corsproxy.io/?' + encodeURIComponent('https://html.duckduckgo.com/html/?q=' + q), {
          headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000),
        }).then(async r => { if (r.ok) extractFromHtml(await r.text(), b); }).catch(() => {});
        const braveP = BRAVE_API_KEY ? fetch('https://api.search.brave.com/res/v1/web/search?q=' + q + '&count=3', {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
          signal: AbortSignal.timeout(8000),
        }).then(async r => {
          if (!r.ok) return;
          const data = await r.json();
          for (const res of (data.web?.results || [])) {
            extractFromText((res.description || '') + ' ' + (res.title || ''), b);
            if (!b.website && res.url && !res.url.includes('google.com') && !res.url.includes('facebook.com')) b.website = res.url;
          }
        }).catch(() => {}) : Promise.resolve();
        await Promise.all([ddgP, braveP]);
      } catch {}
    }));
    if (i + BATCH_SIZE < total) await wait(1200);
  }
  onProgress?.(100, 'Done!');
  return businesses;
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
  const ddgP = fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${categoryLabel}" "${cityName}"`)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then(async r => {
    if (r.ok) {
      const h = await r.text();
      signals.webSearch = Math.min(100, (h.match(/class="result__snippet"/g)?.length || 0) * 10);
      signals.sources.push('Web Search');
    }
  }).catch(() => {});

  // Google Trends via SerpAPI free tier or direct scrape
  const gtP = fetch(
    `https://trends.google.com/trends/api/explore?hl=en-US&tz=-240&req={"comparisonItem":[{"keyword":"${encodeURIComponent(categoryLabel.toLowerCase())}","geo":"${encodeURIComponent(cityName)}","time":"today 12-m"}],"category":0,"property":""}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then(async r => {
    if (r.ok) {
      const text = await r.text();
      // Google Trends prefixes response with ")]}'\n"
      const json = text.replace(/^\)\]\}'\\n/, '');
      try {
        const d = JSON.parse(json);
        const timeline = d?.default?.timelineData;
        if (timeline && timeline.length > 0) {
          const avg = timeline.reduce((s: number, t: any) => s + (t.value?.[0] || 0), 0) / timeline.length;
          signals.webSearch = Math.min(100, Math.round(avg));
          if (!signals.sources.includes('Google Trends')) signals.sources.push('Google Trends');
        }
      } catch {}
    }
  }).catch(() => {});

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
