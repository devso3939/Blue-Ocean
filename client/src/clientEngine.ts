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

  // ── Enrichment: reverse-geocode ALL businesses for contact data ──
  const allBizList: Business[] = [];
  for (const bizs of results.values()) {
    for (const b of bizs) allBizList.push(b);
  }

  if (allBizList.length > 0) {
    const BATCH = 10;
    const maxEnrich = Math.min(allBizList.length, 200);
    for (let i = 0; i < maxEnrich; i += BATCH) {
      const batch = allBizList.slice(i, i + BATCH);
      const promises = batch.map(async (b) => {
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${b.lat}&lon=${b.lon}&format=json&zoom=18&addressdetails=1&extratags=1`,
            { headers: { 'User-Agent': 'BlueOcean/2.0' } }
          );
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

  onProgress?.(80, `Found ${totalBiz} businesses in ${results.size} categories`);
  return results;
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
