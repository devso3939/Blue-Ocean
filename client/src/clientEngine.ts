/**
 * Blue Ocean Client Engine
 * 
 * 100% client-side — runs in the browser, no backend needed.
 * Uses free public APIs:
 * - Nominatim (city resolution, boundaries)
 * - Overpass API (OpenStreetMap businesses) with fallback
 * - Wikipedia REST API (demand signals)
 * - DuckDuckGo (search density)
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
  osmType: string;
  osmId: number;
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
      osmType: r.osm_type,
      osmId: r.osm_id,
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
  openingHours: string;
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
  kindergarten: { label: 'Kindergarten' },
  cinema: { label: 'Cinema' },
  theater: { label: 'Theater' },
  museum: { label: 'Museum' },
  fuel: { label: 'Gas Station' },
  bakery: { label: 'Bakery' },
  car_repair: { label: 'Car Repair' },
  laundry: { label: 'Laundry' },
  pet_groomer: { label: 'Pet Groomer' },
  pet_shop: { label: 'Pet Shop' },
  coworking: { label: 'Coworking Space' },
  library: { label: 'Library' },
  post_office: { label: 'Post Office' },
  yoga: { label: 'Yoga Studio' },
  tattoo: { label: 'Tattoo Parlor' },
  nail_salon: { label: 'Nail Salon' },
  spa: { label: 'Spa' },
  hostel: { label: 'Hostel' },
  guest_house: { label: 'Guest House' },
  camping: { label: 'Campsite' },
  car_rental: { label: 'Car Rental' },
  jewelry: { label: 'Jewelry Store' },
  shoes: { label: 'Shoe Store' },
  sports: { label: 'Sports Store' },
  books: { label: 'Bookstore' },
  mobile_phone: { label: 'Mobile Phone Store' },
  convenience: { label: 'Convenience Store' },
  department_store: { label: 'Department Store' },
  ice_cream: { label: 'Ice Cream Shop' },
  art: { label: 'Art Gallery' },
  bicycle: { label: 'Bicycle Shop' },
  bowling: { label: 'Bowling Alley' },
  night_club: { label: 'Nightclub' },
  veterinary: { label: 'Veterinary' },
  community_center: { label: 'Community Center' },
  optician: { label: 'Optician' },
  butcher: { label: 'Butcher' },
  florist: { label: 'Florist' },
  marketplace: { label: 'Marketplace' },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_QUERIES);

export function getCategoryLabel(id: string): string {
  return CATEGORY_QUERIES[id]?.label || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Improved Categorization ───────────────────────────────────────

function categorizeBusiness(tags: Record<string, string>): string | null {
  const a = tags.amenity;
  const s = tags.shop;
  const t = tags.tourism;
  const l = tags.leisure;
  const o = tags.office;
  const c = tags.cuisine || '';

  // Amenity-based
  if (a === 'cafe' || c.includes('coffee') || c.includes('espresso') || c.includes('cappuccino')) return 'cafe';
  if (a === 'restaurant' || (a && c && a !== 'cafe' && a !== 'bar' && a !== 'fast_food')) return 'restaurant';
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
  if (a === 'kindergarten') return 'kindergarten';
  if (a === 'cinema') return 'cinema';
  if (a === 'theatre' || a === 'arts_centre') return 'theater';
  if (a === 'fuel') return 'fuel';
  if (a === 'veterinary' || a === 'animal_shelter') return 'veterinary';
  if (a === 'community_centre') return 'community_center';
  if (a === 'library') return 'library';
  if (a === 'post_office') return 'post_office';
  if (a === 'car_rental') return 'car_rental';
  if (a === 'nightclub') return 'night_club';
  if (a === 'casino') return 'night_club';
  if (a === 'marketplace') return 'marketplace';
  if (a === 'shelter') return null; // not a business

  // Tourism
  if (t === 'hotel' || t === 'motel' || t === 'apartment') return 'hotel';
  if (t === 'hostel') return 'hostel';
  if (t === 'guest_house' || t === 'bed_and_breakfast') return 'guest_house';
  if (t === 'camp_site') return 'camping';
  if (t === 'museum') return 'museum';

  // Leisure
  if (l === 'fitness_centre' || l === 'sports_centre' || l === 'pitch' || l === 'stadium' || tags.sport) return 'gym';
  if (l === 'bowling_alley') return 'bowling';
  if (l === 'yoga') return 'yoga';
  if (l === 'dance') return 'yoga';

  // Office
  if (o === 'coworking' || o === 'company') return 'coworking';

  // Shop — broad matching
  if (s === 'beauty' || s === 'cosmetics') return 'beauty_salon';
  if (s === 'hairdresser' || s === 'wigs') return 'hair_salon';
  if (s === 'nail_salon') return 'nail_salon';
  if (s === 'tattoo' || s === 'piercing') return 'tattoo';
  if (s === 'supermarket' || s === 'greengrocer' || s === 'deli') return 'supermarket';
  if (s === 'grocery' || s === 'health_food') return 'grocery';
  if (s === 'convenience' || s === 'kiosk' || s === 'newsagent') return 'convenience';
  if (s === 'clothes' || s === 'fashion' || s === 'boutique') return 'clothing';
  if (s === 'shoes' || s === 'shoe') return 'shoes';
  if (s === 'electronics' || s === 'mobile_phone' || s === 'computer' || s === 'hifi') return 'electronics';
  if (s === 'furniture' || s === 'interior_decoration' || s === 'houseware') return 'furniture';
  if (s === 'doityourself' || s === 'trade' || s === 'hardware') return 'hardware';
  if (s === 'bakery' || s === 'pastry') return 'bakery';
  if (s === 'butcher') return 'butcher';
  if (s === 'florist') return 'florist';
  if (s === 'optician' || s === 'eyewear') return 'optician';
  if (s === 'car_repair' || s === 'car' || s === 'car_parts') return 'car_repair';
  if (s === 'laundry' || s === 'dry_cleaning') return 'laundry';
  if (s === 'pet_grooming' || s === 'pet') return 'pet_groomer';
  if (s === 'jewelry' || s === 'jewellery' || s === 'watches') return 'jewelry';
  if (s === 'sports' || s === 'outdoor') return 'sports';
  if (s === 'books' || s === 'stationery') return 'books';
  if (s === 'department_store') return 'department_store';
  if (s === 'wine' || s === 'alcohol') return 'wine';
  if (s === 'art') return 'art';
  if (s === 'bicycle') return 'bicycle';
  if (s === 'fuel') return 'fuel';

  // Generic amenity fallback
  if (a) {
    const map: Record<string, string> = {
      restaurant: 'restaurant', cafe: 'cafe', bar: 'bar', fast_food: 'fast_food',
      pharmacy: 'pharmacy', hospital: 'hospital', bank: 'bank', school: 'school',
    };
    return map[a] || null;
  }

  return null;
}

// ─── Improved Parsing ──────────────────────────────────────────────

function extractPhone(tags: Record<string, string>): string {
  return tags.phone || tags['contact:phone'] || tags['contact:mobile'] || 
         tags['phone:mobile'] || tags['phone:international'] || '';
}

function extractEmail(tags: Record<string, string>): string {
  return tags.email || tags['contact:email'] || tags['email:office'] || '';
}

function extractWebsite(tags: Record<string, string>): string {
  return tags.website || tags['contact:website'] || tags['url'] || '';
}

function extractFacebook(tags: Record<string, string>): string {
  const raw = tags['contact:facebook'] || tags.facebook || '';
  if (!raw) return '';
  // Clean up the URL
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('www.')) return `https://${raw}`;
  return `https://facebook.com/${raw.replace(/^\/+/, '')}`;
}

function extractInstagram(tags: Record<string, string>): string {
  const raw = tags['contact:instagram'] || tags.instagram || '';
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  const handle = raw.replace(/^@+/, '');
  return `https://instagram.com/${handle}`;
}

function formatAddress(tags: Record<string, string>): string {
  const parts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city'], tags['addr:postcode']].filter(Boolean);
  return parts.join(', ') || tags.address || '';
}

// ─── Overpass API with Fallback ────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function fetchOverpass(query: string): Promise<any> {
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 50000);
      const res = await fetch(mirror, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      
      if (!res.ok) continue; // Try next mirror
      
      const text = await res.text();
      // Check if response is actually JSON (not an error page)
      if (!text.trim().startsWith('{')) continue;
      
      const data = JSON.parse(text);
      // Check for Overpass error in the response
      if (data.remark?.includes('error') || data.elements === undefined) continue;
      
      return data;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Query businesses via Overpass API.
 * If the main broad query fails, falls back to a simpler query.
 */
export async function queryBusinesses(
  lat: number,
  lon: number,
  radiusMeters: number = 10000,
  _categoryIds?: string[],
  onProgress?: (pct: number, msg: string) => void
): Promise<Map<string, Business[]>> {
  const results = new Map<string, Business[]>();
  const south = lat - radiusMeters / 111000;
  const north = lat + radiusMeters / 111000;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const west = lon - radiusMeters / (111000 * cosLat);
  const east = lon + radiusMeters / (111000 * cosLat);

  onProgress?.(5, 'Downloading businesses from OpenStreetMap…');

  // Try broad query first
  const broadQuery = `[out:json][timeout:60];
(
  node(${south},${west},${north},${east})["amenity"];
  node(${south},${west},${north},${east})["shop"];
  node(${south},${west},${north},${east})["tourism"~"hotel|hostel|guest_house|camp_site|museum"];
  node(${south},${west},${north},${east})["leisure"~"fitness_centre|sports_centre|bowling_alley|yoga"];
  node(${south},${west},${north},${east})["office"];
  way(${south},${west},${north},${east})["amenity"];
  way(${south},${west},${north},${east})["shop"];
  way(${south},${west},${north},${east})["tourism"~"hotel|hostel|guest_house|camp_site|museum"];
  way(${south},${west},${north},${east})["leisure"~"fitness_centre|sports_centre|bowling_alley|yoga"];
  way(${south},${west},${north},${east})["office"];
);
out center body;`;

  let data = await fetchOverpass(broadQuery);

  // Fallback: simpler query if broad fails
  if (!data?.elements?.length) {
    onProgress?.(10, 'Trying alternative data source…');
    const simpleQuery = `[out:json][timeout:45];
(
  node(${south},${west},${north},${east})["amenity"~"cafe|restaurant|bar|fast_food|pharmacy|bank|hotel|gym|cinema|school|hospital|dentist|beauty|hairdresser|supermarket|bakery|clothes|shoes|electronics|car_repair|laundry|pet"];
  node(${south},${west},${north},${east})["shop"];
  way(${south},${west},${north},${east})["amenity"~"cafe|restaurant|bar|fast_food|pharmacy|bank|hotel|gym|cinema|school|hospital|dentist|beauty|hairdresser|supermarket|bakery|clothes|shoes|electronics|car_repair|laundry|pet"];
  way(${south},${west},${north},${east})["shop"];
);
out center body;`;
    data = await fetchOverpass(simpleQuery);
  }

  onProgress?.(30, 'Categorizing businesses…');

  if (!data?.elements?.length) {
    onProgress?.(35, 'No businesses found in this area');
    return results;
  }

  const seenLocations = new Map<string, string>();

  for (const el of data.elements) {
    const elLat = el.lat || el.center?.lat;
    const elLon = el.lon || el.center?.lon;
    if (!elLat || !elLon) continue;

    const tags = el.tags || {};
    const category = categorizeBusiness(tags);
    if (!category) continue;

    const locKey = `${Math.round(elLat * 1000)},${Math.round(elLon * 1000)}`;
    const existingCat = seenLocations.get(locKey);
    if (existingCat === category) continue;
    seenLocations.set(locKey, category);

    const name = tags.name || tags['name:en'] || tags['name:int'] || tags.brand || '';

    const business: Business = {
      id: `${el.type}/${el.id}`,
      name,
      lat: elLat,
      lon: elLon,
      category,
      categoryLabel: getCategoryLabel(category),
      address: formatAddress(tags),
      phone: extractPhone(tags),
      website: extractWebsite(tags),
      email: extractEmail(tags),
      openingHours: tags.opening_hours || '',
      brand: tags.brand || '',
      cuisine: tags.cuisine || '',
      facebook: extractFacebook(tags),
      instagram: extractInstagram(tags),
    };

    if (!results.has(category)) results.set(category, []);
    results.get(category)!.push(business);
  }

  const totalBiz = Array.from(results.values()).reduce((s, a) => s + a.length, 0);
  onProgress?.(35, `Found ${totalBiz} businesses in ${results.size} categories`);
  return results;
}

// ─── Google Maps URL ───────────────────────────────────────────────

export function getGoogleMapsUrl(b: Business): string {
  if (b.name) {
    const parts = [b.name, b.address].filter(Boolean);
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(' '))}`;
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

  const wikiPromise = fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(categoryLabel.replace(/ /g, '_'))}/monthly/20240101/20260101`,
    { headers: { 'User-Agent': 'BlueOcean/1.0 (demand research)' } }
  ).then(async res => {
    if (res.ok) {
      const data = await res.json();
      const total = data.items?.reduce((sum: number, item: any) => sum + (item.views || 0), 0) || 0;
      signals.wikipedia = Math.min(100, Math.round(Math.log10(total + 1) * 16.7));
      signals.sources.push('Wikipedia');
    }
  }).catch(() => {});

  const redditPromise = fetch(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(`${categoryLabel} ${cityName}`)}&sort=new&t=month&limit=25`,
    { headers: { 'User-Agent': 'BlueOcean/1.0 (demand research)' } }
  ).then(async res => {
    if (res.ok) {
      const data = await res.json();
      const count = data.data?.children?.length || 0;
      signals.reddit = Math.min(100, count * 5);
      signals.sources.push('Reddit');
    }
  }).catch(() => {});

  const ddgPromise = fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${categoryLabel}" "${cityName}"`)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then(async res => {
    if (res.ok) {
      const html = await res.text();
      const matches = html.match(/class="result__snippet"/g);
      signals.webSearch = Math.min(100, (matches?.length || 0) * 10);
      signals.sources.push('Web Search');
    }
  }).catch(() => {});

  await Promise.race([
    Promise.all([wikiPromise, redditPromise, ddgPromise]),
    new Promise(r => setTimeout(r, 8000)),
  ]);

  signals.score = Math.round(
    0.35 * signals.webSearch +
    0.30 * signals.wikipedia +
    0.25 * signals.reddit +
    0.10 * Math.max(signals.webSearch, signals.wikipedia, signals.reddit)
  );
  signals.confidence = Math.round(
    ([signals.wikipedia, signals.reddit, signals.webSearch].filter(s => s > 0).length / 3) * 100
  );

  const parts: string[] = [];
  if (signals.webSearch > 50) parts.push('strong web presence');
  else if (signals.webSearch > 20) parts.push('moderate web presence');
  if (signals.wikipedia > 30) parts.push('active knowledge-seeking');
  if (signals.reddit > 20) parts.push(`${signals.reddit} community discussions`);
  signals.explanation = parts.length ? parts.join(', ') : 'Limited demand data available';

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

  const per10kValues: number[] = [];
  for (const [, bizs] of businesses) {
    per10kValues.push((bizs.length / Math.max(population, 1)) * 10000);
  }
  per10kValues.sort((a, b) => a - b);
  const median = per10kValues.length > 0 ? per10kValues[Math.floor(per10kValues.length / 2)] : 1;

  for (const [cat, bizs] of businesses) {
    const existing = bizs.length;
    const per10k = (existing / Math.max(population, 1)) * 10000;
    const expected = Math.round((median * population) / 10000);
    const gap = expected - existing;
    const gapPct = expected > 0 ? gap / expected : 0;

    const gapScore = gapPct > 0 ? Math.min(100, Math.round(gapPct * 100)) : Math.max(0, Math.round(50 + gapPct * 50));
    const sizeScore = Math.min(100, Math.round(Math.log10(Math.max(population, 1)) * 15));

    let score = Math.round(0.60 * gapScore + 0.15 * sizeScore + 0.25 * 50);

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
