/**
 * Blue Ocean Client Engine — fixed version
 * 
 * Strict categorization: only real named businesses with data.
 * Filters out unnamed POIs, sports pitches, playgrounds, etc.
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
};

const ALL_CATEGORIES = Object.keys(CATEGORY_QUERIES);

export function getCategoryLabel(id: string): string {
  return CATEGORY_QUERIES[id]?.label || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Strict Categorization ─────────────────────────────────────────
// Only categorize things that are clearly businesses with names.

function categorizeBusiness(tags: Record<string, string>): string | null {
  const a = tags.amenity;
  const s = tags.shop;
  const t = tags.tourism;
  const l = tags.leisure;
  const name = tags.name || tags['name:en'] || tags.brand || '';
  const hasName = name.length > 0;

  // ─── Shops (always businesses, always have shop tag) ───
  if (s === 'beauty' || s === 'cosmetics') return 'beauty_salon';
  if (s === 'hairdresser' || s === 'wigs') return 'hair_salon';
  if (s === 'nail_salon') return 'nail_salon';
  if (s === 'supermarket' || s === 'greengrocer' || s === 'deli') return 'supermarket';
  if (s === 'grocery' || s === 'health_food') return 'grocery';
  if (s === 'convenience' || s === 'kiosk' || s === 'newsagent') return 'convenience';
  if (s === 'clothes' || s === 'fashion' || s === 'boutique') return 'clothing';
  if (s === 'shoes' || s === 'shoe') return 'shoes';
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
  if (s === 'wine' || s === 'alcohol') return 'wine';
  if (s === 'art') return 'art';
  if (s === 'bicycle') return 'bicycle';
  if (s === 'fuel') return 'fuel';

  // ─── Amenity-based (require name for most) ───
  if (a === 'cafe' || (a === 'restaurant' && hasName)) return 'cafe';
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

  // ─── Tourism (require name) ───
  if (t === 'hotel' || t === 'motel' || t === 'apartment') return hasName ? 'hotel' : null;
  if (t === 'hostel') return hasName ? 'hostel' : null;

  // ─── Leisure (fitness and sports centers) ───
  if (l === 'fitness_centre' || l === 'sports_centre' || l === 'sports_hall' || l === 'swimming_pool') return hasName ? 'gym' : null;
  // Also check sport tag for fitness activities
  const sport = tags.sport || '';
  if ((l === 'pitch' || l === 'stadium' || l === 'track') && (sport === 'fitness' || sport === 'weight_lifting' || sport === 'gymnastics')) return hasName ? 'gym' : null;
  // DO NOT categorize: pitch, playground, stadium, track, etc. as gym unless sport tag is fitness-related

  // ─── Office ───
  if (tags.office === 'coworking' || tags.office === 'company') return hasName ? 'coworking' : null;

  return null;
}

// ─── Parsing Helpers ───────────────────────────────────────────────

function extractPhone(tags: Record<string, string>): string {
  return tags.phone || tags['contact:phone'] || tags['contact:mobile'] || 
         tags['phone:mobile'] || tags['phone:international'] || 
         tags['contact:landline'] || tags['contact:fax'] || '';
}

function extractEmail(tags: Record<string, string>): string {
  return tags.email || tags['contact:email'] || tags['email:office'] || 
         tags['contact:email:office'] || '';
}

function extractWebsite(tags: Record<string, string>): string {
  return tags.website || tags['contact:website'] || tags.url || 
         tags['contact:url'] || '';
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
];

async function fetchOverpass(query: string, timeoutSec = 60): Promise<any> {
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1000);
      const res = await fetch(mirror, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.trim().startsWith('{')) continue;
      const data = JSON.parse(text);
      if (data.elements === undefined) continue;
      return data;
    } catch { continue; }
  }
  return null;
}

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

  // Split queries to avoid Overpass timeouts — amenity only for business types
  const bbox = `${south},${west},${north},${east}`;
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Q1: Food & drink amenities (small query)
  const q1 = `[out:json][timeout:45];
(
  node(${bbox})["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream"];
  way(${bbox})["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream"];
);
out center body;`;

  // Q2: Healthcare & finance amenities
  const q2 = `[out:json][timeout:45];
(
  node(${bbox})["amenity"~"pharmacy|bank|hospital|clinic|dentist|veterinary"];
  way(${bbox})["amenity"~"pharmacy|bank|hospital|clinic|dentist|veterinary"];
);
out center body;`;

  // Q3: Other amenities (cinema, nightclub, car, library, school, etc.)
  const q3 = `[out:json][timeout:45];
(
  node(${bbox})["amenity"~"cinema|nightclub|car_rental|library|post_office|school"];
  way(${bbox})["amenity"~"cinema|nightclub|car_rental|library|post_office|school"];
);
out center body;`;

  // Q4: Shops
  const q4 = `[out:json][timeout:45];
(
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;

  // Q5: Tourism (hotels, hostels)
  const q5 = `[out:json][timeout:45];
(
  node(${bbox})["tourism"];
  way(${bbox})["tourism"];
);
out center body;`;

  // Q6: Leisure (gyms, fitness, sports)
  const q6 = `[out:json][timeout:45];
(
  node(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall"];
  way(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall"];
);
out center body;`;

  onProgress?.(10, 'Querying food & drink businesses…');
  const d1 = await fetchOverpass(q1);
  await wait(1500); // avoid rate limiting
  onProgress?.(15, 'Querying healthcare & finance…');
  const d2 = await fetchOverpass(q2);
  await wait(1500);
  onProgress?.(20, 'Querying entertainment & services…');
  const d3 = await fetchOverpass(q3);
  await wait(1500);
  onProgress?.(25, 'Querying shops & retail…');
  const d4 = await fetchOverpass(q4);
  await wait(1500);
  onProgress?.(30, 'Querying hotels & tourism…');
  const d5 = await fetchOverpass(q5);
  await wait(1500);
  onProgress?.(35, 'Querying gyms & fitness centers…');
  const d6 = await fetchOverpass(q6);

  // Merge all results
  const allElements: any[] = [];
  for (const d of [d1, d2, d3, d4, d5, d6]) {
    if (d?.elements) allElements.push(...d.elements);
  }
  
  const data = allElements.length > 0 ? { elements: allElements } : null;

  onProgress?.(50, 'Categorizing businesses…');

  if (!data || !data.elements || data.elements.length === 0) {
    onProgress?.(35, 'No businesses found from OSM');
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

    // Filter: must have a name to be a real business
    // Use multiple name sources including local languages
    const name = tags.name || tags['name:en'] || tags['name:int'] || tags.brand || tags['operator'] || '';
    if (!name.trim()) continue; // Skip unnamed POIs

    // Dedup by location + category
    const locKey = `${Math.round(elLat * 1000)},${Math.round(elLon * 1000)}`;
    const existingCat = seenLocations.get(locKey);
    if (existingCat === category) continue;
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
  onProgress?.(35, `Found ${totalBiz} named businesses in ${results.size} categories`);
  return results;
}

// ─── Google Maps URL ───────────────────────────────────────────────

export function getGoogleMapsUrl(b: Business): string {
  if (b.name) {
    const query = [b.name, b.address].filter(Boolean).join(' ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }
  // Fallback: search by coordinates
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

  const wikiP = fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(categoryLabel.replace(/ /g, '_'))}/monthly/20240101/20260101`,
    { headers: { 'User-Agent': 'BlueOcean/1.0' } }
  ).then(async r => {
    if (r.ok) { const d = await r.json(); const t = d.items?.reduce((s: number, i: any) => s + (i.views||0), 0)||0; signals.wikipedia = Math.min(100, Math.round(Math.log10(t+1)*16.7)); signals.sources.push('Wikipedia'); }
  }).catch(() => {});

  const redditP = fetch(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(`${categoryLabel} ${cityName}`)}&sort=new&t=month&limit=25`,
    { headers: { 'User-Agent': 'BlueOcean/1.0' } }
  ).then(async r => {
    if (r.ok) { const d = await r.json(); signals.reddit = Math.min(100, (d.data?.children?.length||0)*5); signals.sources.push('Reddit'); }
  }).catch(() => {});

  const ddgP = fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${categoryLabel}" "${cityName}"`)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then(async r => {
    if (r.ok) { const h = await r.text(); signals.webSearch = Math.min(100, (h.match(/class="result__snippet"/g)?.length||0)*10); signals.sources.push('Web Search'); }
  }).catch(() => {});

  await Promise.race([Promise.all([wikiP, redditP, ddgP]), new Promise(r => setTimeout(r, 8000))]);

  signals.score = Math.round(0.35*signals.webSearch + 0.30*signals.wikipedia + 0.25*signals.reddit + 0.10*Math.max(signals.webSearch, signals.wikipedia, signals.reddit));
  signals.confidence = Math.round(([signals.wikipedia, signals.reddit, signals.webSearch].filter(s => s > 0).length / 3) * 100);

  const p: string[] = [];
  if (signals.webSearch > 50) p.push('strong web presence');
  else if (signals.webSearch > 20) p.push('moderate web presence');
  if (signals.wikipedia > 30) p.push('active knowledge-seeking');
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
  const per10kValues: number[] = [];
  for (const [, bizs] of businesses) per10kValues.push((bizs.length / Math.max(population, 1)) * 10000);
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
    results.push({ category: cat, categoryLabel: getCategoryLabel(cat), existing, per10k: Math.round(per10k*100)/100, expected, gap, gapPct: Math.round(gapPct*100), score, demandBonus });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
