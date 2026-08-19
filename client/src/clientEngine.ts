/**
 * Blue Ocean Client Engine
 * 
 * 100% client-side — runs in the browser, no backend needed.
 * Uses free public APIs:
 * - Nominatim (city resolution, boundaries)
 * - Overpass API (OpenStreetMap businesses) — ONE broad query with multilingual names
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
  const data = await res.json();
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
  wikidata: string;
  wikipedia: string;
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

// ─── Single Overpass Query (broad + multilingual) ──────────────────

function categorizeBusiness(tags: Record<string, string>): string | null {
  // Amenity-based
  if (tags.amenity === 'cafe' || tags.cuisine?.includes('coffee') || tags.cuisine?.includes('espresso')) return 'cafe';
  if (tags.amenity === 'restaurant') return 'restaurant';
  if (tags.amenity === 'bar' || tags.amenity === 'biergarten') return 'bar';
  if (tags.amenity === 'pub') return 'pub';
  if (tags.amenity === 'fast_food' || tags.amenity === 'food_court') return 'fast_food';
  if (tags.amenity === 'ice_cream') return 'ice_cream';
  if (tags.amenity === 'pharmacy' || tags.amenity === 'chemist') return 'pharmacy';
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'clinic' || tags.amenity === 'doctors') return 'clinic';
  if (tags.amenity === 'dentist') return 'dentist';
  if (tags.amenity === 'bank') return 'bank';
  if (tags.amenity === 'school' || tags.amenity === 'college') return 'school';
  if (tags.amenity === 'kindergarten' || tags.amenity === ' nursery') return 'kindergarten';
  if (tags.amenity === 'cinema') return 'cinema';
  if (tags.amenity === 'theatre' || tags.amenity === 'arts_centre') return 'theater';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.amenity === 'veterinary' || tags.amenity === 'animal_shelter') return 'veterinary';
  if (tags.amenity === 'community_centre') return 'community_center';
  if (tags.amenity === 'library') return 'library';
  if (tags.amenity === 'post_office') return 'post_office';
  if (tags.amenity === 'car_rental') return 'car_rental';
  if (tags.amenity === 'nightclub') return 'night_club';
  if (tags.amenity === 'casino') return 'night_club';
  if (tags.amenity === 'marketplace') return 'marketplace';

  // Tourism-based
  if (tags.tourism === 'hotel' || tags.tourism === 'motel') return 'hotel';
  if (tags.tourism === 'hostel') return 'hostel';
  if (tags.tourism === 'guest_house' || tags.tourism === 'bed_and_breakfast') return 'guest_house';
  if (tags.tourism === 'camp_site') return 'camping';
  if (tags.tourism === 'museum') return 'museum';

  // Leisure-based
  if (tags.leisure === 'fitness_centre' || tags.leisure === 'sports_centre' || tags.leisure === 'pitch' || tags.sport) return 'gym';
  if (tags.leisure === 'bowling_alley') return 'bowling';
  if (tags.leisure === 'yoga') return 'yoga';

  // Office-based
  if (tags.office === 'coworking' || tags.office === 'company') return 'coworking';

  // Shop-based (broader matching)
  if (tags.shop === 'beauty' || tags.shop === 'cosmetics') return 'beauty_salon';
  if (tags.shop === 'hairdresser' || tags.shop === 'wigs') return 'hair_salon';
  if (tags.shop === 'nail_salon') return 'nail_salon';
  if (tags.shop === 'tattoo' || tags.shop === 'piercing') return 'tattoo';
  if (tags.shop === 'supermarket' || tags.shop === 'supermarket;greengrocer') return 'supermarket';
  if (tags.shop === 'grocery' || tags.shop === 'greengrocer' || tags.shop === 'deli') return 'grocery';
  if (tags.shop === 'convenience' || tags.shop === 'kiosk' || tags.shop === 'newsagent') return 'convenience';
  if (tags.shop === 'clothes' || tags.shop === 'fashion' || tags.shop === 'shoes') return 'clothing';
  if (tags.shop === 'electronics' || tags.shop === 'mobile_phone' || tags.shop === 'computer' || tags.shop === 'hifi') return 'electronics';
  if (tags.shop === 'furniture' || tags.shop === 'interior_decoration') return 'furniture';
  if (tags.shop === 'doityourself' || tags.shop === 'trade' || tags.shop === 'hardware') return 'hardware';
  if (tags.shop === 'bakery' || tags.shop === 'pastry') return 'bakery';
  if (tags.shop === 'butcher') return 'butcher';
  if (tags.shop === 'florist') return 'florist';
  if (tags.shop === 'optician' || tags.shop === 'eyewear') return 'optician';
  if (tags.shop === 'car_repair' || tags.shop === 'car' || tags.shop === 'car_parts') return 'car_repair';
  if (tags.shop === 'laundry' || tags.shop === 'dry_cleaning') return 'laundry';
  if (tags.shop === 'pet_grooming' || tags.shop === 'pet') return 'pet_groomer';
  if (tags.shop === 'jewelry' || tags.shop === 'jewellery' || tags.shop === 'watches') return 'jewelry';
  if (tags.shop === 'shoes') return 'shoes';
  if (tags.shop === 'sports' || tags.shop === 'outdoor') return 'sports';
  if (tags.shop === 'books' || tags.shop === 'stationery') return 'books';
  if (tags.shop === 'department_store') return 'department_store';
  if (tags.shop === 'wine' || tags.shop === 'alcohol') return 'wine';
  if (tags.shop === 'art') return 'art';
  if (tags.shop === 'bicycle') return 'bicycle';

  // Cuisine fallback — if it has cuisine but wasn't caught above
  if (tags.cuisine) {
    if (tags.amenity) return tags.amenity as any;
    return 'restaurant';
  }

  return null;
}

function formatAddress(tags: Record<string, string>): string {
  const parts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city'], tags['addr:postcode']].filter(Boolean);
  return parts.join(', ') || tags.address || '';
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

/**
 * ONE broad Overpass query with extended tag coverage.
 * Gets all commercial POIs in a single request, categorize client-side.
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

  // Broad query — catch ALL commercial POIs
  const query = `[out:json][timeout:60];
(
  node(${south},${west},${north},${east})["amenity"];
  node(${south},${west},${north},${east})["shop"];
  node(${south},${west},${north},${east})["tourism"];
  node(${south},${west},${north},${east})["leisure"];
  node(${south},${west},${north},${east})["office"];
  node(${south},${west},${north},${east})["craft"];
  way(${south},${west},${north},${east})["amenity"];
  way(${south},${west},${north},${east})["shop"];
  way(${south},${west},${north},${east})["tourism"];
  way(${south},${west},${north},${east})["leisure"];
  way(${south},${west},${north},${east})["office"];
  way(${south},${west},${north},${east})["craft"];
);
out center body;`;

  onProgress?.(5, 'Downloading businesses from OpenStreetMap…');

  let data: any = null;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 55000);
      const res = await fetch(mirror, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        data = await res.json();
        break;
      }
    } catch {
      continue;
    }
  }

  onProgress?.(30, 'Categorizing businesses…');

  if (!data?.elements) return results;

  // Dedup by location (within ~5m) to avoid duplicates from overlapping tags
  const seenLocations = new Map<string, string>(); // "lat,lon" -> category

  for (const el of data.elements) {
    const elLat = el.lat || el.center?.lat;
    const elLon = el.lon || el.center?.lon;
    if (!elLat || !elLon) continue;

    const tags = el.tags || {};
    const category = categorizeBusiness(tags);
    if (!category) continue;

    // Dedup: if a node at nearly the same location already exists in the same category, skip
    const locKey = `${Math.round(elLat * 1000)},${Math.round(elLon * 1000)}`;
    const existingCat = seenLocations.get(locKey);
    if (existingCat === category) continue; // exact same location + category = duplicate
    seenLocations.set(locKey, category);

    // Get the best name — try multiple name variants
    const name = tags.name || tags['name:en'] || tags['name:int'] || tags['brand'] || '';

    // Google Maps link — use name + city for actual business profile
    const cityName = tags['addr:city'] || '';
    const gmapsQuery = name
      ? `${name} ${cityName || ''}`.trim()
      : `${elLat},${elLon}`;

    const business: Business = {
      id: `${el.type}/${el.id}`,
      name,
      lat: elLat,
      lon: elLon,
      category,
      categoryLabel: getCategoryLabel(category),
      address: formatAddress(tags),
      phone: tags.phone || tags['contact:phone'] || '',
      website: tags.website || tags['contact:website'] || '',
      email: tags.email || tags['contact:email'] || '',
      openingHours: tags.opening_hours || '',
      brand: tags.brand || '',
      cuisine: tags.cuisine || '',
      facebook: tags['contact:facebook'] || tags.facebook || '',
      instagram: tags['contact:instagram'] || tags.instagram || '',
      wikidata: tags.wikidata || '',
      wikipedia: tags.wikipedia || '',
    };

    if (!results.has(category)) results.set(category, []);
    results.get(category)!.push(business);
  }

  const totalBiz = Array.from(results.values()).reduce((s, a) => s + a.length, 0);
  onProgress?.(35, `Found ${totalBiz} businesses in ${results.size} categories`);
  return results;
}

// ─── Google Maps URL helper ────────────────────────────────────────

export function getGoogleMapsUrl(b: Business): string {
  // Search by business name for actual business profile (not random pin)
  if (b.name) {
    const query = `${b.name} ${b.address || ''}`.trim();
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }
  // Fallback to coordinates only if no name
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
  const median = per10kValues[Math.floor(per10kValues.length / 2)] || 1;

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
