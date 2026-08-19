/**
 * Blue Ocean Client Engine
 * 
 * 100% client-side — runs in the browser, no backend needed.
 * Uses free public APIs:
 * - Nominatim (city resolution, boundaries)
 * - Overpass API (OpenStreetMap businesses) — ONE broad query
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

// ─── Single Overpass Query (fetch ALL amenities at once) ────────────

function categorizeBusiness(tags: Record<string, string>): string | null {
  if (tags.amenity === 'cafe') return 'cafe';
  if (tags.amenity === 'restaurant') return 'restaurant';
  if (tags.amenity === 'bar') return 'bar';
  if (tags.amenity === 'pub') return 'pub';
  if (tags.amenity === 'fast_food') return 'fast_food';
  if (tags.amenity === 'ice_cream') return 'ice_cream';
  if (tags.tourism === 'hotel') return 'hotel';
  if (tags.tourism === 'hostel') return 'hostel';
  if (tags.tourism === 'guest_house') return 'guest_house';
  if (tags.tourism === 'camp_site') return 'camping';
  if (tags.tourism === 'museum') return 'museum';
  if (tags.leisure === 'fitness_centre') return 'gym';
  if (tags.leisure === 'sports_centre') return 'gym';
  if (tags.leisure === 'bowling_alley') return 'bowling';
  if (tags.leisure === 'yoga') return 'yoga';
  if (tags.shop === 'beauty') return 'beauty_salon';
  if (tags.shop === 'hairdresser') return 'hair_salon';
  if (tags.shop === 'nail_salon') return 'nail_salon';
  if (tags.shop === 'tattoo') return 'tattoo';
  if (tags.shop === 'supermarket') return 'supermarket';
  if (tags.shop === 'grocery') return 'grocery';
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.shop === 'clothes') return 'clothing';
  if (tags.shop === 'electronics') return 'electronics';
  if (tags.shop === 'furniture') return 'furniture';
  if (tags.shop === 'doityourself') return 'hardware';
  if (tags.shop === 'bakery') return 'bakery';
  if (tags.shop === 'butcher') return 'butcher';
  if (tags.shop === 'florist') return 'florist';
  if (tags.shop === 'optician') return 'optician';
  if (tags.shop === 'car_repair') return 'car_repair';
  if (tags.shop === 'laundry') return 'laundry';
  if (tags.shop === 'pet_grooming') return 'pet_groomer';
  if (tags.shop === 'pet') return 'pet_shop';
  if (tags.shop === 'jewelry') return 'jewelry';
  if (tags.shop === 'shoes') return 'shoes';
  if (tags.shop === 'sports') return 'sports';
  if (tags.shop === 'books') return 'books';
  if (tags.shop === 'mobile_phone') return 'mobile_phone';
  if (tags.shop === 'department_store') return 'department_store';
  if (tags.shop === 'wine') return 'wine';
  if (tags.shop === 'art') return 'art';
  if (tags.shop === 'bicycle') return 'bicycle';
  if (tags.shop === 'stationery') return 'books';
  if (tags.shop === 'computer') return 'electronics';
  if (tags.amenity === 'pharmacy') return 'pharmacy';
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'clinic') return 'clinic';
  if (tags.amenity === 'dentist') return 'dentist';
  if (tags.amenity === 'bank') return 'bank';
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'kindergarten') return 'kindergarten';
  if (tags.amenity === 'cinema') return 'cinema';
  if (tags.amenity === 'theatre') return 'theater';
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.amenity === 'veterinary') return 'veterinary';
  if (tags.amenity === 'community_centre') return 'community_center';
  if (tags.amenity === 'library') return 'library';
  if (tags.amenity === 'post_office') return 'post_office';
  if (tags.amenity === 'car_rental') return 'car_rental';
  if (tags.amenity === 'nightclub') return 'night_club';
  if (tags.amenity === 'casino') return 'night_club';
  if (tags.amenity === 'marketplace') return 'marketplace';
  if (tags.office === 'coworking') return 'coworking';
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
 * ONE broad Overpass query — fetches all amenity/shop/tourism/leisure nodes and ways.
 * Then we categorize client-side. Much faster than many small queries.
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

  // ONE big query — get all commercial amenities + shops + tourism
  const query = `[out:json][timeout:60];
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

  for (const el of data.elements) {
    const elLat = el.lat || el.center?.lat;
    const elLon = el.lon || el.center?.lon;
    if (!elLat || !elLon) continue;

    const tags = el.tags || {};
    const category = categorizeBusiness(tags);
    if (!category) continue;

    const business: Business = {
      id: `${el.type}/${el.id}`,
      name: tags.name || tags['name:en'] || tags['name:local'] || '',
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
    };

    if (!results.has(category)) results.set(category, []);
    results.get(category)!.push(business);
  }

  onProgress?.(35, `Found ${Array.from(results.values()).reduce((s, a) => s + a.length, 0)} businesses in ${results.size} categories`);
  return results;
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
