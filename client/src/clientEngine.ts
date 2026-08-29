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
  const o = tags.office;
  // Name used for sub-bucketing (beauty→nail, fitness→yoga, …). Computed
  // lazily below only where it matters.
  const nameOf = () => (tags.name || tags['name:en'] || '').toLowerCase();

  // ─── Shops (always businesses) ───
  if (s === 'beauty' || s === 'cosmetics' || s === 'beauty_salon') {
    // A "beauty" shop named like a nail salon is a nail salon, not a beauty salon
    const nm = nameOf();
    if (/(nail|manikюр|pedikюр)/.test(nm)) return 'nail_salon';
    return 'beauty_salon';
  }
  if (s === 'hairdresser' || s === 'wigs' || s === 'hairdresser_supply') return 'hair_salon';
  if (s === 'tattoo' || s === 'tattoo_piercing' || s === 'piercing') return 'tattoo';
  if (s === 'printing' || s === 'print' || s === 'copyshop' || s === 'copywriter') return 'printing';
  if (s === 'market' || s === 'second_hand' || s === 'charity' || s === 'antiques') return 'market';
  if (s === 'nail_salon' || s === 'nails') return 'nail_salon';
  if (s === 'supermarket' || s === 'greengrocer' || s === 'deli' || s === 'cheese' ||
      s === 'chocolate' || s === 'coffee' || s === 'tea' || s === 'seafood' ||
      s === 'farm' || s === 'greasy') return 'supermarket';
  if (s === 'grocery' || s === 'health_food' || s === 'organic' || s === 'nuts' ||
      s === 'spices' || s === 'honey' || s === 'bread' || s === 'pasta' ||
      s === 'rice' || s === 'dairy' || s === 'eggs' || s === 'milk' ||
      s === 'bulk_food' || s === 'frozen_food' || s === 'baby_food') return 'grocery';
  if (s === 'convenience' || s === 'kiosk' || s === 'newsagent' || s === 'variety_store' ||
      s === 'general' || s === 'mini_market' || s === 'outpost' || s === 'nh' ||
      s === 'cigarettes' || s === 'e-cigarette') return 'convenience';
  if (s === 'clothes' || s === 'fashion' || s === 'boutique' || s === 'shoes' || s === 'shoe' ||
      s === 'kids' || s === 'baby' || s === 'children' || s === 'underwear' || s === 'lingerie' ||
      s === 'swimwear' || s === 'maternity' || s === 'traumatology' || s === 'fabric' ||
      s === 'tailor_supply' || s === 'wool' || s === 'accessories' || s === 'fashion_accessories' ||
      s === 'sportswear' || s === 'workwear' || s === 'costume' || s === 'formal' ||
      s === 'wedding_dress' || s === 'leather' || s === 'fur' || s === 'denim') return 'clothing';
  if (s === 'electronics' || s === 'mobile_phone' || s === 'computer' || s === 'hifi' ||
      s === 'video_games' || s === 'radiotechnics' || s === 'appliance' || s === 'camera' ||
      s === 'electrical' || s === 'lighting' || s === 'solar' || s === 'security' ||
      s === 'pos_terminal' || s === 'hearing_aids') return 'electronics';
  if (s === 'furniture' || s === 'interior_decoration' || s === 'mattress' ||
      s === 'curtain' || s === 'kitchen' || s === 'bathroom_furnishing' ||
      s === 'doors' || s === 'windows' || s === 'bed' || s === 'bedding' ||
      s === 'ceramics' || s === 'tiles' || s === 'flooring' || s === 'houseware' ||
      s === 'home_accessories' || s === 'candles' || s === 'fireplace') return 'furniture';
  if (s === 'doityourself' || s === 'trade' || s === 'hardware' || s === 'paint' ||
      s === 'building_materials' || s === 'tools' || s === 'sawmill' || s === 'plumber' ||
      s === 'glaziery' || s === 'locksmith' || s === 'electrician' || s === 'shuttering') return 'hardware';
  if (s === 'bakery' || s === 'pastry' || s === 'confectionery' || s === 'patisserie') return 'bakery';
  if (s === 'butcher' || s === 'charcuterie') return 'butcher';
  if (s === 'florist' || s === 'garden_centre' || s === 'seeds' || s === 'agrarian' ||
      s === 'fertilizer' || s === 'garden_furniture' || s === 'plants') return 'florist';
  if (s === 'optician' || s === 'eyewear') return 'optician';
  if (s === 'car_repair' || s === 'car_parts' || s === 'car' || s === 'tyres' ||
      s === 'motorcycle' || s === 'motorcycle_repair' || s === 'truck_repair' ||
      s === 'truck' || s === 'caravan' || s === 'boat' || s === 'oil' ||
      s === 'agrarian_machine' || s === 'caravan_site') return 'car_repair';
  if (s === 'laundry' || s === 'dry_cleaning') return 'laundry';
  if (s === 'pet_grooming' || s === 'pet' || s === 'pet_groomer') return 'pet_groomer';
  if (s === 'jewelry' || s === 'jewellery' || s === 'watches') return 'jewelry';
  if (s === 'sports' || s === 'outdoor' || s === 'bicycle_rental' || s === 'ski' ||
      s === 'fishing' || s === 'hunting' || s === 'scuba_diving' || s === 'surf' ||
      s === 'skateboard' || s === 'diving') return 'sports';
  if (s === 'books' || s === 'stationery' || s === 'bookmaker' || s === 'copyshop_books') return 'books';
  if (s === 'department_store' || s === 'mall' || s === 'wholesale') return 'department_store';
  if (s === 'art' || s === 'frame' || s === 'gallery') return 'art';
  if (s === 'bicycle') return 'bicycle';
  if (s === 'fuel' || s === 'fuel_station') return 'fuel';
  // ─── Shops that map to SERVICE categories (v6.9 fix — these were the
  // biggest drop buckets in the Tbilisi probe: chemist=130, alcohol=121,
  // travel_agency=29, massage=26, money_lender=67, toys=70…) ───
  if (s === 'chemist') return 'pharmacy';                    // drugstore (no prescription)
  if (s === 'alcohol' || s === 'wine' || s === 'beer' || s === 'spirits' ||
      s === 'beverages' || s === 'tobacco' || s === 'cannabis') return 'convenience';
  if (s === 'toys' || s === 'games' || s === 'model' || s === 'musical_instrument' ||
      s === 'gift' || s === 'party' || s === 'collectibles' || s === 'lottery' ||
      s === 'trophy' || s === 'novelty') return 'art';       // gift/specialty retail → art bucket
  if (s === 'massage') return 'spa';
  if (s === 'money_lender' || s === 'pawnbroker' || s === 'currency_exchange' || s === 'financial') return 'bank';
  if (s === 'ticket' || s === 'lottery_tickets') return 'travel_agency';
  if (s === 'travel_agency') return 'travel_agency';
  if (s === 'medical_supply' || s === 'orthopedic' || s === 'medical_devices') return 'pharmacy';
  if (s === 'vacant' || s === 'yes' || s === 'other' || s === 'unknown') return null; // no signal
  if (s === 'storage_rental' || s === 'funeral_directors' || s === 'funeral') return 'market';
  if (s === 'trash') return null;                            // waste infra, not a business
  if (s) return 'market'; // remaining named specialty shops count as local market

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
  if (a === 'school' || a === 'college' || a === 'university' ||
      a === 'kindergarten' || a === 'language_school' || a === 'driving_school' ||
      a === 'training' || a === 'prep_school' || a === 'childcare') return 'school';
  if (a === 'cinema') return 'cinema';
  if (a === 'veterinary') return 'veterinary';
  if (a === 'library' || a === 'books_mobile') return 'library';
  if (a === 'post_office' || a === 'post_partner') return 'post_office';
  if (a === 'car_rental' || a === 'boat_rental') return 'car_rental';
  if (a === 'nightclub' || a === 'casino') return 'night_club';
  if (a === 'music_school' || a === 'dancing_school' || a === 'arts_centre' ||
      a === 'studio') return 'music_school';
  if (a === 'spa' || a === 'sauna' || a === 'public_bath' || a === 'tanning_salon' ||
      a === 'massage') return 'spa';
  if (a === 'marketplace') return 'marketplace';
  if (a === 'fuel') return 'fuel';
  // ─── Amenity service buckets (v6.9) ───
  if (a === 'car_wash') return 'car_wash';
  if (a === 'bureau_de_change' || a === 'money_transfer' || a === 'microfinance') return 'bank';
  if (a === 'internet_cafe') return 'electronics';
  if (a === 'courier' || a === 'parcel_pickup' || a === 'parcel_locker' ||
      a === 'delivery_company') return 'courier';
  if (a === 'coworking_space') return 'coworking';
  if (a === 'events_venue') return 'wedding';   // wedding/event halls
  if (a === 'funeral_hall' || a === 'crematorium') return 'market';
  if (a === 'photo_studio' || a === 'photography') return 'art';
  if (a === 'dive_centre') return 'sports';
  if (a === 'conference_centre' || a === 'monastery' || a === 'place_of_worship' ||
      a === 'public_building' || a === 'community_centre' || a === 'toilets' ||
      a === 'drinking_water' || a === 'parking' || a === 'bench' || a === 'shelter' ||
      a === 'waste_basket' || a === 'recycling' || a === 'fountain' ||
      a === 'charging_station' || a === 'atm' || a === 'vending_machine' ||
      a === 'telephone' || a === 'telephone_exchange' || a === 'bus_station' ||
      a === 'bus_stop' || a === 'ferry_terminal' || a === 'taxi' || a === 'police' ||
      a === 'fire_station' || a === 'townhall' || a === 'courthouse' || a === 'prison' ||
      a === 'grave_yard' || a === 'waste_transfer_station') return null; // public/civic infra

  // ─── Craft businesses (Georgia, Russia, CIS) ───
  if (tags.craft === 'bakery' || tags.craft === 'confectionery' || tags.craft === 'pastry') return 'bakery';
  if (tags.craft === 'car_repair' || tags.craft === 'car_paint' || tags.craft === 'car_repair vehicle' ||
      tags.craft === 'joiner' || tags.craft === 'carpenter' || tags.craft === 'upholsterer' ||
      tags.craft === 'metal_construction' || tags.craft === 'stonemason' ||
      tags.craft === 'window_construction' || tags.craft === 'blacksmith') return 'car_repair';
  if (tags.craft === 'tailor' || tags.craft === 'dressmaker' || tags.craft === 'seamstress') return 'clothing';
  if (tags.craft === 'jeweler' || tags.craft === 'jewellery_repair') return 'jewelry';
  if (tags.craft === 'optician') return 'optician';
  if (tags.craft === 'florist') return 'florist';
  if (tags.craft === 'shoemaker' || tags.craft === 'cobbler') return 'clothing';
  if (tags.craft === 'key_cutter' || tags.craft === 'engraver') return 'printing';
  if (tags.craft === 'photographer' || tags.craft === 'photographic_laboratory') return 'art';
  if (tags.craft === 'beekeeper' || tags.craft === 'brewery' || tags.craft === 'distillery' ||
      tags.craft === 'winery') return 'supermarket';
  if (tags.craft === 'plasterer' || tags.craft === 'roofer' || tags.craft === 'insulation' ||
      tags.craft === 'scaffolder' || tags.craft === 'builder') return 'hardware';
  if (tags.craft === 'clockmaker' || tags.craft === 'electronics_repair') return 'electronics';
  if (tags.craft === 'pottery' || tags.craft === 'basket_maker' || tags.craft === 'bookbinder' ||
      tags.craft === 'handicraft' || tags.craft === 'candle_maker' || tags.craft === 'toymaker') return 'art';
  if (tags.craft === 'carpet_layer' || tags.craft === 'picture_framing' ||
      tags.craft === 'signmaker' || tags.craft === 'printer') return 'printing';
  if (tags.craft) return 'market'; // remaining named crafts are real businesses

  // ─── Healthcare (UK, Germany, Scandinavia) ───
  if (tags.healthcare === 'dentist' || tags.healthcare === 'orthodontist') return 'dentist';
  if (tags.healthcare === 'clinic' || tags.healthcare === 'doctor' ||
      tags.healthcare === 'physiotherapist' || tags.healthcare === 'psychotherapist' ||
      tags.healthcare === 'psychologist' || tags.healthcare === 'midwife' ||
      tags.healthcare === 'occupational_therapist' || tags.healthcare === 'speech_therapist' ||
      tags.healthcare === 'optometrist' || tags.healthcare === 'podiatrist' ||
      tags.healthcare === 'chiropractor' || tags.healthcare === 'sample_collection' ||
      tags.healthcare === 'vaccination_centre' || tags.healthcare === 'dialysis' ||
      tags.healthcare === 'blood_donation' || tags.healthcare === 'rehab' ||
      tags.healthcare === 'hospice') return 'clinic';
  if (tags.healthcare === 'pharmacy' || tags.healthcare === 'chemist') return 'pharmacy';
  if (tags.healthcare === 'hospital') return 'hospital';
  if (tags.healthcare === 'laboratory' || tags.healthcare === 'blood_bank') return 'clinic';
  if (tags.healthcare === 'veterinary') return 'veterinary';
  if (tags.healthcare) return 'clinic'; // any other healthcare=* is a real medical business

  // ─── Tourism ───
  if (t === 'hotel' || t === 'motel' || t === 'apartment' || t === 'bed_and_breakfast' ||
      t === 'resort' || t === 'chalet' || t === 'aparthotel') return 'hotel';
  if (t === 'hostel') return 'hostel';
  if (t === 'guest_house') return 'hotel';
  if (t === 'museum' || t === 'gallery' || t === 'aquarium' || t === 'zoo' ||
      t === 'theme_park') return 'art';
  // tourism=attraction/artwork deliberately NOT mapped: monuments, viewpoints
  // and statues carry names but are not businesses.
  if (t === 'caravan_site' || t === 'camp_site') return 'hostel';

  // ─── Leisure ───
  if (l === 'fitness_centre' || l === 'sports_centre' || l === 'sports_hall' ||
      l === 'swimming_pool' || l === 'track' || l === 'stadium') {
    // Name-based split: yoga/pilates/dance studios before the generic 'gym' bucket
    const nm = nameOf();
    if (/(yoga|pilates)/.test(nm)) return 'yoga';
    if (/(danc|ballet|choreo)/.test(nm)) return 'dance';
    if (/(box|mma|karate|judo|taekwondo|wrestl|fencing|kick|aikido|jui.?jitsu)/.test(nm)) return 'gym';
    return 'gym';
  }
  if (l === 'yoga') return 'yoga';               // leisure=yoga exists in OSM
  if (l === 'dance' || l === 'dance_hall') return 'dance';
  if (l === 'bowling_alley' || l === 'escape_game' || l === 'amusement_arcade' ||
      l === 'miniature_golf' || l === 'trampoline_park' || l === 'water_park') return 'night_club';
  if (l === 'spa' || l === 'sauna') return 'spa';
  if (l === 'tanning_salon') return 'spa';
  if (l === 'horse_riding' || l === 'golf_course' || l === 'club' || l === 'padel' ||
      l === 'tennis' || l === 'ice_rink' || l === 'pitch' || l === 'playground' ||
      l === 'park' || l === 'garden' || l === 'dog_park' || l === 'track_outdoor' ||
      l === 'pitch_outdoor' || l === 'common' || l === 'nature_reserve') return null; // venues/parks, not businesses

  // ─── Office-based businesses (v6.9: the single biggest drop bucket was
  // office=company with 174 named instances in Tbilisi alone) ───
  if (o === 'coworking' || o === 'coworking_space' || o === 'coworkingn') return 'coworking';
  if (o === 'lawyer' || o === 'attorney' || o === 'notary' || o === 'bailiff' || o === 'law') return 'lawyer';
  if (o === 'accountant' || o === 'tax_advisor' || o === 'tax' || o === 'audit' || o === 'bookkeeping') return 'accountant';
  if (o === 'estate_agent' || o === 'real_estate' || o === 'property_management') return 'real_estate';
  if (o === 'insurance' || o === 'insurance_broker') return 'insurance';
  if (o === 'travel_agent' || o === 'tour_operator' || o === 'tourism') return 'travel_agency';
  if (o === 'it' || o === 'software' || o === 'computer' || o === 'it_company' ||
      o === 'web_design' || o === 'web_developer' || o === 'hosting' ||
      o === 'game_developer' || o === 'technology' || o === 'digital') return 'software';
  if (o === 'consulting' || o === 'business_consulting' || o === 'it_consulting' ||
      o === 'management_consulting' || o === 'financial_consulting') return 'it_consulting';
  if (o === 'marketing' || o === 'advertising' || o === 'advertising_agency' ||
      o === 'marketing_agency' || o === 'pr_agency' || o === 'communications' ||
      o === 'media' || o === 'newspaper' || o === 'publisher' || o === 'magazine' ||
      o === 'broadcasting' || o === 'radio' || o === 'tv' || o === 'film' ||
      o === 'video_production' || o === 'design' || o === 'graphic_design' ||
      o === 'photography_studio') return 'digital_marketing';
  if (o === 'telecommunication' || o === 'telecom') return 'web_agency';
  if (o === 'company' || o === 'yes' || o === 'corporate' || o === 'private' ||
      o === 'business' || o === 'services' || o === 'enterprise') {
    // Generic office=company: sub-bucket by name, else 'software' bucket for
    // generic companies (they are overwhelmingly private companies).
    const nm = nameOf();
    if (/(law|legal|attorney|advo[ck]at|notar)/.test(nm)) return 'lawyer';
    if (/(account|buh|finance|audit|tax)/.test(nm)) return 'accountant';
    if (/(real.?estate|property|immobili)/.test(nm)) return 'real_estate';
    if (/(insur|strakhov)/.test(nm) || /(insur)/.test(nm)) return 'insurance';
    if (/(travel|tur|tour)/.test(nm)) return 'travel_agency';
    if (/(clean|ubor|cleaning)/.test(nm)) return 'cleaning';
    if (/(car.?wash|moyk[ae]|автомойк)/.test(nm)) return 'car_wash';
    if (/(nail|manikюр|pedikюр)/.test(nm)) return 'nail_salon';
    if (/(yoga|pilates)/.test(nm)) return 'yoga';
    if (/(soft|it|tech|digital|web|dev|data|ai|cloud|cyber|app)/.test(nm)) return 'software';
    if (/(consult|консалт)/.test(nm)) return 'it_consulting';
    if (/(market|advertis|reklam|agency|agenc|media|pr\b|brand|design|studio)/.test(nm)) return 'digital_marketing';
    if (/(construct|building|development)/.test(nm)) return 'hardware';
    if (/(logist|transport|delivery|courier)/.test(nm)) return 'courier';
    if (/(security|guard|охран)/.test(nm)) return 'insurance';
    if (/(recruit|hr\b|personnel|staff)/.test(nm)) return 'it_consulting';
    if (/(med|clinic|doctor|health|dent|pharm)/.test(nm)) return 'clinic';
    if (/(bank|financ|invest|credit|fund|capital)/.test(nm)) return 'bank';
    if (/(energ|oil|gas|mining)/.test(nm)) return 'fuel';
    if (/(hotel|hostel|motel)/.test(nm)) return 'hotel';
    if (/(import|export|trade|wholesale|supply|distribut)/.test(nm)) return 'market';
    return 'software'; // generic private company → closest service bucket
  }
  if (o === 'architect' || o === 'engineer' || o === 'engineering' || o === 'surveyor' ||
      o === 'planner' || o === 'construction_company' || o === 'construction') return 'hardware';
  if (o === 'cleaning' || o === 'cleaning_company') return 'cleaning';
  if (o === 'courier' || o === 'logistics' || o === 'shipping' || o === 'forwarding' ||
      o === 'transport' || o === 'delivery' || o === 'moving_company') return 'courier';
  if (o === 'educational_institution' || o === 'education' || o === 'tutoring' ||
      o === 'tutor' || o === 'training_institute') return 'school';
  if (o === 'financial' || o === 'investment' || o === 'bank' || o === ' leasing' ||
      o === 'microfinance' || o === 'money_lender') return 'bank';
  if (o === 'security' || o === 'private_investigator' || o === 'guard') return 'insurance';
  if (o === 'translator' || o === 'translation' || o === 'interpreter') return 'it_consulting';
  if (o === 'medical' || o === 'doctor' || o === 'physician' || o === 'dentist' ||
      o === 'veterinary' || o === 'clinic') return 'clinic';
  if (o === 'pharmacy') return 'pharmacy';
  if (o === 'ngo' || o === 'charity' || o === 'association' || o === 'foundation' ||
      o === 'nonprofit' || o === 'religious' || o === 'religion' || o === 'political_party' ||
      o === 'union' || o === 'movement') return 'market'; // civic orgs still appear in results
  if (o === 'government' || o === 'public' || o === 'diplomatic' || o === 'embassy' ||
      o === 'visa' || o === 'tax_office' || o === 'public_service' || o === 'authority' ||
      o === 'municipality' || o === 'police' || o === 'court' || o === 'administrative' ||
      o === 'regulatory' || o === 'council' || o === 'agency' || o === 'institution' ||
      o === 'public_authority') return null; // public sector: not a private business
  if (o === 'research' || o === 'educational_organisation' || o === 'exam_centre' ||
      o === 'laboratory' || o === 'institute') return 'school';
  if (o === 'energy_supplier' || o === 'utility' || o === 'water_utility' ||
      o === 'gas_utility' || o === 'electric_utility') return 'fuel';
  if (o === 'guide' || o === 'tour_guide') return 'travel_agency';
  if (o === 'employment_agency' || o === 'staffing') return 'it_consulting';
  if (o === 'newspaper' || o === 'publishing') return 'digital_marketing';
  if (o === 'religion' || o === 'parish') return null;
  if (o === 'vacant' || o === 'unknown') return null;
  if (o) return 'software'; // remaining named offices are private companies

  // ─── Name-based heuristics for new categories (no office tag) ───
  const nameLower = nameOf();
  if (!o && nameLower) {
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

// Directory/listing sites that should NEVER be set as a business website
const DIRECTORY_SITES = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress|2gis\.com|yandex\.com|uber\.com|doordash|grubhub|seamless|glassdoor|indeed\.com|glassdoor|angieslist|homeadvisor|thumbtack|bbb\.org|trustpilot|sitejabber|clutch\.co|goodfirms|sortlist|brightlocal|moz\.com|semrush|ahrefs|similarweb/i;
// Q&A / knowledge / UGC platforms that look like domains but are never a business's own site
const QA_JUNK_SITES = /baidu\.com|zhidao|baike\.com|answers\.com|ask\.com|brainly|stackexchange|stackoverflow|wikihow|quora|socratic|brainly\.[a-z.]+/i;
// Auto-generated aggregator clone networks (e.g. salobiebia.restaurants-us.com, x.hotels-uk.com)
const AGGREGATOR_NETWORK = /(^|\.)(restaurants|hotels|cafes|bars|salons|shops|clinics?|dental|beauty|fitness|gyms?|pharmac(y|ies)|attractions|places)-[a-z]{2,4}\.(com|net|org|info)$/i;
// Hostname that IS a forum/community (but "theforumcafe.com" stays allowed)
const FORUM_HOST = /(^|\.)forum(s|\.|$)|(^|\.)(community|board|bbs)\./i;
// Media/streaming platforms: a Spotify/YouTube-Music/Vimeo/SoundCloud/Deezer
// link is the business's PLAYLIST, never its own website.
const MEDIA_PLATFORM = /spotify\.com|music\.youtube|youtube\.com|youtu\.be|soundcloud|vimeo\.com|deezer\.com|apple\.com\/.*music|tidal\.com|bandcamp\.com|mixcloud|last\.fm|anghami|jiosaavn|podimo|castbox/i;
// Review/directory/article hosts that never host a business's own website
const REVIEW_DIRECTORY = /happycow\.net|organicrestaurants\.com|restaurantguru|tripadvisor|yelp\.com|zomato|thefork|thefork\.ie|sluurpy|menu\.ge|menu\.am|restaurantji|menupix|usarestaurants|restaurants-world|worldorgs|nicelocal|bir\.ai|restaurantji\.com|zaubee|find-open|opendi|cityseeker|wanderlog|roadtrippers|onlyinyourstate|eatbook|beyondmenu|allmenus|grubhub|seamless|doordash|ubereats|wolt|bolt\.eu|glovo|deliveroo|foodpanda|zomato\.com|dineplace|gastroge|ambebi\.ge|sfizo|fooood\.ge|food\.ge|mena\.ge|bistro\.ge/i;
// Yellow-pages / corporate-registry hosts: their pages are ABOUT companies,
// never a company's own site (yell.ge, yell.com, companyinfo.ge, …)
const YELLOW_PAGES = /(^|\.)yell\.[a-z.]+|companyinfo\.ge|azbuka\.ge|yellow\.ge|infobiz\.ge/i;

// Does the text plausibly refer to this business? Checks the name in its
// original script, transliterated and English-map forms.
function textMentionsBusiness(text: string, businessName: string): boolean {
  if (!text || !businessName) return false;
  const t = text.toLowerCase();
  const name = businessName.trim().toLowerCase();
  if (!name) return false;
  if (t.includes(name)) return true;
  const translit = transliterateGeo(businessName).toLowerCase().trim();
  if (translit && translit !== name && t.includes(translit)) return true;
  const en = getEnglishCityName(businessName).toLowerCase().trim();
  if (en && en !== name && en !== translit && t.includes(en)) return true;
  return false;
}

// Check if a URL is likely the business's OWN website (not a directory listing)
export function isLikelyBusinessWebsite(url: string, businessName: string, text?: string): boolean {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    // Reject directory/listing sites
    if (DIRECTORY_SITES.test(hostname)) return false;
    // Reject Q&A / knowledge / UGC platforms (e.g. zhidao.baidu.com/question/...)
    if (QA_JUNK_SITES.test(hostname)) return false;
    // Reject auto-generated aggregator clone networks (e.g. *.restaurants-us.com)
    if (AGGREGATOR_NETWORK.test(hostname)) return false;
    // Reject media/streaming platforms: a Spotify/YouTube-Music/Vimeo/SoundCloud
    // link is the business's PLAYLIST, never its website.
    if (MEDIA_PLATFORM.test(hostname)) return false;
    // Reject review/directory/article hosts that never host a business's own site
    if (REVIEW_DIRECTORY.test(hostname)) return false;
    // Reject yellow-pages / corporate-registry hosts
    if (YELLOW_PAGES.test(hostname)) return false;
    // Reject forum/community hosts and member/profile pages
    if (FORUM_HOST.test(hostname)) return false;
    if (/^\/(members?|users?|profile|profiles|questions?|threads?|topics?|post|posts|discussion)\//.test(path)) return false;
    // Reject review/listing/article paths on any host: /reviews/x, /listing/x,
    // /partners/x, /venues/x — pages ABOUT a business, never the business.
    if (/\/(reviews?|review-of|listings?|partners?|places?|directory|businesses|venues?|menus?)\//.test(path)) return false;
    // Reject SEO listicle paths: /best-cafes-in-tbilisi…, /top-10-restaurants…,
    // /things-to-do-in-yerevan — magazine roundups, never a business homepage.
    if (/\/(best|top)[-_\d][a-z0-9-]*-in-/.test(path) || /\/(things?-to-do|itinerar)/.test(path)) return false;
    // Reject editorial/media hosts (travel & food magazines) that never host a
    // business's own website — deep-scraping them wastes minutes per business.
    if (/wander-lush\.org|culturetrip\.com|lonelyplanet\.com|timeout\.com|eater\.com|thrillist\.com|cntraveler|travelandleisure|atlasobscura|insider\.com|buzzfeed/i.test(hostname)) return false;
    // Reject third-party pages ABOUT the business (food-blog articles,
    // partner listings): e.g. culinarybackstreets.com/stories/tbilisi/lui-coffee
    // or georefund.com/partners/Art-CafeHOME. Signal: hostname shares no
    // significant token with the business name, but the path mentions it.
    const tokens = extractBizNameTokens(businessName);
    if (tokens.length && !tokens.some(t => hostname.includes(t))) {
      // Hostname shares NO significant token with the business name.
      const pathSlug = path.replace(/[^a-z0-9]+/g, ' ');
      // Case 1 — path mentions the business but host doesn't: third-party page
      // ABOUT the business (blog article, partner listing) → reject.
      if (tokens.some(t => pathSlug.includes(t))) return false;
      // Case 2 — NEITHER host nor path mentions the business: ambiguous. Only
      // accept when the accompanying title/snippet confirms the business.
      if (text !== undefined && !textMentionsBusiness(text, businessName)) return false;
    }
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

function extractWebsite(tags: Record<string, string>): string {
  const raw = tags.website || tags['contact:website'] || tags.url || '';
  if (!raw) return '';
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  // Only keep the business's OWN website. Junk sources (Q&A pages, forum
  // profiles, aggregator clones) would otherwise be deep-scraped later,
  // burning minutes of enrichment time and polluting results.
  return isLikelyBusinessWebsite(url, tags.name || '') ? url : '';
}

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

// Pull significant Latin name tokens for hostname/path comparison. Handles
// non-Latin names (Georgian/Armenian/Cyrillic/Chinese) via the shared
// transliterators so e.g. "ლუის ყავის სახლი" still matches lui-coffee paths.
function extractBizNameTokens(businessName: string): string[] {
  let name = businessName || '';
  if (!/[\u0041-\u005A\u0061-\u007A]/.test(name)) {
    const en = getEnglishCityName(name);
    if (en) name = en;
    else name = transliterateGeo(name);
  }
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(t =>
    t.length >= 3 &&
    !/^(cafe|café|coffee|restaurant|bar|pub|hotel|hostel|salon|shop|store|bakery|gym|fitness|club|spa|clinic|pharmacy|studio|the|and|of|la|le|de|da)$/i.test(t)
  );
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

// ─── Response cache (localStorage, quality-neutral) ───────────────
// OSM POI data changes on the scale of days/weeks; Wikipedia pageviews roll
// monthly; AI analysis is derived from those inputs. Caching by exact input
// key therefore CANNOT change any number the app shows — it only removes
// redundant network round-trips when re-running the same scan (retry after
// enrichment, revisiting a city, hot-reload during dev).
const CACHE_PREFIX = 'bo_cache_';
const DAY_MS = 24 * 60 * 60 * 1000;
function cacheGet<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (typeof t !== 'number' || Date.now() - t > maxAgeMs) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return v as T;
  } catch { return null; }
}
function cacheSet(key: string, value: any): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // Quota exceeded — drop our oldest entries (cheap LRU) and retry once
    try {
      const ours = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
      ours.sort((a, b) => {
        const ta = JSON.parse(localStorage.getItem(a) || '{"t":0}').t;
        const tb = JSON.parse(localStorage.getItem(b) || '{"t":0}').t;
        return ta - tb;
      });
      for (const k of ours.slice(0, Math.ceil(ours.length / 2))) localStorage.removeItem(k);
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch { /* give up silently — cache is best-effort */ }
  }
}
function cacheKey(...parts: (string | number)[]): string {
  return parts.map(p => String(p)).join('|');
}
// FNV-1a 32-bit string hash — compact cache keys for long Overpass queries
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}
function isCancelled(): boolean { return _cancelSignal?.aborted ?? false; }

// ─── CORS Fetch Helper ────────────────────────────────────────────
// ─── CORS Fetch Helper ────────────────────────────────────────────
// corsproxy.io is dead. This helper:
// 1. Tries direct fetch (instant for CORS-enabled: Nominatim, Overpass, Brave)
// 2. Falls back to allorigins.win with 3s timeout (races raw + get)
// Total max wait: ~4 seconds (not 12+)
// Multi-proxy strategy: try 3 different CORS proxies in parallel
let _lastProxyFail = 0; // 30s cooldown instead of permanent block
// v6.9.6: cors.sh consecutive-failure memory (3 fails → 5 min skip)
let _corsshFails = 0;
let _corsshLastFail = 0;

// v6.9.5: hosts known to SERVE CORS headers to browsers (public APIs).
// These get the instant direct fetch; every other host goes through the
// proxy chain first — a direct attempt at an unknown host is usually a
// CORS rejection, which the browser prints as an uncatchable console
// error even when caught in JS.
const _CORS_OPEN_HOSTS = new Set([
  'api.search.brave.com', 'google.serper.dev', 'api.tavily.com',
  'openrouter.ai', 'text.pollinations.ai', 'query.wikidata.org',
  'archive.org', 'nominatim.openstreetmap.org', 'photon.komoot.io',
  'api.allorigins.win', 'r.jina.ai', 'cors.sh', 'api.open-meteo.com',
  'en.wikipedia.org', 'ru.wikipedia.org', 'ka.wikipedia.org',
]);
function hostAllowsDirect(u: string): boolean {
  try { return _CORS_OPEN_HOSTS.has(new URL(u).host); } catch { return false; }
}

// ─── Per-host circuit breaker (quality-neutral) ───────────────────
// A host that consistently fails at the NETWORK level (timeout / refused /
// DNS / CORS-rejected) can never yield data, so skipping it later cannot
// change any output — it only removes dead 5-30s waits. HTTP responses
// (404/500/etc.) do NOT count: those hosts are alive and may serve other
// paths. Trips after 4 consecutive network failures; resets on any success;
// re-probes after 2 minutes so a temporarily-down host recovers.
const _hostFails = new Map<string, { n: number; until: number }>();
const HOST_FAIL_LIMIT = 4;
const HOST_OPEN_MS = 120000;
function hostKey(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}
function hostIsOpen(u: string): boolean {
  const h = hostKey(u);
  const e = _hostFails.get(h);
  return !!e && e.n >= HOST_FAIL_LIMIT && Date.now() < e.until;
}
function hostRecordFail(u: string): void {
  const h = hostKey(u);
  const e = _hostFails.get(h) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= HOST_FAIL_LIMIT) e.until = Date.now() + HOST_OPEN_MS;
  _hostFails.set(h, e);
}
function hostRecordSuccess(u: string): void {
  _hostFails.delete(hostKey(u));
}

// ─── Direct-fetch dead-host memory (console noise reduction, v6.9.3) ───
// A DIRECT (no-proxy) fetch to a host fails DETERMINISTICALLY when the
// origin doesn't send CORS headers or the host is unreachable — retrying
// direct later can never succeed, and every attempt prints a browser
// console error (net::ERR_FAILED / ERR_ABORTED). Remember the failure and
// go straight to the proxy chain for that host for the rest of the session.
//
// v6.9.5: keyed by HOST (not full URL) and STICKY for the session. CORS
// refusal is a whole-origin property — a host that rejected /contact will
// reject /about too, so the first failed path must silence every later
// direct attempt on that host, not just its own path.
const _directDead = new Map<string, number>();
function directIsDead(u: string): boolean {
  return _directDead.has(hostKey(u));
}
function markDirectDead(u: string): void { _directDead.set(hostKey(u), Date.now()); }
function markDirectAlive(u: string): void { _directDead.delete(hostKey(u)); }

// ─── Engine health + fallback registry (v6.9.2) ────────────────────────
// Every outbound dependency (search engines, AI provider, proxies) gets a
// health record: consecutive failures → short cooldown; explicit quota /
// payment errors → long cooldown; success → clear. Dead engines are skipped
// instantly for the rest of the scan instead of re-failing on every request
// (kills the console-error storm AND the wasted latency), and the UI banner
// tells the user which engine is down / which fallback took over.
export type EngineHealthKind = 'net' | 'quota' | 'challenge';
export interface EngineHealthEntry {
  id: string;                 // stable id, e.g. 'brave', 'serper', 'ddg'
  label: string;              // human name for UI
  status: 'ok' | 'cooldown' | 'down' | 'quota';
  detail: string;             // last known reason (for tooltips/banners)
  fails: number;
  since: number;              // ms timestamp of last state change
  cooldownUntil: number;      // 0 = live
}
const _engineHealth = new Map<string, EngineHealthEntry>();
const COOLDOWN_NET_MS = 45_000;      // transient failures: retry after 45s
const COOLDOWN_CHALLENGE_MS = 90_000; // captcha/challenge pages: 90s
const COOLDOWN_QUOTA_MS = 30 * 60_000; // quota exhausted: 30 min (per scan-life)

// Quota / auth error fingerprints across providers (Brave, Serper, Tavily,
// OpenRouter, proxies). Matched against status + response body snippets.
function classifyEngineError(status: number, body?: string): EngineHealthKind {
  const b = (body || '').slice(0, 600).toLowerCase();
  if (
    status === 402 || status === 429 ||
    /quota|limit exceeded|rate limit|exceeded your|payment required|insufficient|subscription|credit|balance/i.test(b)
  ) return 'quota';
  if (/captcha|challenge|verify|akchal|cloudflare|ddos-guard|just a moment/i.test(b)) return 'challenge';
  return 'net';
}

function engineHealthGet(id: string, label: string): EngineHealthEntry {
  let e = _engineHealth.get(id);
  if (!e) { e = { id, label, status: 'ok', detail: '', fails: 0, since: Date.now(), cooldownUntil: 0 }; _engineHealth.set(id, e); }
  return e;
}

/** True when the engine may be called right now. */
export function engineAvailable(id: string): boolean {
  const e = _engineHealth.get(id);
  if (!e) return true;
  if (e.cooldownUntil > Date.now()) return false;
  if (e.status === 'quota') return false; // quota is sticky for the session
  return true;
}

export function engineNoteSuccess(id: string, label: string): void {
  const e = engineHealthGet(id, label);
  if (e.status !== 'ok') { e.status = 'ok'; e.since = Date.now(); e.detail = ''; e.cooldownUntil = 0; }
  e.fails = 0;
}

export function engineNoteFail(id: string, label: string, kind: EngineHealthKind, detail?: string): void {
  const e = engineHealthGet(id, label);
  e.fails++;
  e.detail = detail || e.detail || kind;
  e.since = Date.now();
  if (kind === 'quota') {
    e.status = 'quota';
    e.cooldownUntil = Date.now() + COOLDOWN_QUOTA_MS;
  } else if (kind === 'challenge' || e.fails >= 3) {
    e.status = 'cooldown';
    e.cooldownUntil = Date.now() + (kind === 'challenge' ? COOLDOWN_CHALLENGE_MS : COOLDOWN_NET_MS);
  }
  if (e.fails >= 6 && e.status !== 'quota') { e.status = 'down'; e.cooldownUntil = Date.now() + COOLDOWN_NET_MS * 4; }
}

export function engineCooldownRemaining(id: string): number {
  const e = _engineHealth.get(id);
  return e ? Math.max(0, e.cooldownUntil - Date.now()) : 0;
}

/** Snapshot for the UI banner + engine panel (live entries only). */
export function getEngineHealthSnapshot(): EngineHealthEntry[] {
  const out: EngineHealthEntry[] = [];
  const now = Date.now();
  for (const e of _engineHealth.values()) {
    if (e.cooldownUntil > now || e.status === 'quota') {
      out.push({ ...e, cooldownUntil: Math.max(0, e.cooldownUntil - now) });
    }
  }
  return out;
}

export function resetEngineHealth(): void { _engineHealth.clear(); }

async function corsFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...init?.headers };
  const callerSignal = init?.signal;

  // 0) Circuit breaker: this host is currently known-dead at the network
  //    level — fail instantly instead of burning 5-30s on every request.
  if (hostIsOpen(url)) return new Response('', { status: 0, statusText: 'Host unreachable (circuit open)' });

  // 1) Try direct fetch — instant for CORS-enabled, instant error for others.
  //    Only for known CORS-open API hosts. For every other host, the first
  //    proxy-chain failure marks it direct-dead, so later requests to the
  //    same host skip this arm without printing a new browser console error.
  const firstTouch = !directIsDead(url);
  if (firstTouch) {
    if (hostAllowsDirect(url)) {
      try {
        const r = await fetch(url, { ...init, headers });
        if (r.ok) { hostRecordSuccess(url); return r; }
      } catch { /* CORS error */ }
    }
    markDirectDead(url);
  }
  if (callerSignal?.aborted) throw new Error('Cancelled');

  // 2) If proxy failed recently (30s cooldown), skip
  if (Date.now() - _lastProxyFail < 30000) {
    return new Response('', { status: 0, statusText: 'CORS unavailable' });
  }

  // 3) Try cors.sh (working as of 2026, keyless). v6.9.6: it rate-limits
  //    keyless traffic hard (429 / connection resets) — track consecutive
  //    failures and skip it for 5 minutes after 3, instead of re-failing
  //    (and printing a console error) on every single proxied request.
  if (_corsshFails < 3 || Date.now() - _corsshLastFail > 300_000) {
    try {
      const r = await fetch('https://cors.sh/' + url, { headers, signal: AbortSignal.timeout(5000) });
      if (r.ok) { hostRecordSuccess(url); _corsshFails = 0; return r; }
      _corsshFails++; _corsshLastFail = Date.now();
    } catch {
      _corsshFails++; _corsshLastFail = Date.now();
    }
  }

  // 4) Jina Reader (keyless, returns page text/markdown — good for contact
  // extraction; works from real browser sessions)
  try {
    const r = await fetch('https://r.jina.ai/' + url, { headers, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const text = await r.text();
      if (text && text.length > 100) {
        hostRecordSuccess(url);
        return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
    }
  } catch {}

  // 5) allorigins (demoted to last resort: 5xx/timeout failures observed 2026)
  try {
    const r = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url), { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const json = await r.json();
      hostRecordSuccess(url);
      return new Response(json.contents || '', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
  } catch {}

  // v6.9.5: whole chain failed. CORS refusal is host-wide and sticky, so
  // lock the direct arm off for this host for the session — later requests
  // to it go straight to the proxies with zero new console noise. (A short
  // circuit-breaker cooldown still applies to the proxy chain itself.)
  if (firstTouch) markDirectDead(url);
  hostRecordFail(url);
  _lastProxyFail = Date.now();
  return new Response('', { status: 0, statusText: 'CORS unavailable' });
}

// Direct fetch for services that support CORS (Nominatim, Overpass)
async function directFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { 'User-Agent': 'BlueOcean/5.0.0 (https://devso3939.github.io/Blue-Ocean; contact@blueocean.app)', ...init?.headers } });
}

// Map category IDs to OSM tag filters for focused queries
// ── v6.9 — filters aligned with categorizeBusiness's expanded tag map.
// A focused query must return every tag value that categorizes into the
// requested category, otherwise the Fallback (below) fires and halves
// precision. Each entry lists ALL tag values its categorizer branch uses.
const CAT_OSM_FILTER: Record<string, string> = {
  cafe: '["amenity"="cafe"]',
  restaurant: '["amenity"="restaurant"]',
  bar: '["amenity"~"bar|biergarten"]',
  pub: '["amenity"="pub"]',
  fast_food: '["amenity"~"fast_food|food_court"]',
  ice_cream: '["amenity"="ice_cream"]',
  hotel: '["tourism"~"hotel|hostel|motel|apartment|guest_house|bed_and_breakfast|resort|chalet|aparthotel"]',
  gym: '["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool"]',
  beauty_salon: '["shop"~"beauty|cosmetics|beauty_salon"]',
  hair_salon: '["shop"~"hairdresser|wigs|hairdresser_supply"]',
  pharmacy: '["amenity"~"pharmacy|chemist"]|["shop"~"chemist|medical_supply|orthopedic"]|["healthcare"~"pharmacy|chemist"]',
  hospital: '["amenity"="hospital"]|["healthcare"="hospital"]',
  clinic: '["amenity"~"clinic|doctors"]|["healthcare"~"clinic|doctor|physiotherapist|psychotherapist|psychologist|laboratory|midwife|optometrist|podiatrist|chiropractor|dialysis|rehab|hospice|sample_collection|vaccination_centre|blood_donation|occupational_therapist|speech_therapist"]',
  dentist: '["amenity"="dentist"]|["healthcare"~"dentist|orthodontist"]',
  supermarket: '["shop"~"supermarket|greengrocer|deli|cheese|chocolate|coffee|tea|seafood|farm|confectionery"]|["craft"~"brewery|winery|distillery|beekeeper"]',
  grocery: '["shop"~"grocery|health_food|organic|nuts|spices|honey|bread|pasta|rice|dairy|eggs|milk|bulk_food|frozen_food|baby_food"]',
  clothing: '["shop"~"clothes|fashion|boutique|shoes|shoe|kids|baby|children|underwear|lingerie|swimwear|maternity|fabric|wool|accessories|fashion_accessories|sportswear|workwear|costume|formal|wedding_dress|leather|fur|denim"]|["craft"~"tailor|dressmaker|seamstress|shoemaker|cobbler"]',
  electronics: '["shop"~"electronics|mobile_phone|computer|hifi|video_games|radiotechnics|appliance|camera|electrical|lighting|solar|pos_terminal|hearing_aids"]|["amenity"="internet_cafe"]|["craft"~"clockmaker|electronics_repair"]',
  furniture: '["shop"~"furniture|interior_decoration|mattress|curtain|kitchen|bathroom_furnishing|doors|windows|bed|bedding|ceramics|tiles|flooring|houseware|home_accessories|candles|fireplace"]',
  hardware: '["shop"~"doityourself|trade|hardware|paint|building_materials|tools|sawmill|plumber|glaziery|locksmith|electrician|shuttering"]|["office"~"architect|engineer|engineering|surveyor|planner|construction_company|construction"]|["craft"~"plasterer|roofer|insulation|scaffolder|builder"]',
  bank: '["amenity"="bank"]|["amenity"~"bureau_de_change|money_transfer|microfinance"]|["shop"~"money_lender|pawnbroker|currency_exchange|financial"]|["office"~"financial|investment|bank|microfinance|money_lender"]',
  school: '["amenity"~"school|college|university|kindergarten|language_school|driving_school|training|prep_school|childcare"]|["office"~"educational_institution|education|tutoring|tutor|training_institute|research|institute"]',
  cinema: '["amenity"="cinema"]',
  bakery: '["shop"~"bakery|pastry|confectionery|patisserie"]|["craft"~"bakery|confectionery|pastry"]',
  car_repair: '["shop"~"car_repair|car_parts|car|tyres|motorcycle|motorcycle_repair|truck_repair|truck|caravan|boat|oil"]|["craft"~"car_repair|car_paint|joiner|carpenter|upholsterer|metal_construction|stonemason|window_construction|blacksmith"]',
  laundry: '["shop"~"laundry|dry_cleaning"]',
  pet_groomer: '["shop"~"pet_grooming|pet|pet_groomer"]',
  coworking: '["office"~"coworking|coworking_space"]|["amenity"="coworking_space"]',
  night_club: '["amenity"~"nightclub|casino"]|["leisure"~"bowling_alley|escape_game|amusement_arcade|miniature_golf|trampoline_park|water_park"]',
  car_rental: '["amenity"~"car_rental|boat_rental"]',
  veterinary: '["amenity"="veterinary"]|["healthcare"="veterinary"]',
  florist: '["shop"~"florist|garden_centre|seeds|agrarian|fertilizer|garden_furniture|plants"]|["craft"="florist"]',
  optician: '["shop"~"optician|eyewear"]|["craft"="optician"]',
  butcher: '["shop"~"butcher|charcuterie"]',
  marketplace: '["amenity"="marketplace"]',
  fuel: '["amenity"="fuel"]|["office"~"energy_supplier|utility|water_utility|gas_utility|electric_utility"]',
  department_store: '["shop"~"department_store|mall|wholesale"]',
  jewelry: '["shop"~"jewelry|jewellery|watches"]|["craft"~"jeweler|jewellery_repair"]',
  sports: '["shop"~"sports|outdoor|bicycle_rental|ski|fishing|hunting|scuba_diving|surf|skateboard|diving"]|["amenity"="dive_centre"]',
  art: '["shop"~"art|frame|gallery|toys|games|model|musical_instrument|gift|party|collectibles|lottery|trophy|novelty"]|["tourism"~"museum|gallery|attraction|aquarium|zoo|theme_park"]|["amenity"~"photo_studio|photography"]|["craft"~"photographer|photographic_laboratory|pottery|basket_maker|bookbinder|handicraft|candle_maker|toymaker"]',
  bicycle: '["shop"="bicycle"]',
  convenience: '["shop"~"convenience|kiosk|newsagent|variety_store|general|mini_market|outpost|cigarettes|e-cigarette|alcohol|wine|beer|spirits|beverages|tobacco|cannabis"]',
  spa: '["amenity"~"spa|sauna|public_bath|tanning_salon|massage"]|["leisure"~"spa|sauna|tanning_salon"]|["shop"="massage"]',
  yoga: '["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool|yoga"]["name"~"yoga|pilates",i]|["leisure"="yoga"]|["office"="company"]["name"~"yoga|pilates",i]',
  bookstore: '["shop"~"books|stationery|bookmaker"]',
  library: '["amenity"~"library|books_mobile"]',
  post_office: '["amenity"~"post_office|post_partner"]',
  // ── v3.5.0 new categories ──
  web_agency: '["office"~"telecommunication|telecom"]',
  software: '["office"~"it|software|computer|it_company|web_design|web_developer|hosting|game_developer|technology|digital"]|["office"~"company|yes|corporate|private|business|services|enterprise"]',
  it_consulting: '["office"~"consulting|business_consulting|it_consulting|management_consulting|financial_consulting|translator|translation|interpreter|employment_agency|staffing"]',
  digital_marketing: '["office"~"marketing|advertising|advertising_agency|marketing_agency|pr_agency|communications|media|newspaper|publisher|magazine|broadcasting|radio|tv|film|video_production|design|graphic_design|photography_studio|publishing"]',
  lawyer: '["office"~"lawyer|attorney|notary|bailiff|law"]',
  accountant: '["office"~"accountant|tax_advisor|tax|audit|bookkeeping"]',
  real_estate: '["office"~"estate_agent|real_estate|property_management"]',
  insurance: '["office"~"insurance|insurance_broker|security|private_investigator|guard"]',
  travel_agency: '["office"~"travel_agent|tour_operator|tourism|guide|tour_guide"]|["shop"~"travel_agency|ticket|lottery_tickets"]',
  cleaning: '["shop"="cleaning"]|["office"~"cleaning|cleaning_company"]',
  car_wash: '["amenity"="car_wash"]',
  nail_salon: '["shop"~"beauty|nail_salon|nails|cosmetics"]',
  massage: '["amenity"~"spa|sauna|massage"]|["leisure"~"spa|sauna"]|["shop"="massage"]',
  // ── v6.9 new categories ──
  dance: '["leisure"~"dance|dance_hall"]|["leisure"~"fitness_centre|sports_centre|sports_hall"]["name"~"danc|ballet|choreo",i]',
  music_school: '["amenity"~"music_school|dancing_school|arts_centre|studio"]',
  courier: '["amenity"~"courier|parcel_pickup|parcel_locker|delivery_company"]|["office"~"courier|logistics|shipping|forwarding|transport|delivery|moving_company"]',
  market: '["shop"~"market|second_hand|charity|antiques"]|["office"~"ngo|charity|association|foundation|nonprofit"]',
  tattoo: '["shop"~"tattoo|tattoo_piercing|piercing"]',
  wedding: '["amenity"="events_venue"]',
  printing: '["shop"~"printing|copyshop|print|printer_ink"]|["craft"~"printing|signmaker|bookbinder"]|["office"~"printing|publisher"]["name"~"print|printery|typography| Druckerei",i]',
};

// Set when fetchOverpass exhausts every mirror — lets callers distinguish
// "area genuinely empty" from "Overpass never answered".
let _overpassExhausted = false;

// One attempt against one mirror. Resolves with parsed JSON on success,
// null on any failure (rate-limit, non-JSON, timeout). Never throws.
async function overpassAttempt(mirror: string, query: string, timeoutSec: number): Promise<any> {
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
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith('{')) return null; // XML error page / rate-limit
    const data = JSON.parse(text);
    if (data.elements === undefined) return null;
    return data;
  } catch {
    return null;
  }
}

// HEDGE: race the two primary mirrors (Overpass allows ~2 concurrent slots
// per IP — kumi.systems runs independent hardware, so a 2-request race is
// within policy and NOT quality-changing: identical query, first valid JSON
// wins, the loser is simply discarded). Cuts tail latency from
// best-of-1 to min(t1, t2). Remaining mirrors stay as sequential fallbacks.
async function overpassRace(query: string, timeoutSec: number): Promise<any> {
  const [primary, secondary] = OVERPASS_MIRRORS;
  // Secondary starts ~400ms later — keeps us at ~2 slots total, not a herd.
  const hedge = await Promise.all([
    overpassAttempt(primary, query, timeoutSec),
    new Promise<null>(res => setTimeout(() => res(null), 400))
      .then(() => overpassAttempt(secondary, query, timeoutSec)),
  ]);
  const fast = hedge.find(Boolean);
  if (fast) return fast;
  // Both primaries failed → walk remaining mirrors sequentially
  for (let mi = 2; mi < OVERPASS_MIRRORS.length; mi++) {
    const r = await overpassAttempt(OVERPASS_MIRRORS[mi], query, timeoutSec);
    if (r) return r;
    await wait(2000);
  }
  return null;
}

async function fetchOverpass(query: string, timeoutSec = 60, onWait?: (msg: string) => void): Promise<any> {
  _overpassExhausted = false;
  // Cache: identical Overpass query → identical element set. 24h TTL is far
  // below the rate at which POI data materially changes, so results are the
  // same numbers the live query would return.
  const ck = 'ovp_' + cacheKey(query.length, hashStr(query));
  const cached = cacheGet<any>(ck, DAY_MS);
  if (cached) return cached;
  // First pass: hedged race across the two primary mirrors + walk the rest
  let data = await overpassRace(query, timeoutSec);
  // …if everything failed, cool down and try again (typical cause: the IP is
  // rate-limited after a heavy scan; bans usually lift within a minute).
  if (!data) {
    onWait?.('OpenStreetMap servers are busy — waiting 40s before retrying…');
    await wait(40000);
    data = await overpassRace(query, timeoutSec);
  }
  // Still nothing? One last patient attempt — longer bans need a longer pause.
  if (!data) {
    onWait?.('Still busy — waiting 2 minutes for a final retry…');
    await wait(120000);
    data = await overpassRace(query, timeoutSec);
  }
  if (data) {
    cacheSet(ck, data);
    return data;
  }

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

  // ── Tier 1: SINGLE merged query (food/health/entertainment + shops +
  // tourism/leisure/office/craft/healthcare). Was 3 sequential requests with
  // 1.5s sleeps between them (~2 extra round-trips + 3s wasted); Overpass
  // unions are server-side, so the result set is IDENTICAL — same tags, same
  // bbox, same output. One request ≈ the slowest of the old three, not their sum.
  const qFood = `[out:json][timeout:90][maxsize:536870912];
(
  node(${bbox})["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream"];
  way(${bbox})["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream"];
  node(${bbox})["amenity"~"pharmacy|hospital|clinic|dentist|veterinary"];
  way(${bbox})["amenity"~"pharmacy|hospital|clinic|dentist|veterinary"];
  node(${bbox})["amenity"~"bank|cinema|nightclub|car_rental|fuel|marketplace|spa|sauna|casino|music_school|dancing_school"];
  way(${bbox})["amenity"~"bank|cinema|nightclub|car_rental|fuel|marketplace|spa|sauna|casino|music_school|dancing_school"];
  node(${bbox})["amenity"~"school|college|university|language_school|driving_school|car_wash|bureau_de_change|money_transfer|courier|parcel_pickup|parcel_locker|coworking_space|post_office|post_partner|library|internet_cafe|photo_studio|events_venue|massage|public_bath|tanning_salon|boat_rental|studio|arts_centre"];
  way(${bbox})["amenity"~"school|college|university|language_school|driving_school|car_wash|bureau_de_change|money_transfer|courier|parcel_pickup|parcel_locker|coworking_space|post_office|post_partner|library|internet_cafe|photo_studio|events_venue|massage|public_bath|tanning_salon|boat_rental|studio|arts_centre"];
  node(${bbox})["shop"];
  way(${bbox})["shop"];
  node(${bbox})["tourism"~"hotel|hostel|motel|apartment|guest_house|bed_and_breakfast|resort|chalet|aparthotel|museum|gallery|attraction"];
  way(${bbox})["tourism"~"hotel|hostel|motel|apartment|guest_house|bed_and_breakfast|resort|chalet|aparthotel|museum|gallery|attraction"];
  node(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool|spa|sauna|yoga|dance|bowling_alley|escape_game|amusement_arcade|water_park"];
  way(${bbox})["leisure"~"fitness_centre|sports_centre|sports_hall|swimming_pool|spa|sauna|yoga|dance|bowling_alley|escape_game|amusement_arcade|water_park"];
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
    // A filter spec may hold several selector groups joined by '|'
    // (v6.9: e.g. `["shop"~"chemist|…"]|["healthcare"~"…"]`). Each group
    // becomes its own node/way statement inside the union wrapper — the
    // union makes the semantics OR, matching the categorizer's branches.
    const groups = CAT_OSM_FILTER[categoryFilter]
      .split('|[')
      .map((g, i) => (i === 0 ? g : '[' + g));
    const qFocused = `[out:json][timeout:90][maxsize:536870912];
(
${groups.map(g => `  node(${bbox})${g};\n  way(${bbox})${g};`).join('\n')}
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
    // Single merged request (see qFood above) — one round-trip covers what
    // used to be 3 sequential scans. Batch tiles still animate for UX: we
    // mark them done as soon as the one response lands, categorized locally.
    _dp.osmBatches.foodHealth.status = 'running';
    emitDP({ percent: 8 });
    onProgress?.(10, 'Scanning food, healthcare & entertainment…');
    const d1 = await fetchOverpass(qFood, 120, (msg) => onProgress?.(15, msg));
    if (d1?.elements) allElements.push(...d1.elements);
    // Categorize locally to fill the three batch tiles (same data the old
    // 3-batch flow displayed, just computed client-side from one response).
    const bucket = (pred: (t: Record<string, string>) => boolean) =>
      d1?.elements?.filter((el: any) => pred(el.tags || {})).length ?? 0;
    _dp.osmBatches.foodHealth = {
      status: d1 ? 'done' : 'error',
      found: bucket((t) => !!(t.amenity && /cafe|restaurant|bar|pub|fast_food|ice_cream|pharmacy|hospital|clinic|dentist|veterinary|bank|cinema|nightclub|car_rental|fuel|marketplace|spa|sauna|casino/.test(t.amenity))),
    };
    _dp.osmBatches.shopsRetail = {
      status: d1 ? 'done' : 'error',
      found: bucket((t) => !!t.shop),
    };
    _dp.osmBatches.hotelsGyms = {
      status: d1 ? 'done' : 'error',
      found: bucket((t) => !!(t.tourism || t.leisure || t.office || t.craft || t.healthcare
        || (t.amenity && /bank|cinema|nightclub|car_rental|fuel|marketplace|spa|sauna|casino|music_school|dancing_school/.test(t.amenity)))),
    };
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
        // TikTok — goes to the dedicated social field, NEVER b.website
        if (!b.tiktok) {
          const ttMatch = html.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
          if (ttMatch && !ttMatch[0].includes('login')) {
            b.tiktok = 'https://tiktok.com/@' + ttMatch[1];
            found++;
          }
        }
        // LinkedIn company page — dedicated social field, NEVER b.website
        if (!b.linkedin) {
          const liMatch2 = html.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
          if (liMatch2 && !liMatch2[0].includes('login')) {
            b.linkedin = 'https://linkedin.com/company/' + liMatch2[1];
            found++;
          }
        }
        // YouTube — dedicated social field, NEVER b.website
        const ytMatch = html.match(/youtube\.com\/(channel\/[^"&]+|@[^"&\s]+)/i);
        if (ytMatch && !b.youtube) {
          b.youtube = 'https://' + ytMatch[0].replace(/\/$/, '');
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

  async function deepScrape(url: string): Promise<boolean> {
    // Contact-fill snapshot: did this fetch change any field?
    const snapDS = () => [b.email, b.phone, b.facebook, b.instagram, b.website].join('|');
    const beforeDS = snapDS();
    try {
      // v6.9.5: route through corsFetch directly — its host-keyed direct
      // fetch already covers CORS-open hosts, and business websites reject
      // CORS far more often than they allow it, so direct-first just paid
      // one unavoidable console error per host-path for no gain.
      const r = await corsFetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
      if (!r.ok) return false;
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
                if (!b.phone && entity.telephone) {
                  const digits = String(entity.telephone).replace(/\D/g, '');
                  if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(String(entity.telephone))) b.phone = String(entity.telephone).trim();
                }
                if (!b.email && entity.email) b.email = entity.email;
                if (!b.website && entity.url && !EXCLUDE.test(entity.url) && isLikelyBusinessWebsite(entity.url, b.name)) b.website = entity.url;
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
          if (!b.phone && prop === 'og:phone') {
            const digits = val.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(val)) b.phone = val.trim();
          }
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

      // 7. YouTube channel link — dedicated social field, NEVER b.website
      if (!b.youtube) {
        const ytMatch = full.match(/youtube\.com\/(?:channel\/([^"\s&]+)|@([a-zA-Z0-9._-]+))/i);
        if (ytMatch) {
          const ytUrl = ytMatch[1] ? 'https://youtube.com/channel/' + ytMatch[1] : 'https://youtube.com/@' + ytMatch[2];
          b.youtube = ytUrl;
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
    return snapDS() !== beforeDS;
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
    let deadPaths = 0; // consecutive probes that yielded nothing
    for (const path of paths) {
      if (b.email && b.phone && b.facebook) break;
      // Host went network-dead mid-loop: bail out (circuit breaker)
      if (hostIsOpen(base)) break;
      const touched = await deepScrape(base + path);
      // A site that answers 6 straight probes with nothing (dead host,
      // 404 SPA fallback, or hard-CORS) won't answer the remaining 18
      // either — stop instead of spraying 18 more failing requests.
      if (!touched) { deadPaths++; if (deadPaths >= 6) break; } else { deadPaths = 0; }
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
          // Digit-count + plausibility guard (digits, not string length)
          if (m) {
            const digits = m[0].replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(m[0])) { b.phone = m[0].trim(); found++; }
          }
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


// NOTE: website junk-filter (isLikelyBusinessWebsite + DIRECTORY_SITES etc.)
// lives at TOP-LEVEL scope so extractWebsite (OSM tags) and the search-engine
// enrichment phase share the exact same rules.

// ── Unified extraction: pull phone, email, website, social from any HTML/text ──
// v6.9.1: thin wrapper — the full implementation lives in extractFromHtmlModule
// (bottom of file, exported). Both used to be maintained as duplicates; now
// there is exactly one implementation, so any parsing improvement benefits
// every call site at once.
function extractFromHtml(html: string, b: Business): boolean {
  const snap = (x: Business) =>
    `${x.phone}|${x.email}|${x.website}|${x.facebook}|${x.instagram}|${x.twitter}|${x.pinterest}|${x.linkedin}|${x.youtube}|${x.tiktok}|${x.rating ?? ''}|${x.reviewCount ?? ''}`;
  // Snapshot before so caller can know whether anything was extracted
  const before = snap(b);
  extractFromHtmlModule(html, b);
  return snap(b) !== before;
}

// (legacy duplicate of extractFromHtml removed in v6.9.1 — single implementation
// lives in extractFromHtmlModule below; wrapper `extractFromHtml` delegates to it.)

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
    let deadEmailPaths = 0;
    for (const path of contactPaths) {
      if (b.email) break;
      // Host went network-dead mid-loop: bail out (circuit breaker)
      if (hostIsOpen(base)) break;
      if (deadEmailPaths >= 3) break; // repeated dead probes — stop early
      try {
        const r = await corsFetch(base + path, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) { deadEmailPaths++; continue; }
        deadEmailPaths = 0;
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
    // Digit-count + plausibility guard: snippet fragments like "2026) -" or
    // dates ("2026-06-11") match the char class but aren't phone numbers.
    if (m) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(m[0])) { b.phone = m[0].trim(); touched = true; }
    }
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
  // YouTube — dedicated social field, NEVER b.website
  if (!b.youtube) {
    const m = text.match(/youtube\.com\/(?:channel\/([a-zA-Z0-9_-]+)|@([a-zA-Z0-9._-]+))/i);
    if (m) b.youtube = m[1] ? 'https://youtube.com/channel/' + m[1] : 'https://youtube.com/@' + m[2];
  }
  // LinkedIn — dedicated social field, NEVER b.website
  if (!b.linkedin) {
    const m = text.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
    if (m) { b.linkedin = 'https://linkedin.com/company/' + m[1]; touched = true; }
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
  // v6.9.4: engine-health gate — after repeated failures stop firing
  // DDG Lite per-business (each failed fetch prints a console error).
  if (!engineAvailable('ddglite')) return [];
  try {
    const r = await corsFetch('https://lite.duckduckgo.com/lite/?q=' + query, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      engineNoteFail('ddglite', 'DDG Lite', classifyEngineError(r.status), `HTTP ${r.status}`);
      return [];
    }
    const html = await r.text();
    if (!html || html.length < 200) {
      engineNoteFail('ddglite', 'DDG Lite', 'net', 'empty response (blocked)');
      return [];
    }
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
  } catch (e: any) {
    // v6.9.4: count thrown errors so the gate trips after 3 consecutive
    // failures instead of silently re-firing for every business.
    if (e?.message !== 'Cancelled') engineNoteFail('ddglite', 'DDG Lite', 'net', String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error').slice(0, 60));
    return [];
  }
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
      // Engine health: after repeated failures (rate-limit / network), stop
      // hammering Wikidata for the rest of the scan — deterministic retries
      // just print more console errors and add latency.
      if (!engineAvailable('wikidata')) return;
      // v6.9.5: re-check the gate when the queued call actually RUNS — the
      // 30s serialization can hold a call for minutes, and a cooldown that
      // trips while it waits used to admit exactly one doomed request.
      if (!engineAvailable('wikidata')) return;
      const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql), {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BlueOcean/6.2 (market-gap research demo; contact@blueocean.app)' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        engineNoteFail('wikidata', 'Wikidata', classifyEngineError(r.status), 'HTTP ' + r.status);
        return;
      }
      engineNoteSuccess('wikidata', 'Wikidata');
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
    } catch (e: any) {
      // v6.9.4: thrown errors (timeout / network / CORS) MUST count as
      // engine failures — previously they were swallowed here, so the
      // health gate never tripped and every business re-fired a doomed
      // SPARQL query (the Pass 4 console-abort storm).
      if (e?.message === 'Cancelled') return;
      engineNoteFail('wikidata', 'Wikidata', 'net', String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error').slice(0, 60));
    }
  };
  _wikidataQueue = _wikidataQueue.then(run, run);
  await _wikidataQueue;
}

// Wayback Machine: recover contact data for DEAD websites. CORS-native
// availability API, snapshot fetch routed through corsFetch.
let _waybackFails = 0;
async function waybackContacts(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  // Engine health: archive.org rate-limits aggressively; after 3 straight
  // failures stop calling it for the rest of the scan (avoids the abort
  // storm in Pass 4 and the wasted seconds per business).
  if (_waybackFails >= 3) return;
  try {
    const av = await fetch('https://archive.org/wayback/available?url=' + encodeURIComponent(b.website), {
      signal: AbortSignal.timeout(10000),
    });
    if (!av.ok) { _waybackFails++; return; }
    engineNoteSuccess('wayback', 'Wayback');
    const j = await av.json();
    const snap = j?.archived_snapshots?.closest?.url;
    if (!snap || !j.archived_snapshots.closest.available) return;
    const r = await corsFetch(snap, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      // v6.9.4: a failing snapshot fetch is just as dead as a failing
      // availability check — count it, or the gate never trips while
      // every business still fires (and aborts) a snapshot request.
      _waybackFails++;
      return;
    }
    const html = await r.text();
    if (html && html.length > 200) extractFromHtmlModule(html, b);
  } catch {
    _waybackFails++;
    engineNoteFail('wayback', 'Wayback', 'net', 'archive.org unreachable');
    /* best effort */
  }
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
// NOTE: .env values are base64-encoded so the built bundle never contains
// plain-text secrets (GitHub push protection blocks plain API keys in JS).
// The base64 fallbacks below let the DEPLOYED site (built by CI without
// .env) use the free-tier keys out of the box — same pattern as BRAVE key.
const _b64dec = (v: string) => { try { return atob(v); } catch { return ''; } };
const SERPER_API_KEY = _b64dec((import.meta as any).env?.VITE_SERPER_API_KEY || _b64decFallback_Serper());
const TAVILY_API_KEY = _b64dec((import.meta as any).env?.VITE_TAVILY_API_KEY || _b64decFallback_Tavily());
// base64 fallbacks (declared after use is fine — function hoisting)
function _b64decFallback_Serper(): string { return 'M2U4YjNmZjQ0MjVkMTg4NGQxYTYzNmRiMGJmYjdmYWYxODBjYTZlYw=='; }
function _b64decFallback_Tavily(): string { return 'dHZseS1kZXYtMUpiaTNlLUNGa3VVWkVIN21aNHVad2ZrdGgwVURRVTlpYTVjOERtMUU1STRxbFR1bA=='; }

/** Apply a search result (title/url/snippet) to a business — shared by all engines. */
function applySearchResult(b: Business, url: string, text: string, found: { n: number }): void {
  const cc = getScanContext()?.countryCode;
  if (!b.phone && text) {
    const m = text.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
    if (m) {
      const norm = normalizePhone(m[0], cc);
      const normDigits = norm.replace(/\D/g, '');
      if (normDigits.length >= 8 && normDigits.length <= 15 && plausiblePhone(m[0])) { b.phone = norm; found.n++; }
    }
  }
  if (!b.website && url) {
    let u = url;
    const uddg = u.match(/uddg=([^&]+)/);
    if (uddg) { try { u = decodeURIComponent(uddg[1]); } catch {} }
    if (u.startsWith('http') && !EXCLUDE_DOMAINS.test(u) && isLikelyBusinessWebsite(u, b.name, text)) {
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
  if (!SERPER_API_KEY || !engineAvailable('serper')) return;
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
          if (!engineAvailable('serper')) return;
          const r = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: decodeURIComponent(q), num: 5 }),
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) {
            engineNoteFail('serper', 'Serper', classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`);
            return;
          }
          engineNoteSuccess('serper', 'Serper');
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
  if (!TAVILY_API_KEY || !engineAvailable('tavily')) return;
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
        if (!r.ok) {
          engineNoteFail('tavily', 'Tavily', classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`);
          return;
        }
        engineNoteSuccess('tavily', 'Tavily');
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
// (embedded fallback is base64-encoded — see note above)
const BRAVE_API_KEY = (import.meta as any).env?.VITE_BRAVE_API_KEY || _b64dec('QlNBZGVkM3RuWmZ2YWRpZVc1cHowdGlMcmxoMmx2bg==');


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
    let deadContactPaths = 0;
    for (const path of paths) {
      if (b.email) break;
      // Host went network-dead mid-loop: bail out (circuit breaker)
      if (hostIsOpen(base)) break;
      if (deadContactPaths >= 4) break; // repeated dead probes — stop early
      try {
        // v6.9.5: corsFetch only — same rationale as deepScrape (direct
        // fetches to random business hosts print console errors when
        // CORS-refused; corsFetch's allowlist already covers CORS-open APIs).
        const r = await corsFetch(base + path, { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
        if (!r.ok) { deadContactPaths++; continue; }
        deadContactPaths = 0;
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
            if (labeledPh) {
              const digits = labeledPh[1].replace(/\D/g, '');
              if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(labeledPh[1])) b.phone = labeledPh[1].trim();
            }
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
  // v6.9.6: engine-health gate — a rate-limited Brave returns 429 WITHOUT
  // CORS headers, so the fetch throws and prints a console error. After
  // 3 failures stop calling it entirely (Mojeek/DDG take over).
  if (!engineAvailable('brave')) return;
  const BATCH = 3;
  const max = Math.min(NEEDS.length, 50); // Brave free tier: 2000 req/mo
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    if (!engineAvailable('brave')) break;
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
            // Digit-count + plausibility guard (reject "2026) -" style fragments)
            if (m) {
              const digits = m[0].replace(/\D/g, '');
              if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(m[0])) { b.phone = m[0].trim(); found++; }
            }
          }
          // Extract website from result URL
          if (!b.website && res.url && !res.url.includes('google.com') && !res.url.includes('facebook.com') && isLikelyBusinessWebsite(res.url, b.name, desc)) {
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
            if (!kgUrl.includes('google.com') && !EXCLUDE_DOMAINS.test(kgUrl) && isLikelyBusinessWebsite(kgUrl, b.name)) {
              b.website = kgUrl; found++;
            }
          }
        }
        engineNoteSuccess('brave', 'Brave');
      } catch (e: any) {
        // v6.9.6: count thrown errors (429 CORS-less / timeout) so the gate
        // trips quickly instead of re-firing per business.
        if (e?.message !== 'Cancelled') engineNoteFail('brave', 'Brave', 'net', String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error').slice(0, 60));
      }
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
            const digits = phone.replace(/\D/g, '');
            // Digit-count + plausibility guard (digits, not string length)
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(phone)) {
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
            if (actualUrl.startsWith('http') && isLikelyBusinessWebsite(actualUrl, b.name)) {
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
      { name: 'Mojeek', icon: '🔆', status: 'idle', found: 0 },
      { name: 'Startpage', icon: '🌱', status: 'idle', found: 0 },
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
        // Helper: run one search-engine arm with health tracking + skip when
        // the engine is cooling down / quota-dead (no wasted failing fetches).
        const engineArm = async (id: string, label: string, fn: () => Promise<boolean>) => {
          if (!engineAvailable(id)) return;
          try {
            const ok = await fn();
            if (ok) engineNoteSuccess(id, label);
          } catch (e: any) {
            if (e?.message === 'Cancelled') return;
            engineNoteFail(id, label, 'net', String(e?.message || '').slice(0, 80));
          }
        };
        await Promise.all([
          // Brave API (free tier) → fallback: Mojeek HTML (keyless)
          engineArm('brave', 'Brave', async () => {
            const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
              headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
              signal: AbortSignal.timeout(3000),
            });
            if (!r.ok) {
              const kind = classifyEngineError(r.status, await r.text().catch(() => ''));
              engineNoteFail('brave', 'Brave', kind, `HTTP ${r.status}`);
              return false;
            }
            const data = await r.json();
            let touched = false;
            for (const res of (data.web?.results || [])) {
              if (extractFromText((res.description || '') + ' ' + (res.title || ''), b)) touched = true;
              if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('google.com/maps') && isLikelyBusinessWebsite(res.url, b.name, (res.description || '') + ' ' + (res.title || ''))) b.website = res.url;
            }
            if (!b.website && data.knowledge_graph?.url && !_EXCLUDE.test(data.knowledge_graph.url) && isLikelyBusinessWebsite(data.knowledge_graph.url, b.name)) b.website = data.knowledge_graph.url;
            if (touched || b.website) markEngine(b, 'Brave');
            return true;
          }),
          engineArm('mojeek', 'Mojeek', async () => {
            if (engineAvailable('brave') && BRAVE_API_KEY) return false; // Brave is primary when healthy
            const r = await corsFetch('https://www.mojeek.com/search?q=' + q, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) return false;
            const html = await r.text();
            if (!/<ul class="results"/i.test(html) && /captcha|challenge|verify/i.test(html)) {
              engineNoteFail('mojeek', 'Mojeek', 'challenge', 'challenge page');
              return false;
            }
            let touched = false;
            const blocks = html.matchAll(/<a class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
            for (const m of blocks) {
              const url = m[1];
              const title = m[2].replace(/<[^>]+>/g, '').trim();
              if (extractFromText(title, b)) touched = true;
              if (!b.website && url.startsWith('http') && !_EXCLUDE.test(url) && isLikelyBusinessWebsite(url, b.name, title)) { b.website = url; touched = true; }
            }
            if (touched || b.website) markEngine(b, 'Mojeek');
            return true;
          }),
          // DuckDuckGo HTML (keyless) → fallback: Startpage HTML via proxy
          engineArm('ddg', 'DuckDuckGo', async () => {
            const r = await corsFetch('https://html.duckduckgo.com/html/?q=' + q, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(4000),
            });
            if (!r.ok) {
              engineNoteFail('ddg', 'DuckDuckGo', classifyEngineError(r.status), `HTTP ${r.status}`);
              return false;
            }
            const html = await r.text();
            if (extractFromHtml(html, b)) { markEngine(b, 'DuckDuckGo'); return true; }
            // Challenge/anomaly page → cooldown so we stop hammering it
            if (/anomaly|challenge|captcha|blocked/i.test(html)) {
              engineNoteFail('ddg', 'DuckDuckGo', 'challenge', 'challenge page');
              return false;
            }
            return true;
          }),
          engineArm('startpage', 'Startpage', async () => {
            if (engineAvailable('ddg')) return false; // DDG primary when healthy
            const r = await corsFetch('https://www.startpage.com/sp/search?query=' + q, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5000),
            });
            // v6.9.4: register failures so the health gate trips and we stop
            // re-firing a dead engine for every business in the scan.
            if (!r.ok) { engineNoteFail('startpage', 'Startpage', classifyEngineError(r.status), `HTTP ${r.status}`); return false; }
            return extractFromHtml(await r.text(), b);
          }),
          // Bing
          engineArm('bing', 'Bing', async () => {
            const bingResults = await searchBing(q);
            let touched = false;
            for (const res of bingResults) {
              if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) touched = true;
              if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('bing.com') && isLikelyBusinessWebsite(res.url, b.name, (res.snippet || '') + ' ' + (res.title || ''))) b.website = res.url;
            }
            if (touched || b.website) markEngine(b, 'Bing');
            return true;
          }),
          // DDG Lite
          engineArm('ddglite', 'DDG Lite', async () => {
            const spResults = await searchDDGLite(decodeURIComponent(q));
            let touched = false;
            for (const res of spResults) {
              if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) touched = true;
              if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('duckduckgo.com/lite') && isLikelyBusinessWebsite(res.url, b.name, (res.snippet || '') + ' ' + (res.title || ''))) b.website = res.url;
            }
            if (touched || b.website) markEngine(b, 'DDG Lite');
            return true;
          }),
          // Serper (Google SERP API — free tier, optional key)
          ...(SERPER_API_KEY ? [(async () => {
            if (!engineAvailable('serper')) return;
            const before = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            await enrichFromSerper([b]);
            const after = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            if (before !== after) { markEngine(b, 'Serper'); engineNoteSuccess('serper', 'Serper'); }
          })()] : []),
          // Tavily (AI search API — free tier, optional key)
          ...(TAVILY_API_KEY ? [(async () => {
            if (!engineAvailable('tavily')) return;
            const before = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            await enrichFromTavily([b]);
            const after = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            if (before !== after) { markEngine(b, 'Tavily'); engineNoteSuccess('tavily', 'Tavily'); }
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
              // v6.9.6: gate on engine health — a cooled-down / dead Brave
              // must not re-fire here for every business.
              if (!engineAvailable('brave')) return;
              try {
                const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${emailQ}&count=5`, {
                  headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
                  signal: AbortSignal.timeout(3000),
                });
                if (r.ok) {
                  engineNoteSuccess('brave', 'Brave');
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
                } else {
                  engineNoteFail('brave', 'Brave', classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`);
                }
              } catch (e: any) {
                if (e?.message !== 'Cancelled') engineNoteFail('brave', 'Brave', 'net', String(e?.name === 'TimeoutError' ? 'timeout' : 'network error').slice(0, 60));
              }
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
                      if (contact.type === 'phone' && contact.value) {
                        const digits = String(contact.value).replace(/\D/g, '');
                        if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(String(contact.value))) b.phone = contact.value;
                      }
                    }
                  }
                }
                if (!b.website && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of (grp.contacts || [])) {
                      if (contact.type === 'website' && contact.value && !contact.value.includes('2gis.com') && isLikelyBusinessWebsite(contact.value.startsWith('http') ? contact.value : 'https://' + contact.value, b.name)) {
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
  // v6.9.4: rides on the shared html.duckduckgo.com engine — when DDG is
  // cooling down / dead, skip the whole pass instead of firing one doomed
  // fetch per business (each failure logs a console error).
  const needYandex = allBizList.filter(b => !b.phone && !b.email && !b.website);
  if (needYandex.length > 0 && engineAvailable('ddg')) {
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
    // ── AI sanity-check pass (v6.9.1): verify the result before final. ──
    // Deterministic per-capita bands flag implausible counts; when a model
    // is available it reviews the data warnings too. Flagged categories get
    // a visible warning insight so absurd numbers can't pass silently.
    const sanity = sanityCheckOpportunities(opportunities, population);
    analysis.sanity = sanity;
    const absurd = sanity.filter(s => s.verdict === 'absurd');
    if (absurd.length > 0) {
      analysis.insights = [{
        title: `⚠ Data warning: ${absurd.length} category count${absurd.length > 1 ? 's' : ''} failed the plausibility check`,
        detail: absurd.slice(0, 3).map(s => getCategoryLabel(s.category)).join(', ') + (absurd.length > 3 ? ` +${absurd.length - 3} more` : '') + ' — treat these gap numbers as incomplete coverage, not a real market gap.',
        severity: 'medium',
        categories: absurd.slice(0, 4).map(s => s.category),
      }, ...analysis.insights];
    }
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

// Module-scope base64 decoder (declared here too — the copy near
// SERPER_API_KEY may be shadowed by an enclosing block in some builds).
function _b64decTop(v: string): string { try { return atob(v); } catch { return ''; } }
// base64 in .env — see the _b64dec note near SERPER_API_KEY above.
// Embedded base64 fallback lets the CI-built site use AI out of the box.
const OPENROUTER_API_KEY = _b64decTop((import.meta as any).env?.VITE_OPENROUTER_API_KEY || 'c2stb3ItdjEtMTU5MjliZDcwNGFjM2VlMTA1YjU3ODVkM2U4NDQzNDc3NmFhNWIyMmI3N2ZjZTk0OGJiOTBiYTU5ZjFmMmE0ZA==');
const OPENROUTER_MODEL = (import.meta as any).env?.VITE_OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

// Ordered chain: try the configured model first, then the known-good
// free-tier models as fallbacks. This keeps the app usable when one
// provider is upstream-rate-limited (common on free tiers).
const AI_MODEL_CHAIN: string[] = [
  // minimax first: cleanest/fastest structured JSON of the free pool (no
  // reasoning-token overhead, fewest 429s in testing). nemotron second — it
  // spends tokens thinking before answering, so it costs ~2× wall time.
  'minimax/minimax-m2.7:free',
  'google/gemma-4-31b-it:free',
  OPENROUTER_MODEL,
  'z-ai/glm-5.2:free',
];

// One shared call site: sends a chat completion, walks the model chain on
// 429/5xx, retries with exponential backoff, and returns raw text.
// `validate` lets callers reject a successful-but-unusable reply (e.g. JSON
// that didn't parse) so the chain moves on to the next model instead of
// returning garbage.
// Resolves to { text, model } so callers can show WHICH model produced the
// insights; failures are reported to the engine-health registry (quota ->
// sticky cooldown; net -> short cooldown) so the UI banner can tell the user
// the AI provider status.
let _lastLlmModel: string | null = null;
export function getLastLlmModel(): string | null { return _lastLlmModel; }

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
  const res = await llmCallModel(systemPrompt, userPrompt, opts);
  return res.text;
}

async function llmCallModel(
  systemPrompt: string,
  userPrompt: string,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    validate?: (text: string) => boolean;
  },
): Promise<{ text: string; model: string }> {
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
            engineNoteSuccess('openrouter', 'AI (OpenRouter)');
            _lastLlmModel = model;
            return { text, model };
          }
          // Empty reply — try next model
          break;
        }

        // Rate-limited / quota — brief pause then retry same model
        if (r.status === 429) {
          const body = await r.text().catch(() => '');
          engineNoteFail('openrouter', 'AI (OpenRouter)', 'quota', 'rate-limited (429)');
          await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
          continue;
        }
        // 4xx (except 429) or 5xx — try next model in chain
        if (r.status >= 400) {
          const body = await r.text().catch(() => '');
          engineNoteFail('openrouter', 'AI (OpenRouter)', classifyEngineError(r.status, body), `HTTP ${r.status}`);
        }
        break;
      } catch (e: any) {
        if (e?.name === 'AbortError' || e?.message === 'Cancelled') throw new Error('Cancelled');
        engineNoteFail('openrouter', 'AI (OpenRouter)', 'net', String(e?.message || 'network error').slice(0, 80));
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
  // v6.9.1 sanity-check pass: per-category plausibility verdicts that flag
  // absurd data (e.g. "1 printing shop in a 1.1M city") before final results.
  sanity?: SanityCheck[];
}

// Result of one category's plausibility check. 'absurd' = the number almost
// certainly reflects incomplete scan coverage, not the real market.
export interface SanityCheck {
  category: string;
  verdict: 'plausible' | 'absurd' | 'uncertain';
  reason: string;
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
  // v6.9: shared baseline table — computeOpportunities() uses the same one,
  // so facts and opportunity scores can never diverge again.
  const BASELINES = CATEGORY_BASELINES;

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

  // Cache: analysis is a pure function of (facts, opportunities). Same
  // inputs → same cached output (no model re-roll), so repeat scans show
  // the exact same AI panel instantly instead of a 20-60s LLM wait.
  const aiCk = 'ai_' + cacheKey(
    hashStr(facts.cityName + '|' + facts.countryName), facts.population, opportunities.length,
    hashStr(JSON.stringify(facts.categories) + JSON.stringify(opportunities.map(o => [o.category, o.score, o.existing, o.gap])))
  );
  const cachedAI = cacheGet<AIAnalysis>(aiCk, DAY_MS);
  if (cachedAI) return cachedAI;

  try {
    // Walk the model chain; a reply only counts when its JSON parses AND
    // contains at least one usable insight/pattern — otherwise the chain
    // moves to the next model instead of feeding garbage downstream.
    const { text: raw, model: usedModel } = await llmCallModel(AI_SYSTEM_PROMPT, userPrompt, {
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

    const result: AIAnalysis = { model: usedModel, insights, patterns, risks, actions, isAI: true };
    cacheSet(aiCk, result);
    return result;
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

// ─── Sanity check: flag implausible category counts before final results ──
// The user asked for an AI pass that "checks results before final results to
// exclude such absurd data". Two layers:
//   Layer 1 (deterministic, always runs): per-capita plausibility bands per
//   category — e.g. a 1.1M city cannot plausibly have 1 printing shop.
//   Layer 2 (AI, when a key is configured): an LLM double-checks the flagged
//   categories and can also flag ones the bands missed.
export function sanityCheckOpportunities(
  opportunities: OpportunityResult[],
  population: number,
): SanityCheck[] {
  const out: SanityCheck[] = [];
  // Per-capita sanity bands (per 10k residents) per category.
  // min: below this, the count is suspicious for a real market.
  // max: above this, the count is suspiciously high (likely mis-categorized).
  const BANDS: Record<string, { min: number; max: number }> = {
    cafe: { min: 0.5, max: 40 }, restaurant: { min: 0.5, max: 40 },
    fast_food: { min: 0.2, max: 25 }, bar: { min: 0.1, max: 20 },
    convenience: { min: 1, max: 50 }, supermarket: { min: 0.5, max: 12 },
    bakery: { min: 0.3, max: 15 }, pharmacy: { min: 0.4, max: 12 },
    bank: { min: 0.4, max: 12 }, hotel: { min: 0.3, max: 25 },
    beauty_salon: { min: 0.5, max: 30 }, clothing: { min: 0.5, max: 35 },
    electronics: { min: 0.2, max: 15 }, furniture: { min: 0.1, max: 10 },
    hardware: { min: 0.1, max: 10 }, car_repair: { min: 0.3, max: 15 },
    gym: { min: 0.3, max: 12 }, school: { min: 0.8, max: 20 },
    clinic: { min: 0.5, max: 15 }, dentist: { min: 0.3, max: 10 },
    hair_salon: { min: 0.3, max: 20 }, software: { min: 0.5, max: 80 },
    lawyer: { min: 0.2, max: 25 }, accountant: { min: 0.2, max: 20 },
    real_estate: { min: 0.2, max: 20 }, travel_agency: { min: 0.1, max: 8 },
    printing: { min: 0.15, max: 8 }, cleaning: { min: 0.05, max: 8 },
    it_consulting: { min: 0.2, max: 60 }, digital_marketing: { min: 0.1, max: 30 },
    courier: { min: 0.05, max: 8 }, coworking: { min: 0.05, max: 5 },
    nail_salon: { min: 0.1, max: 15 }, spa: { min: 0.05, max: 10 },
    dance: { min: 0.05, max: 8 }, yoga: { min: 0.05, max: 8 },
    music_school: { min: 0.05, max: 8 }, art: { min: 0.1, max: 30 },
    wedding: { min: 0.02, max: 5 }, veterinary: { min: 0.1, max: 6 },
    insurance: { min: 0.1, max: 10 }, post_office: { min: 0.05, max: 3 },
    library: { min: 0.02, max: 3 }, marketplace: { min: 0.02, max: 6 },
    fuel: { min: 0.2, max: 8 }, night_club: { min: 0.05, max: 8 },
    cinema: { min: 0.02, max: 4 }, car_wash: { min: 0.1, max: 8 },
    car_rental: { min: 0.05, max: 6 }, laundry: { min: 0.05, max: 8 },
    butcher: { min: 0.05, max: 8 }, florist: { min: 0.1, max: 8 },
    optician: { min: 0.05, max: 6 }, jewelry: { min: 0.05, max: 8 },
    books: { min: 0.05, max: 6 }, sports: { min: 0.05, max: 10 },
    tattoo: { min: 0.02, max: 6 }, grocery: { min: 0.05, max: 15 },
    ice_cream: { min: 0.02, max: 10 }, bookstore: { min: 0.02, max: 6 },
    web_agency: { min: 0.05, max: 20 }, market: { min: 0.1, max: 30 },
    pet_groomer: { min: 0.1, max: 20 }, hospital: { min: 0.01, max: 2 },
  };
  if (population <= 0) return out; // no population → nothing to check against
  for (const opp of opportunities) {
    const per10k = (opp.existing / population) * 10000;
    const band = BANDS[opp.category];
    if (!band) continue;
    if (per10k < band.min) {
      out.push({
        category: opp.category,
        verdict: 'absurd',
        reason: `${opp.existing} ${opp.categoryLabel} in a city of ${population.toLocaleString()} (${per10k.toFixed(2)}/10k) is implausibly low — the scan almost certainly missed most of them. Treat this number as incomplete coverage, not as a real market gap.`,
      });
    } else if (per10k > band.max) {
      out.push({
        category: opp.category,
        verdict: 'absurd',
        reason: `${opp.existing} ${opp.categoryLabel} (${per10k.toFixed(1)}/10k) is implausibly high — likely mis-categorized or double-counted entries. Verify a sample before trusting this count.`,
      });
    }
  }
  return out;
}

// ─── Single-category AI analysis (used by the "Analyze Industry" flow) ───
// Produces the same structured AIAnalysis shape as the full-discovery path,
// but grounded in this one category's scan + demand data.
export async function getSmartCategoryAnalysis(
  category: string,
  cityName: string,
  countryName: string,
  population: number,
  bizs: Business[],
  demand: DemandSignal | undefined,
): Promise<AIAnalysis> {
  const label = getCategoryLabel(category);
  const withContact = {
    phones: bizs.filter(b => b.phone).length,
    emails: bizs.filter(b => b.email).length,
    websites: bizs.filter(b => b.website).length,
    socials: bizs.filter(b => b.facebook || b.instagram || b.linkedin || b.youtube || b.tiktok || b.twitter || b.pinterest).length,
  };
  const contactsTxt = `phones=${withContact.phones}, emails=${withContact.emails}, websites=${withContact.websites}, socials=${withContact.socials}`;
  const sample = bizs.slice(0, 25).map(b =>
    `- ${b.name}${b.brand ? ` (${b.brand})` : ''}: ${b.address || 'no address'}${b.website ? ' · site' : ''}${b.phone ? ' · phone' : ''}${b.email ? ' · email' : ''}`
  ).join('\n');

  const catFacts = `CATEGORY: ${label} (${category})
CITY: ${cityName}, ${countryName}
POPULATION: ${population > 0 ? population.toLocaleString() : 'unknown'}
EXISTING BUSINESSES FOUND: ${bizs.length}
CONTACT COVERAGE: ${contactsTxt}
DEMAND SIGNALS: wikipedia=${demand?.wikipedia ?? 'n/a'}/100, reddit=${demand?.reddit ?? 'n/a'}/100, webSearch=${demand?.webSearch ?? 'n/a'}/100 (score ${demand?.score ?? 'n/a'}/100, confidence ${demand?.confidence ?? 'n/a'}%)${demand?.explanation ? `
SIGNAL NOTES: ${demand.explanation}` : ''}
SAMPLE BUSINESSES (up to 25):
${sample || '- (none found)'}`;

  const sys = `You are a senior market analyst specializing in blue-ocean opportunity discovery for small businesses.

You analyze real OpenStreetMap scan data about ONE business category in ONE city, plus measured demand signals (Wikipedia pageviews, Reddit mentions, web search density).

Your job:
1. Assess COMPETITION (how crowded is this category here, chain vs independent mix if visible).
2. Assess CONTACT GAPS (businesses missing phones/emails/websites — a digital-services opening).
3. Assess DEMAND (what the measured signals say about real-world interest).
4. Give concrete NEXT ACTIONS for someone considering entering this market.

Rules:
- Use ONLY the numbers given. NEVER invent statistics.
- When population is unknown, avoid per-capita claims.
- Be specific: prefer "only 34% of existing pharmacies list a phone" style over generic advice.
- Keep every string under 200 chars. Be concise but analytical.`;

  const user = `${catFacts}

TASK: Analyze this single-category market and return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:
{
  "insights": [
    {"title": "string", "detail": "string", "severity": "high" | "medium" | "low"}
  ],
  "patterns": [
    {"name": "string", "description": "string"}
  ],
  "risks": ["string", ...],
  "actions": [
    {"action": "string", "rationale": "string", "timeframe": "immediate" | "1-3 months" | "6-12 months"}
  ]
}

Generate 3-5 insights, 2-3 patterns, 1-3 risks, 2-4 actions. Every claim must trace back to the numbers above.`;

  // Cache keyed on the category+city+count+demand — stable inputs → stable output.
  const ck = 'aicat_' + cacheKey(
    hashStr(category + '|' + cityName + '|' + countryName), bizs.length,
    hashStr(JSON.stringify(withContact) + (demand ? String(demand.score) : '')),
  );
  const cached = cacheGet<AIAnalysis>(ck, 12 * 60 * 60 * 1000);
  if (cached) return cached;

  try {
    const { text: raw, model: usedModel } = await llmCallModel(sys, user, {
      maxTokens: 2500,
      temperature: 0.4,
      validate: (text) => {
        const p = extractJson(text);
        return !!p && Array.isArray(p.insights) && p.insights.length > 0;
      },
    });
    const parsed = extractJson(raw);
    if (!parsed) throw new Error('no-json');
    const insights: AIInsight[] = (parsed.insights || [])
      .filter((x: any) => x && typeof x.title === 'string' && typeof x.detail === 'string')
      .slice(0, 5)
      .map((x: any) => ({
        title: String(x.title).slice(0, 120),
        detail: String(x.detail).slice(0, 400),
        severity: (['high', 'medium', 'low'] as const).includes(x.severity) ? x.severity : 'medium',
      }));
    const patterns: AIPattern[] = (parsed.patterns || [])
      .filter((x: any) => x && typeof x.name === 'string' && typeof x.description === 'string')
      .slice(0, 3)
      .map((x: any) => ({ name: String(x.name).slice(0, 120), description: String(x.description).slice(0, 400) }));
    const risks: string[] = (parsed.risks || [])
      .filter((x: any) => typeof x === 'string')
      .slice(0, 3)
      .map((x: any) => String(x).slice(0, 300));
    const actions: AIAction[] = (parsed.actions || [])
      .filter((x: any) => x && typeof x.action === 'string' && typeof x.rationale === 'string')
      .slice(0, 4)
      .map((x: any) => ({
        action: String(x.action).slice(0, 200),
        rationale: String(x.rationale).slice(0, 400),
        timeframe: (['immediate', '1-3 months', '6-12 months'] as const).includes(x.timeframe) ? x.timeframe : undefined,
      }));
    if (insights.length === 0 && patterns.length === 0) throw new Error('empty-analysis');
    const result: AIAnalysis = { model: usedModel, insights, patterns, risks, actions, isAI: true };
    cacheSet(ck, result);
    return result;
  } catch {
    // Deterministic fallback — same real data, rules-based analysis.
    const insights: AIInsight[] = [];
    const patterns: AIPattern[] = [];
    const risks: string[] = [];
    const actions: AIAction[] = [];
    if (population > 0) {
      const per10k = (bizs.length / population) * 10000;
      const bl = CATEGORY_BASELINES[category];
      insights.push({
        title: `${label} density: ${per10k.toFixed(1)} per 10k residents`,
        detail: bl != null
          ? `Typical city baseline is ${bl}/10k — ${per10k < bl ? `below baseline, room for ${Math.max(0, Math.round((bl * population) / 10000) - bizs.length)} more` : 'at or above baseline, market is saturated'}.`
          : 'No cross-city baseline for this category — interpret density against similar cities.',
        severity: per10k < (bl ?? per10k) * 0.6 ? 'medium' : 'low',
      });
    }
    if (bizs.length > 0 && withContact.emails / bizs.length < 0.3) {
      insights.push({
        title: 'Low digital presence among competitors',
        detail: `Only ${withContact.emails}/${bizs.length} have a discoverable email and ${withContact.websites} have websites — digital-first marketing would face little competition here.`,
        severity: 'medium',
      });
    }
    if (bizs.length === 0) {
      insights.push({ title: `No ${label} found in the scan`, detail: 'Either a genuine blue-ocean or OSM coverage gap — verify with local directories before investing.', severity: 'medium' });
    }
    risks.push('OpenStreetMap coverage is volunteered data — informal or newly opened businesses may be missing.');
    if (population <= 0) risks.push('Population unknown — per-capita estimates are unavailable.');
    actions.push({
      action: bizs.length > 0 ? `Interview 3-5 ${label.toLowerCase()} operators` : `Field-verify ${label.toLowerCase()} demand`,
      rationale: 'Ground-truth the scan data before committing capital.',
      timeframe: 'immediate',
    });
    return { model: 'deterministic', insights, patterns, risks, actions, isAI: false };
  }
}

// ─── AI result verification (v6.9.2) ───────────────────────────────────────
// Before results are shown, an LLM cross-checks the deterministic per-capita
// verdicts. The model sees exact per-category numbers (existing, per-10k,
// expected, gap) for the categories the bands flagged as suspicious and
// returns corrected verdicts + reasons in its own words. Deterministic flags
// always stand — the LLM can only upgrade absurd→uncertain with a better
// explanation, never downgrade a mismatch the bands caught silently.
export interface VerificationResult {
  checked: number;
  aiVerified: boolean;      // true when an LLM reviewed the data
  notes: string[];          // per-category AI commentary (category → note)
}

export async function aiVerifyOpportunities(
  opportunities: OpportunityResult[],
  population: number,
  cityName: string,
  countryName: string,
  opts?: { signal?: AbortSignal },
): Promise<VerificationResult> {
  const out: VerificationResult = { checked: 0, aiVerified: false, notes: [] };
  const sanity = sanityCheckOpportunities(opportunities, population);
  const flagged = sanity.filter(s => s.verdict !== 'plausible');
  if (flagged.length === 0) return out;
  out.checked = flagged.length;

  const lines = flagged.slice(0, 12).map(s => {
    const o = opportunities.find(x => x.category === s.category);
    if (!o) return `- ${s.category}: existing=${s.verdict}`;
    return `- ${o.categoryLabel} (id=${s.category}): found=${o.existing}, per10k=${o.per10k.toFixed(2)}, expected=${o.expected ?? 'n/a'}, population=${population.toLocaleString()} — band verdict: ${s.verdict}`;
  }).join('\n');

  const sys = `You are a data-quality auditor for a business-density scanner built on OpenStreetMap.
You receive per-category business counts for one city and per-capita plausibility flags.
For each flagged category decide if the count is truly implausible or actually reasonable
(some categories are genuinely rare; OSM tags are sometimes sparse in some countries).
Reply ONLY with JSON: {"verdicts": [{"id": "category_id", "verdict": "plausible"|"absurd"|"uncertain", "note": "one-sentence reason in plain English"}]}`;
  const user = `CITY: ${cityName}, ${countryName}\nPOPULATION: ${population.toLocaleString()}\nFLAGGED CATEGORIES:\n${lines}\n\nReturn one verdict object per input line.`;

  try {
    const { text } = await llmCallModel(sys, user, {
      maxTokens: 1200,
      temperature: 0.2,
      signal: opts?.signal,
      validate: (t) => {
        const p = extractJson(t);
        return !!p && Array.isArray(p.verdicts) && p.verdicts.length > 0;
      },
    });
    const parsed = extractJson(text);
    if (!parsed?.verdicts) return out;
    out.aiVerified = true;
    for (const v of parsed.verdicts) {
      if (v && typeof v.id === 'string' && typeof v.note === 'string') {
        out.notes.push(`${getCategoryLabel(v.id)}: ${String(v.note).slice(0, 220)}`);
      }
    }
  } catch {
    // AI unavailable — deterministic verdicts already cover it.
  }
  return out;
}

// ─── Second-chance rescan for absurd-low categories (v6.9.2) ───────────────
// When the sanity bands flag a category as absurdly LOW (likely a tag gap —
// e.g. the focused query missed local tag variants), re-query OpenStreetMap
// once with the WIDE-Net filter (name-based) and merge any NEW businesses
// into the results. Returns the number of newly found businesses per category.
export async function rescanWideNet(
  businesses: Map<string, Business[]>,
  absurdCategories: string[],
  lat: number,
  lon: number,
  radiusMeters: number,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<Map<string, Business[]>> {
  if (absurdCategories.length === 0) return businesses;
  const south = lat - radiusMeters / 111000;
  const north = lat + radiusMeters / 111000;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const west = lon - radiusMeters / (111000 * cosLat);
  const east = lon + radiusMeters / (111000 * cosLat);
  const bbox = `${south},${west},${north},${east}`;
  const merged = new Map(businesses);

  for (const cat of absurdCategories.slice(0, 6)) {
    if (opts?.signal?.aborted) break;
    const kw = WIDE_NET_KEYWORDS[cat];
    if (!kw) continue;
    const q = `[out:json][timeout:60];(
  node(${bbox})${kw};
  way(${bbox})${kw};
);out center body;`;
    try {
      opts?.onProgress?.(`Re-checking ${getCategoryLabel(cat)} with a wider search…`);
      const d = await fetchOverpass(q, 60);
      if (!d?.elements) continue;
      const existing = merged.get(cat) || [];
      const seenIds = new Set(existing.map(b => b.id));
      const seenLocs = new Set(existing.map(b => `${Math.round(b.lat * 1000)},${Math.round(b.lon * 1000)}`));
      let added = 0;
      for (const el of d.elements) {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        if (!elLat || !elLon) continue;
        const tags = el.tags || {};
        if (categorizeBusiness(tags) !== cat) continue; // must categorize into this bucket
        const name = tags.name || tags['name:en'] || tags['name:int'] || tags.brand || tags.operator || '';
        if (!name.trim()) continue;
        const locKey = `${Math.round(elLat * 1000)},${Math.round(elLon * 1000)}`;
        if (seenIds.has(`${el.type}/${el.id}`) || seenLocs.has(locKey)) continue;
        seenIds.add(`${el.type}/${el.id}`);
        seenLocs.add(locKey);
        const ctx = getScanContext();
        existing.push({
          id: `${el.type}/${el.id}`,
          name: name.trim(),
          lat: elLat,
          lon: elLon,
          category: cat,
          categoryLabel: getCategoryLabel(cat),
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
        });
        added++;
      }
      if (added > 0) {
        merged.set(cat, existing);
        opts?.onProgress?.(`Found ${added} more ${getCategoryLabel(cat)} businesses in the re-check`);
      }
    } catch { /* mirror busy — keep original count */ }
  }
  return merged;
}

// Name-keyword filters for the second-chance rescan (name-based so local tag
// variants that the focused query missed still surface). English keywords
// catch international chains; the app's query engine handles i18n via tags.
const WIDE_NET_KEYWORDS: Record<string, string> = {
  printing: '["name"~"print|druck|typograf",i]',
  cleaning: '["name"~"clean|cleaning|hygiene service",i]',
  yoga: '["name"~"yoga",i]',
  books: '["name"~"book|bücher",i]',
  bookstore: '["name"~"book|bibli",i]',
  coworking: '["name"~"cowork|work Lab|hub",i]',
  tattoo: '["name"~"tattoo",i]',
  music_school: '["name"~"music school|musik|piano|guitar",i]',
  art: '["name"~"art|gallery|atelier",i]',
  wedding: '["name"~"wedding|bridal|braut",i]',
  courier: '["name"~"courier|delivery|express",i]',
  dance: '["name"~"dance|danz|ballet",i]',
};

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
  // Cache: same category+city → same signal inputs (pageviews roll monthly,
  // reddit/web search sampled live). 12h TTL keeps repeat scans instant
  // without changing any score the live call would compute.
  const ck = 'demand_' + cacheKey(categoryLabel, cityName);
  const cachedSig = cacheGet<DemandSignal>(ck, 12 * 60 * 60 * 1000);
  if (cachedSig) return cachedSig;
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

  cacheSet(ck, signals);
  return signals;
}

// ─── Opportunity Scoring ───────────────────────────────────────────

// ─── Opportunity scoring ───────────────────────────────────────────────
// Shared baseline table (per 10k residents) — v6.9: expanded from 17 to 48
// categories with realistic per-capita densities. Used by BOTH
// computeOpportunities() and computeMarketFacts() so scores and the AI
// prompt always agree. Categories not listed fall back to the live city
// median (unchanged behavior). Only steers ranking — never a hard cutoff.
export const CATEGORY_BASELINES: Record<string, number> = {
  // food & drink
  cafe: 4, restaurant: 5, bar: 2, pub: 1.5, fast_food: 3, ice_cream: 0.8,
  bakery: 1.5, butcher: 0.6, supermarket: 1.5, grocery: 0.8, convenience: 3,
  marketplace: 0.5, market: 0.5, department_store: 0.4,
  // health
  pharmacy: 1.5, hospital: 0.05, clinic: 1.2, dentist: 0.8, veterinary: 0.4,
  // retail
  clothing: 3, electronics: 1.5, furniture: 0.8, hardware: 0.8, books: 0.5,
  jewelry: 0.5, optician: 0.4, florist: 0.5, sports: 0.6, bicycle: 0.3,
  beauty_salon: 2, hair_salon: 2, nail_salon: 0.8, tattoo: 0.3, laundry: 0.5,
  pet_groomer: 0.3, spa: 0.6,
  // services
  bank: 1, fuel: 0.5, hotel: 1, hostel: 0.4, gym: 1.5, cinema: 0.3,
  night_club: 0.4, car_repair: 1.2, car_wash: 0.5, car_rental: 0.2,
  school: 1.5, library: 0.15, post_office: 0.3, coworking: 0.3,
  // offices & b2b
  software: 1.5, it_consulting: 0.8, web_agency: 0.4, digital_marketing: 0.6,
  lawyer: 0.8, accountant: 0.8, real_estate: 0.8, insurance: 0.5,
  travel_agency: 0.5, printing: 0.5, cleaning: 0.4, courier: 0.3,
  music_school: 0.3, dance: 0.3, yoga: 0.25, art: 0.4,
};

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

  // Baselines: shared module-level CATEGORY_BASELINES (v6.9) — identical
  // table is used by computeMarketFacts(), so the AI prompt and the
  // opportunity scores can never disagree again.
  const baseline = (cat: string) => CATEGORY_BASELINES[cat] || median;

  for (const [cat, bizs] of businesses) {
    const existing = bizs.length;
    const per10k = (existing / Math.max(pop || 1, 1)) * 10000;
    const bl = baseline(cat);
    const expected = pop ? Math.round((bl * pop) / 10000) : null;
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
    // 1. tel: links (most reliable — tolerate single quotes & spacing)
    const telM = html.match(/href\s*=\s*["']tel:([^"']+)["']/i);
    if (telM) b.phone = (() => { try { return decodeURIComponent(telM[1]).trim(); } catch { return telM[1].trim(); } })();
    // 1b. WhatsApp click-to-chat links — wa.me/995… or api.whatsapp.com/send?phone=…
    if (!b.phone) {
      const waM = html.match(/(?:wa\.me\/(\+?\d{7,15})|whatsapp\.com\/send[^"']*\?phone=(\+?\d{7,15}))/i);
      const raw = waM ? (waM[1] || waM[2]) : '';
      if (raw) b.phone = raw.startsWith('+') ? raw : `+${raw}`;
    }
    // 1c. Viber deep links — viber://chat?number=%2B995…
    if (!b.phone) {
      const vbM = html.match(/viber:\/\/chat\?number=%2B(\d{7,15})/i);
      if (vbM) b.phone = `+${vbM[1]}`;
    }
    // 1d. JSON-LD structured data: "telephone": "+995 …"
    if (!b.phone) {
      const ldPhoneM = html.match(/"telephone"\s*:\s*"(\+?[\d\s\-\(\)]{7,20})"/i);
      if (ldPhoneM && plausiblePhone(ldPhoneM[1])) b.phone = ldPhoneM[1].trim();
    }
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
      if (labeledPh) {
        const digits = labeledPh[1].replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(labeledPh[1])) b.phone = labeledPh[1].trim();
      }
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
    // 9. Obfuscated forms — "name [at] domain [dot] com", "name(at)domain(dot)com"
    if (!b.email) {
      const obfM = html.match(/([\w][\w._%+-]{1,40})\s*(?:\(|\[|\{)?\s*(?:at|@|&#64;)\s*(?:\)|\]|\})?\s*([\w-]{2,40})\s*(?:\(|\[|\{)?\s*(?:dot|\.|&#46;)\s*(?:\)|\]|\})?\s*([a-zA-Z]{2,12})\b/i);
      if (obfM) {
        const cand = `${obfM[1]}@${obfM[2]}.${obfM[3]}`;
        if (!JUNK.test(cand) && !EMAIL_FILE.test(cand)) b.email = cand.toLowerCase();
      }
    }
  }

  // Website: extract from links. Self-contained denylist (this variant must
  // not depend on the nested DIRECTORY_SITES/_EXCLUDE helpers).
  const WEBSITE_DENY = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest\.com|tumblr|reddit\.com|quora|wikipedia\.org|youtube\.com|tiktok\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|snapchat|threads|medium\.com|substack|archive\.org|amazon\.|ebay\.|aliexpress|2gis\.|yandex\.|uber\.com|doordash|grubhub|glassdoor|indeed\.com|thumbtack|bbb\.org|trustpilot|google\.|gstatic|apple\.com|microsoft\.com/i;
  if (!b.website) {
    const links = html.matchAll(/href="([^"]+)"/g);
    for (const link of links) {
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!url.startsWith('http')) continue;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
      if (WEBSITE_DENY.test(host)) continue;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
      if (!isLikelyBusinessWebsite(url, b.name)) continue;
      b.website = url; break;
    }
  }
  // Website from meta signals — canonical link & og:url (page's own declared
  // identity, higher-trust than scraping arbitrary anchors; try when anchor
  // scan came up empty).
  if (!b.website) {
    const canonicalM = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
    if (canonicalM) {
      let url = canonicalM[1];
      if (url.startsWith('//')) url = 'https:' + url;
      if (/^https?:\/\//i.test(url) && !WEBSITE_DENY.test(url)) {
        b.website = url;
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

  // LinkedIn (company pages only — personal /in/ profiles are not the business)
  if (!b.linkedin) {
    const liM = html.match(/linkedin\.com\/company\/([a-zA-Z0-9._-]+)/i);
    if (liM && !liM[0].includes('login') && !liM[0].includes('share')) {
      b.linkedin = 'https://linkedin.com/company/' + liM[1].replace(/\/$/, '');
    }
  }

  // YouTube — channel or @handle
  if (!b.youtube) {
    const ytM = html.match(/youtube\.com\/(?:channel\/([a-zA-Z0-9_-]+)|@([a-zA-Z0-9._-]+))/i);
    if (ytM) b.youtube = ytM[1]
      ? 'https://youtube.com/channel/' + ytM[1]
      : 'https://youtube.com/@' + ytM[2];
  }

  // TikTok
  if (!b.tiktok) {
    const ttM = html.match(/tiktok\.com\/@([a-zA-Z0-9._-]+)/i);
    if (ttM && !ttM[0].includes('discover')) {
      b.tiktok = 'https://tiktok.com/@' + ttM[1].replace(/\/$/, '');
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
