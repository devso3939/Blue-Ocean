"use strict";

// src/__shim.ts
if (!globalThis.document) {
  globalThis.document = { hidden: false };
}

// src/clientEngine.ts
var import_meta = {};
async function resolveCity(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5&extratags=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await directFetch(url, { headers: { "Accept": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(8e3) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const data = await res.json();
    if (!data.length) throw new Error(`No results found for "${query}"`);
    return data.map((r) => {
      const bbox = r.boundingbox.map(Number);
      const pop = r.extratags?.population ? parseInt(r.extratags.population) : null;
      return {
        name: r.address?.city || r.address?.town || r.address?.village || r.address?.municipality || r.display_name.split(",")[0],
        country: r.address?.country || "",
        countryCode: r.address?.country_code?.toUpperCase() || "",
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        population: pop,
        bbox: [bbox[0], bbox[2], bbox[1], bbox[3]]
      };
    });
  }
  throw new Error("Nominatim rate limit \u2014 try again in a few seconds");
}
var CATEGORY_QUERIES = {
  cafe: { label: "Cafe" },
  restaurant: { label: "Restaurant" },
  bar: { label: "Bar" },
  pub: { label: "Pub" },
  fast_food: { label: "Fast Food" },
  hotel: { label: "Hotel" },
  gym: { label: "Gym / Fitness" },
  beauty_salon: { label: "Beauty Salon" },
  hair_salon: { label: "Hair Salon" },
  pharmacy: { label: "Pharmacy" },
  hospital: { label: "Hospital" },
  clinic: { label: "Clinic" },
  dentist: { label: "Dentist" },
  supermarket: { label: "Supermarket" },
  grocery: { label: "Grocery Store" },
  clothing: { label: "Clothing Store" },
  electronics: { label: "Electronics Store" },
  furniture: { label: "Furniture Store" },
  hardware: { label: "Hardware Store" },
  bank: { label: "Bank" },
  school: { label: "School" },
  cinema: { label: "Cinema" },
  bakery: { label: "Bakery" },
  car_repair: { label: "Car Repair" },
  laundry: { label: "Laundry" },
  pet_groomer: { label: "Pet Groomer" },
  coworking: { label: "Coworking Space" },
  library: { label: "Library" },
  post_office: { label: "Post Office" },
  spa: { label: "Spa" },
  hostel: { label: "Hostel" },
  car_rental: { label: "Car Rental" },
  jewelry: { label: "Jewelry Store" },
  sports: { label: "Sports Store" },
  books: { label: "Bookstore" },
  mobile_phone: { label: "Mobile Phone Store" },
  convenience: { label: "Convenience Store" },
  department_store: { label: "Department Store" },
  ice_cream: { label: "Ice Cream Shop" },
  art: { label: "Art Gallery" },
  bicycle: { label: "Bicycle Shop" },
  night_club: { label: "Nightclub" },
  veterinary: { label: "Veterinary" },
  florist: { label: "Florist" },
  optician: { label: "Optician" },
  butcher: { label: "Butcher" },
  marketplace: { label: "Marketplace" },
  wedding: { label: "Wedding Venue" },
  fuel: { label: "Gas Station" },
  web_agency: { label: "Web Agency" },
  software: { label: "Software Company" },
  it_consulting: { label: "IT Consulting" },
  digital_marketing: { label: "Digital Marketing" },
  lawyer: { label: "Law Firm" },
  accountant: { label: "Accounting" },
  real_estate: { label: "Real Estate" },
  insurance: { label: "Insurance" },
  travel_agency: { label: "Travel Agency" },
  printing: { label: "Printing Shop" },
  nail_salon: { label: "Nail Salon" },
  tattoo: { label: "Tattoo Parlor" },
  car_wash: { label: "Car Wash" },
  market: { label: "Local Market" },
  dance: { label: "Dance Studio" },
  music_school: { label: "Music School" },
  cleaning: { label: "Cleaning Service" },
  courier: { label: "Courier Service" }
};
function getCategoryLabel(id) {
  return CATEGORY_QUERIES[id]?.label || id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function categorizeBusiness(tags) {
  const a = tags.amenity;
  const s = tags.shop;
  const t = tags.tourism;
  const l = tags.leisure;
  if (s === "beauty" || s === "cosmetics") {
    const nm = (tags.name || tags["name:en"] || "").toLowerCase();
    if (/(nail|manikюр|pedikюр)/.test(nm)) return "nail_salon";
    return "beauty_salon";
  }
  if (s === "hairdresser" || s === "wigs") return "hair_salon";
  if (s === "tattoo" || s === "tattoo_piercing") return "tattoo";
  if (s === "printing" || s === "print") return "printing";
  if (s === "market") return "market";
  if (s === "nail_salon") return "nail_salon";
  if (s === "supermarket" || s === "greengrocer" || s === "deli") return "supermarket";
  if (s === "grocery" || s === "health_food") return "grocery";
  if (s === "convenience" || s === "kiosk" || s === "newsagent") return "convenience";
  if (s === "clothes" || s === "fashion" || s === "boutique") return "clothing";
  if (s === "shoes" || s === "shoe") return "clothing";
  if (s === "electronics" || s === "mobile_phone" || s === "computer" || s === "hifi") return "electronics";
  if (s === "furniture" || s === "interior_decoration") return "furniture";
  if (s === "doityourself" || s === "trade" || s === "hardware") return "hardware";
  if (s === "bakery" || s === "pastry") return "bakery";
  if (s === "butcher") return "butcher";
  if (s === "florist") return "florist";
  if (s === "optician" || s === "eyewear") return "optician";
  if (s === "car_repair" || s === "car_parts") return "car_repair";
  if (s === "laundry" || s === "dry_cleaning") return "laundry";
  if (s === "pet_grooming" || s === "pet") return "pet_groomer";
  if (s === "jewelry" || s === "jewellery" || s === "watches") return "jewelry";
  if (s === "sports" || s === "outdoor") return "sports";
  if (s === "books" || s === "stationery") return "books";
  if (s === "department_store") return "department_store";
  if (s === "art") return "art";
  if (s === "bicycle") return "bicycle";
  if (s === "fuel") return "fuel";
  if (a === "cafe") return "cafe";
  if (a === "restaurant") return "restaurant";
  if (a === "bar" || a === "biergarten") return "bar";
  if (a === "pub") return "pub";
  if (a === "fast_food" || a === "food_court") return "fast_food";
  if (a === "ice_cream") return "ice_cream";
  if (a === "pharmacy" || a === "chemist") return "pharmacy";
  if (a === "hospital") return "hospital";
  if (a === "clinic" || a === "doctors") return "clinic";
  if (a === "dentist") return "dentist";
  if (a === "bank") return "bank";
  if (a === "school" || a === "college" || a === "university") return "school";
  if (a === "cinema") return "cinema";
  if (a === "veterinary") return "veterinary";
  if (a === "library") return "library";
  if (a === "post_office") return "post_office";
  if (a === "car_rental") return "car_rental";
  if (a === "nightclub" || a === "casino") return "night_club";
  if (a === "music_school" || a === "dancing_school" || a === "arts_centre") return "music_school";
  if (a === "spa" || a === "sauna") return "spa";
  if (a === "marketplace") return "marketplace";
  if (a === "fuel") return "fuel";
  if (tags.craft === "bakery") return "bakery";
  if (tags.craft === "car_repair" || tags.craft === "car_paint") return "car_repair";
  if (tags.craft === "tailor" || tags.craft === "dressmaker") return "clothing";
  if (tags.craft === "jeweler") return "jewelry";
  if (tags.craft === "optician") return "optician";
  if (tags.craft === "florist") return "florist";
  if (tags.healthcare === "dentist") return "dentist";
  if (tags.healthcare === "clinic" || tags.healthcare === "doctor") return "clinic";
  if (tags.healthcare === "pharmacy") return "pharmacy";
  if (tags.healthcare === "hospital") return "hospital";
  if (tags.healthcare === "physiotherapist") return "clinic";
  if (t === "hotel" || t === "motel" || t === "apartment") return "hotel";
  if (t === "hostel") return "hostel";
  if (t === "guest_house") return "hotel";
  if (l === "fitness_centre" || l === "sports_centre" || l === "sports_hall" || l === "swimming_pool") {
    const nameLower2 = (tags.name || tags["name:en"] || "").toLowerCase();
    if (/(yoga|pilates)/.test(nameLower2)) return "yoga";
    return "gym";
  }
  if (a === "car_wash") return "car_wash";
  if (tags.office === "coworking") return "coworking";
  if (tags.office === "lawyer" || tags.office === "attorney") return "lawyer";
  if (tags.office === "accountant") return "accountant";
  if (tags.office === "estate_agent" || tags.office === "real_estate") return "real_estate";
  if (tags.office === "insurance") return "insurance";
  if (tags.office === "travel_agent") return "travel_agency";
  if (tags.office === "it" || tags.office === "software") return "software";
  if (tags.office === "consulting") return "it_consulting";
  if (tags.office === "marketing" || tags.office === "advertising") return "digital_marketing";
  if (tags.office === "telecommunication") return "web_agency";
  const nameLower = (tags.name || tags["name:en"] || "").toLowerCase();
  if (!tags.office && nameLower) {
    if (/(law|legal|attorney|advo[ck]at)/.test(nameLower)) return "lawyer";
    if (/(account|buh|finance|audit)/.test(nameLower)) return "accountant";
    if (/(real.?estate|property|immobili)/.test(nameLower)) return "real_estate";
    if (/(insur|strakhov)/.test(nameLower)) return "insurance";
    if (/(travel|tur|tour|travel)/.test(nameLower)) return "travel_agency";
    if (/(clean|ubor|cleaning)/.test(nameLower)) return "cleaning";
    if (/(car.?wash|moyk[ae]|автомойк)/.test(nameLower)) return "car_wash";
    if (/(nail|manikюр|pedikюр)/.test(nameLower)) return "nail_salon";
    if (/(yoga|pilates)/.test(nameLower)) return "yoga";
  }
  return null;
}
function extractPhone(tags) {
  return tags.phone || tags["contact:phone"] || tags["contact:mobile"] || tags["phone:mobile"] || tags["phone:international"] || tags["contact:landline"] || tags["contact:fax"] || tags["contact:whatsapp"] || tags["contact:viber"] || "";
}
function extractEmail(tags) {
  return tags.email || tags["contact:email"] || tags["email:office"] || "";
}
function extractWebsite(tags) {
  return tags.website || tags["contact:website"] || tags.url || "";
}
function extractFacebook(tags) {
  const raw = tags["contact:facebook"] || tags.facebook || "";
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  if (raw.startsWith("www.")) return `https://${raw}`;
  return `https://facebook.com/${raw.replace(/^\/+/, "")}`;
}
function extractInstagram(tags) {
  const raw = tags["contact:instagram"] || tags.instagram || "";
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  return `https://instagram.com/${raw.replace(/^@+/, "")}`;
}
function extractLinkedIn(tags) {
  const raw = tags["contact:linkedin"] || tags.linkedin || "";
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  return `https://linkedin.com/company/${raw.replace(/^@+/, "")}`;
}
function extractYouTube(tags) {
  const raw = tags["contact:youtube"] || tags.youtube || "";
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  return `https://youtube.com/@${raw.replace(/^@+/, "")}`;
}
function extractTikTok(tags) {
  const raw = tags["contact:tiktok"] || tags.tiktok || "";
  if (!raw) return "";
  if (raw.startsWith("http")) return raw;
  return `https://tiktok.com/@${raw.replace(/^@+/, "")}`;
}
function formatAddress(tags) {
  const parts = [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"], tags["addr:postcode"]].filter(Boolean);
  return parts.join(", ") || "";
}
var OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  // Independent infrastructure: different operators = different rate-limit
  // pools, so heavy scans on one don't poison the others. (lz4 was removed:
  // it shares infrastructure and bans with overpass-api.de, adding a mirror
  // that is already banned just wastes the retry window.)
  "https://overpass.osm.jp/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];
function wait(ms) {
  if (isCancelled()) throw new Error("Cancelled");
  return new Promise((resolve, reject) => {
    if (!document.hidden) {
      const timer = setTimeout(() => {
        if (isCancelled()) {
          reject(new Error("Cancelled"));
          return;
        }
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Cancelled"));
      };
      _cancelSignal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => _cancelSignal?.removeEventListener("abort", onAbort), ms + 50);
      return;
    }
    const interval = Math.min(ms, 100);
    let elapsed = 0;
    const poll = () => {
      if (isCancelled()) {
        reject(new Error("Cancelled"));
        return;
      }
      elapsed += interval;
      if (elapsed >= ms || !document.hidden) {
        resolve();
        return;
      }
      setTimeout(poll, interval);
    };
    setTimeout(poll, interval);
  });
}
var _cancelSignal = null;
function setCancelSignal(signal) {
  _cancelSignal = signal;
}
function isCancelled() {
  return _cancelSignal?.aborted ?? false;
}
var _lastProxyFail = 0;
async function corsFetch(url, init) {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", ...init?.headers };
  const callerSignal = init?.signal;
  try {
    const r = await fetch(url, { ...init, headers });
    if (r.ok) return r;
  } catch {
  }
  if (callerSignal?.aborted) throw new Error("Cancelled");
  if (Date.now() - _lastProxyFail < 3e4) {
    return new Response("", { status: 0, statusText: "CORS unavailable" });
  }
  try {
    const r = await fetch("https://cors.sh/" + url, { headers, signal: AbortSignal.timeout(5e3) });
    if (r.ok) return r;
  } catch {
  }
  try {
    const r = await fetch("https://api.allorigins.win/get?url=" + encodeURIComponent(url), { headers, signal: AbortSignal.timeout(5e3) });
    if (r.ok) {
      const json = await r.json();
      return new Response(json.contents || "", { status: 200, headers: { "Content-Type": "text/html" } });
    }
  } catch {
  }
  _lastProxyFail = Date.now();
  return new Response("", { status: 0, statusText: "CORS unavailable" });
}
async function directFetch(url, init) {
  return fetch(url, { ...init, headers: { "User-Agent": "BlueOcean/5.0.0 (https://devso3939.github.io/Blue-Ocean; contact@blueocean.app)", ...init?.headers } });
}
var CAT_OSM_FILTER = {
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
  massage: '["leisure"~"spa|sauna"]'
};
var _overpassExhausted = false;
async function fetchOverpass(query, timeoutSec = 60, onWait) {
  _overpassExhausted = false;
  const tryAllMirrors = async () => {
    for (let mi = 0; mi < OVERPASS_MIRRORS.length; mi++) {
      const mirror = OVERPASS_MIRRORS[mi];
      const attempts = mi < 2 ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), (timeoutSec + 15) * 1e3);
          const res = await fetch(mirror, {
            method: "POST",
            body: `data=${encodeURIComponent(query)}`,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            signal: controller.signal
          });
          clearTimeout(timer);
          if (res.status === 429 || res.status === 504) {
            if (attempt < attempts - 1) await wait(1e4);
            continue;
          }
          if (!res.ok) {
            if (attempt < attempts - 1) await wait(3e3);
            continue;
          }
          const text = await res.text();
          if (!text.trim().startsWith("{")) {
            if (attempt < attempts - 1) await wait(5e3);
            continue;
          }
          const data2 = JSON.parse(text);
          if (data2.elements === void 0) continue;
          return data2;
        } catch (e) {
          if (attempt < attempts - 1) await wait(2e3);
          continue;
        }
      }
      if (mi < OVERPASS_MIRRORS.length - 1) await wait(2e3);
    }
    return null;
  };
  let data = await tryAllMirrors();
  if (!data) {
    onWait?.("OpenStreetMap servers are busy \u2014 waiting 40s before retrying\u2026");
    await wait(4e4);
    data = await tryAllMirrors();
  }
  if (!data) {
    onWait?.("Still busy \u2014 waiting 2 minutes for a final retry\u2026");
    await wait(12e4);
    data = await tryAllMirrors();
  }
  if (data) return data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75e3);
    const res = await directFetch(OVERPASS_MIRRORS[0], {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const text = await res.text();
      if (text.trim().startsWith("{")) {
        const data2 = JSON.parse(text);
        if (data2.elements !== void 0) return data2;
      }
    }
  } catch {
  }
  _overpassExhausted = true;
  return null;
}
async function queryBusinesses(lat, lon, radiusMeters = 1e4, onProgress, categoryFilter, skipEnrichment, onEnrichProgress) {
  const results = /* @__PURE__ */ new Map();
  const south = lat - radiusMeters / 111e3;
  const north = lat + radiusMeters / 111e3;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const west = lon - radiusMeters / (111e3 * cosLat);
  const east = lon + radiusMeters / (111e3 * cosLat);
  const bbox = `${south},${west},${north},${east}`;
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
  const qShops = `[out:json][timeout:90][maxsize:536870912];
(
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;
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
  const allElements = [];
  if (categoryFilter && CAT_OSM_FILTER[categoryFilter]) {
    const filter = CAT_OSM_FILTER[categoryFilter];
    const qFocused = `[out:json][timeout:90][maxsize:536870912];
(
  node(${bbox})${filter};
  way(${bbox})${filter};
);
out center body;`;
    onProgress?.(10, `Scanning for ${getCategoryLabel(categoryFilter)}\u2026`);
    const d = await fetchOverpass(qFocused, 90, (msg) => onProgress?.(15, msg));
    if (d?.elements) allElements.push(...d.elements);
    const hasRequestedCategory = allElements.some(
      (el) => categorizeBusiness(el.tags || {}) === categoryFilter
    );
    if (!hasRequestedCategory) {
      onProgress?.(50, "Retrying with broader query\u2026");
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
    onProgress?.(10, "Scanning food, healthcare & entertainment\u2026");
    const d1 = await fetchOverpass(qFood, 90, (msg) => onProgress?.(15, msg));
    if (d1?.elements) allElements.push(...d1.elements);
    await wait(1500);
    onProgress?.(30, "Scanning shops & retail\u2026");
    const d2 = await fetchOverpass(qShops, 90, (msg) => onProgress?.(35, msg));
    if (d2?.elements) allElements.push(...d2.elements);
    await wait(1500);
    onProgress?.(50, "Scanning hotels, gyms & services\u2026");
    const d3 = await fetchOverpass(qOther, 60, (msg) => onProgress?.(55, msg));
    if (d3?.elements) allElements.push(...d3.elements);
    if (allElements.length === 0) {
      onProgress?.(60, "Retrying with minimal query\u2026");
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
  onProgress?.(60, "Categorizing businesses\u2026");
  if (allElements.length === 0) {
    const rateLimited = _overpassExhausted;
    onProgress?.(70, rateLimited ? "OpenStreetMap servers could not be reached (rate limited or busy). Please retry in a minute." : "No businesses found from OpenStreetMap");
    if (rateLimited) throw new Error("OpenStreetMap servers are rate-limiting requests. Wait a minute and retry.");
    return results;
  }
  const seenLocations = /* @__PURE__ */ new Map();
  for (const el of allElements) {
    const elLat = el.lat || el.center?.lat;
    const elLon = el.lon || el.center?.lon;
    if (!elLat || !elLon) continue;
    const tags = el.tags || {};
    const category = categorizeBusiness(tags);
    if (!category) continue;
    const name = tags.name || tags["name:en"] || tags["name:int"] || tags.brand || tags.operator || "";
    if (!name.trim()) continue;
    const locKey = `${Math.round(elLat * 1e3)},${Math.round(elLon * 1e3)},${category}`;
    if (seenLocations.has(locKey)) continue;
    seenLocations.set(locKey, category);
    const business = {
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
      brand: tags.brand || "",
      cuisine: tags.cuisine || "",
      facebook: extractFacebook(tags),
      instagram: extractInstagram(tags),
      linkedin: extractLinkedIn(tags),
      youtube: extractYouTube(tags),
      tiktok: extractTikTok(tags),
      rating: 0,
      reviewCount: 0,
      hours: tags.opening_hours || "",
      twitter: "",
      pinterest: ""
    };
    if (!results.has(category)) results.set(category, []);
    results.get(category).push(business);
  }
  const totalBiz = Array.from(results.values()).reduce((s, a) => s + a.length, 0);
  onProgress?.(70, `Found ${totalBiz} businesses \u2014 enriching data\u2026`);
  async function enrichFromSocialPlatforms(businesses, onProgress2) {
    const NEEDS = businesses.filter((b) => !b.facebook && !b.instagram);
    if (NEEDS.length === 0) return;
    const BATCH = 3;
    const max = Math.min(NEEDS.length, 80);
    let found = 0;
    for (let i = 0; i < max; i += BATCH) {
      const batch = NEEDS.slice(i, i + BATCH);
      await Promise.all(batch.map(async (b) => {
        try {
          const cityEn = getEnglishCityName(b.address?.split(",").pop()?.trim() || "");
          const nameEn2 = getEnglishCityName(b.name);
          const street = b.address ? b.address.split(",")[0]?.trim() || "" : "";
          const streetEn = getEnglishCityName(street);
          const parts = ["'" + (nameEn2 || b.name) + "'"];
          if (streetEn && streetEn !== street) parts.push(streetEn);
          if (cityEn) parts.push(cityEn);
          parts.push("facebook instagram linkedin youtube tiktok social media");
          const q = encodeURIComponent(parts.join(" "));
          const r = await corsFetch("https://html.duckduckgo.com/html/?q=" + q, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(1e4)
          });
          if (!r.ok) return;
          const html = await r.text();
          if (!b.linkedin) {
            const liMatch = html.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
            if (liMatch && !liMatch[0].includes("login")) {
              b.linkedin = "https://linkedin.com/company/" + liMatch[1];
            }
          }
          if (!b.website) {
            const ttMatch = html.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
            if (ttMatch && !ttMatch[0].includes("login")) {
              b.website = "https://tiktok.com/@" + ttMatch[1];
              found++;
            }
          }
          if (!b.website) {
            const liMatch = html.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
            if (liMatch && !liMatch[0].includes("login")) {
              b.website = "https://linkedin.com/company/" + liMatch[1];
              found++;
            }
          }
          const ytMatch = html.match(/youtube\.com\/(channel\/[^"&]+|@[^"&\s]+)/i);
          if (ytMatch && !b.website) {
            b.website = "https://" + ytMatch[0].replace(/\/$/, "");
            found++;
          }
          if (!b.facebook) {
            const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
            if (fbM && !fbM[0].includes("login") && !fbM[0].includes("sharer")) {
              b.facebook = "https://facebook.com/" + fbM[1].replace(/\/$/, "");
              found++;
            }
          }
          if (!b.instagram) {
            const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
            if (igM && !igM[0].includes("accounts")) {
              b.instagram = "https://instagram.com/" + igM[1].replace(/\/$/, "");
              found++;
            }
          }
          if (!b.phone) {
            const phM = html.match(/\+?[\d][\d\s\-\.()]{7,18}/);
            if (phM && phM[0].length >= 8) {
              const digits = phM[0].replace(/[^\d+]/g, "");
              if (digits.length >= 8) {
                b.phone = phM[0].trim();
                found++;
              }
            }
          }
          if (!b.email) {
            const emM = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emM && !emM[0].includes("example.com") && !emM[0].includes("duckduckgo")) {
              b.email = emM[0];
              found++;
            }
          }
        } catch {
        }
      }));
      if (i + BATCH < max) await wait(2e3);
      onProgress2?.(86, `Social platforms\u2026 ${Math.min(i + BATCH, max)}/${max} (${found} found)`);
    }
  }
  async function enrichFromWebsiteDeep(b) {
    if (!b.website) return;
    const EXCLUDE = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com/i;
    async function deepScrape(url) {
      try {
        let r;
        try {
          r = await fetch(url, { signal: AbortSignal.timeout(5e3), headers: { "User-Agent": "Mozilla/5.0 (compatible; BlueOcean/1.0)" } });
        } catch {
          r = await corsFetch(url, { signal: AbortSignal.timeout(5e3) });
        }
        if (!r.ok) return;
        const html = await r.text();
        const full = html.substring(0, 8e4);
        if (!b.phone || !b.email || !b.website) {
          const jsonLdBlocks = full.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
          for (const match of jsonLdBlocks) {
            try {
              const data = JSON.parse(match[1]);
              const entities = Array.isArray(data) ? data : [data];
              for (const entity of entities) {
                const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
                if (types.some((t) => /LocalBusiness|Restaurant|Bar|Cafe|Store|Hotel|Organization/i.test(t || ""))) {
                  if (!b.phone && entity.telephone) b.phone = entity.telephone;
                  if (!b.email && entity.email) b.email = entity.email;
                  if (!b.website && entity.url && !EXCLUDE.test(entity.url)) b.website = entity.url;
                  if (!b.facebook && entity.sameAs) {
                    const sameAs = Array.isArray(entity.sameAs) ? entity.sameAs : [entity.sameAs];
                    for (const s of sameAs) {
                      if (typeof s === "string") {
                        if (/facebook\.com/i.test(s) && !b.facebook) b.facebook = s;
                        if (/instagram\.com/i.test(s) && !b.instagram) b.instagram = s;
                      }
                    }
                  }
                  if (entity.address && !b.address) {
                    const a = entity.address;
                    if (typeof a === "string") b.address = a;
                    else if (a.streetAddress) b.address = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(", ");
                  }
                }
              }
            } catch {
            }
          }
        }
        if (!b.email || !b.phone) {
          const ogTags = full.matchAll(/<meta[^>]*(?:property|name)="(og:[^"]+)"[^>]*content="([^"]*)"/gi);
          for (const m of ogTags) {
            const prop = m[1].toLowerCase();
            const val = m[2];
            if (!b.email && prop === "og:email") {
              b.email = val.replace("mailto:", "");
            }
            if (!b.phone && prop === "og:phone") {
              b.phone = val;
            }
          }
        }
        if (!b.phone) {
          const telMatch = full.match(/href="tel:([^"]+)"/);
          if (telMatch) b.phone = telMatch[1].trim();
          else {
            const phoneText = full.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
            if (phoneText) {
              for (const p of phoneText) {
                if (p.replace(/[^\d+]/g, "").length >= 8 && p.replace(/[^\d+]/g, "").length <= 15) {
                  b.phone = p.trim();
                  break;
                }
              }
            }
          }
        }
        if (!b.email) {
          const mailtoMatch = full.match(/href="mailto:([^"?\s]+)/i);
          if (mailtoMatch && !EXCLUDE.test(mailtoMatch[1])) b.email = mailtoMatch[1].trim();
          if (!b.email) {
            const emails = full.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            if (emails) {
              for (const e of emails) {
                const clean = e.replace(/[\s>);]+$/, "");
                if (!EXCLUDE.test(clean) && clean.length > 6 && clean.length < 80) {
                  b.email = clean;
                  break;
                }
              }
            }
          }
          if (!b.email) {
            const encoded = full.match(/data-cfemail="([a-f0-9]+)"/i);
            if (encoded) {
              try {
                const bytes = encoded[1].match(/.{2}/g).map((h) => parseInt(h, 16));
                const key = bytes[0];
                const decoded = bytes.slice(1).map((b2) => b2 ^ key).map((b2) => String.fromCharCode(b2)).join("");
                if (decoded.includes("@") && !EXCLUDE.test(decoded)) b.email = decoded;
              } catch {
              }
            }
          }
          if (!b.email) {
            const encodedAt = full.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (encodedAt && !EXCLUDE.test(encodedAt[0])) b.email = encodedAt[1] + "@" + encodedAt[2];
          }
        }
        if (!b.facebook) {
          const fbPatterns = [
            /facebook\.com\/([a-zA-Z0-9._]+)/i,
            /fb\.com\/([a-zA-Z0-9._]+)/i,
            /facebook\.com\/pages\/[^/]+\/(\d+)/i
          ];
          for (const pat of fbPatterns) {
            const m = full.match(pat);
            if (m && !m[0].includes("login") && !m[0].includes("sharer") && !m[0].includes("dialog")) {
              b.facebook = "https://facebook.com/" + m[1].replace(/\/$/, "");
              break;
            }
          }
        }
        if (!b.instagram) {
          const igMatch = full.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
          if (igMatch && !igMatch[0].includes("accounts") && !igMatch[0].includes("explore")) {
            b.instagram = "https://instagram.com/" + igMatch[1].replace(/\/$/, "");
          }
        }
        if (!b.website) {
          const ytMatch = full.match(/youtube\.com\/(?:channel\/([^"\s&]+)|@([a-zA-Z0-9._-]+))/i);
          if (ytMatch) {
            const ytUrl = ytMatch[1] ? "https://youtube.com/channel/" + ytMatch[1] : "https://youtube.com/@" + ytMatch[2];
            b.website = ytUrl;
          }
        }
        if (!b.tiktok) {
          const ttMatch = full.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
          if (ttMatch && !ttMatch[0].includes("login")) {
            b.tiktok = "https://tiktok.com/@" + ttMatch[1];
          }
        }
        const allHrefs = [...full.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
        for (const href of allHrefs) {
          if (!b.facebook && /facebook\.com\/[^/]+/i.test(href) && !href.includes("login") && !href.includes("sharer")) {
            const fbM = href.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
            if (fbM) b.facebook = "https://facebook.com/" + fbM[1];
          }
          if (!b.instagram && /instagram\.com\/[^/]+/i.test(href) && !href.includes("accounts")) {
            const igM2 = href.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
            if (igM2) b.instagram = "https://instagram.com/" + igM2[1];
          }
          if (!b.email && /^mailto:/i.test(href)) {
            const emailAddr = href.replace(/^mailto:/i, "").split("?")[0].trim();
            if (emailAddr.includes("@") && !EXCLUDE.test(emailAddr)) b.email = emailAddr;
          }
        }
      } catch {
      }
    }
    await deepScrape(b.website);
    if (!b.email || !b.phone || !b.facebook || !b.instagram) {
      const base = b.website.replace(/\/$/, "");
      const paths = [
        "/contact",
        "/contact-us",
        "/about",
        "/about-us",
        "/kontakti",
        "/kontakt",
        "/contacte",
        "/team",
        "/info",
        "/impressum",
        "/locations",
        "/find-us",
        "/where-to-find-us",
        "/reach-us",
        "/get-in-touch",
        "/kontaktay",
        "/kavshiri",
        "/momkhmarebeli",
        "/tsmrunebi",
        "/contactos",
        "/contato",
        "/\u8054\u7CFB\u6211\u4EEC",
        "/\u304A\u554F\u3044\u5408\u308F\u305B",
        "/\u0627\u062A\u0635\u0644 \u0628\u0646\u0627",
        "/\u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C-\u043D\u0430\u043C"
      ];
      for (const path of paths) {
        if (b.email && b.phone && b.facebook) break;
        await deepScrape(base + path);
      }
    }
  }
  async function scrapeWordPressAPI(b) {
    if (!b.website || b.email && b.phone) return;
    const base = b.website.replace(/\/$/, "");
    const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org/i;
    const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
    const endpoints = ["/wp-json/", "/wp-json/wp/v2/users", "/wp-json/wp/v2/pages"];
    for (const ep of endpoints) {
      if (b.email && b.phone) break;
      try {
        const r = await corsFetch(base + ep, {
          signal: AbortSignal.timeout(4e3),
          headers: { "Accept": "application/json" }
        });
        if (!r.ok) continue;
        const text = await r.text();
        if (!b.email) {
          const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, "");
              if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) {
                b.email = clean;
                break;
              }
            }
          }
        }
        if (!b.phone) {
          const phones = text.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
          if (phones) {
            for (const p of phones) {
              if (p.replace(/[^\d+]/g, "").length >= 8 && p.replace(/[^\d+]/g, "").length <= 15) {
                b.phone = p.trim();
                break;
              }
            }
          }
        }
      } catch {
      }
    }
  }
  async function scrapeSitemapForContacts(b) {
    if (!b.website || b.email && b.phone) return;
    const base = b.website.replace(/\/$/, "");
    const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare/i;
    const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
    try {
      const r = await corsFetch(base + "/sitemap.xml", {
        signal: AbortSignal.timeout(4e3)
      });
      if (!r.ok) return;
      const xml = await r.text();
      const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
      const contactUrls = urls.filter((u) => /contact|about|team|info|impressum/i.test(u));
      for (const url of contactUrls.slice(0, 3)) {
        if (b.email && b.phone) break;
        try {
          const cr = await corsFetch(url, { signal: AbortSignal.timeout(3e3) });
          if (!cr.ok) continue;
          const html = await cr.text();
          if (!b.email) {
            const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            if (emails) {
              for (const e of emails) {
                const clean = e.replace(/[\s>);]+$/, "");
                if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) {
                  b.email = clean;
                  break;
                }
              }
            }
          }
          if (!b.phone) {
            const telM = html.match(/href="tel:([^"]+)"/);
            if (telM) b.phone = telM[1].trim();
            if (!b.phone) {
              const phones = html.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
              if (phones) {
                for (const p of phones) {
                  if (p.replace(/[^\d+]/g, "").length >= 8 && p.replace(/[^\d+]/g, "").length <= 15) {
                    b.phone = p.trim();
                    break;
                  }
                }
              }
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
  async function scrapeVCard(b) {
    if (!b.website || b.email && b.phone) return;
    const base = b.website.replace(/\/$/, "");
    try {
      const r = await corsFetch(base, { signal: AbortSignal.timeout(3e3) });
      if (!r.ok) return;
      const html = await r.text();
      const vcfLinks = [...html.matchAll(/href="([^"]*\.vcf[^"]*)"/gi)].map((m) => m[1]);
      for (const vcfUrl of vcfLinks.slice(0, 2)) {
        if (b.email && b.phone) break;
        const fullUrl = vcfUrl.startsWith("http") ? vcfUrl : base + "/" + vcfUrl.replace(/^\//, "");
        try {
          const vr = await corsFetch(fullUrl, { signal: AbortSignal.timeout(3e3) });
          if (!vr.ok) continue;
          const vcf = await vr.text();
          if (!b.email) {
            const emailM = vcf.match(/EMAIL[^:]*:([^\r\n]+)/i);
            if (emailM) b.email = emailM[1].trim();
          }
          if (!b.phone) {
            const telM = vcf.match(/TEL[^:]*:([^\r\n]+)/i);
            if (telM) b.phone = telM[1].trim();
          }
        } catch {
        }
      }
    } catch {
    }
  }
  async function enrichFromGooglePlaces(businesses, onProgress2) {
    const NEEDS = businesses.filter((b) => !b.phone || !b.website || !b.email || !b.facebook && !b.instagram);
    if (NEEDS.length === 0) return;
    const BATCH = 3;
    const max = Math.min(NEEDS.length, 50);
    let found = 0;
    for (let i = 0; i < max; i += BATCH) {
      const batch = NEEDS.slice(i, i + BATCH);
      await Promise.all(batch.map(async (b) => {
        try {
          const q = encodeURIComponent(b.name + " " + (b.address || ""));
          const r = await corsFetch("https://www.google.com/maps/search/" + q, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(1e4)
          });
          if (!r.ok) return;
          const html = await r.text();
          if (!b.phone) {
            const m = html.match(/\+\d[\d\s\-\.\(\)]{7,18}/);
            if (m && m[0].length >= 8) {
              b.phone = m[0].trim();
              found++;
            }
          }
          if (!b.website) {
            const m = html.match(/(?:www\.|https?:\/\/)([^"\s<>]+\.(com|ge|net|org|io|co)[^"\s<>]*)/i);
            if (m && !m[0].includes("google.com") && !m[0].includes("gstatic") && isLikelyBusinessWebsite(m[0], b.name)) {
              let u = m[0];
              if (!u.startsWith("http")) u = "https://" + u;
              b.website = u;
              found++;
            }
          }
          if (!b.email) {
            const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (m && !m[0].includes("example.com") && !m[0].includes("google.com")) {
              b.email = m[0];
              found++;
            }
          }
          if (!b.facebook) {
            const m = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
            if (m) {
              b.facebook = "https://facebook.com/" + m[1];
              found++;
            }
          }
          if (!b.instagram) {
            const m = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
            if (m) {
              b.instagram = "https://instagram.com/" + m[1];
              found++;
            }
          }
        } catch {
        }
      }));
      if (i + BATCH < max) await wait(3e3);
      onProgress2?.(92, "Google enrichment... " + Math.min(i + BATCH, max) + "/" + max + " (" + found + " found)");
    }
  }
  const DIRECTORY_SITES = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress|2gis\.com|yandex\.com|uber\.com|doordash|grubhub|seamless|glassdoor|indeed\.com|glassdoor|angieslist|homeadvisor|thumbtack|bbb\.org|trustpilot|sitejabber|clutch\.co|goodfirms|sortlist|brightlocal|moz\.com|semrush|ahrefs|similarweb/i;
  function isLikelyBusinessWebsite(url, businessName) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      if (DIRECTORY_SITES.test(hostname)) return false;
      if (/google|facebook|instagram|twitter|tiktok|linkedin|pinterest|reddit|youtube|amazon|ebay|apple|microsoft|github|stackoverflow/i.test(hostname)) return false;
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
      const parts = hostname.split(".");
      if (parts.length > 3) return false;
      return true;
    } catch {
      return false;
    }
  }
  function extractFromHtml(html, b) {
    const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org|privacy.*policy|terms.*service|cookie/i;
    const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
    if (!b.phone) {
      const telM = html.match(/href="tel:([^"]+)"/);
      if (telM) b.phone = (() => {
        try {
          return decodeURIComponent(telM[1]).trim();
        } catch {
          return telM[1].trim();
        }
      })();
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
      if (!b.phone) {
        const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls?|whatsapp|viber|contact)\s*[:;=\s"'>]*([+\d][\d\s\-\.()]{7,18})/i);
        if (labeledPh && labeledPh[1].replace(/[^\d]/g, "").length >= 8 && plausiblePhone(labeledPh[1])) b.phone = labeledPh[1].trim();
      }
      if (!b.phone) {
        const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
        if (phM) {
          for (const p of phM) {
            if (!p.includes("+")) continue;
            const digits = p.replace(/[^\d+]/g, "");
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(p) && !JUNK.test(p)) {
              b.phone = p.trim();
              break;
            }
          }
        }
      }
    }
    if (!b.email) {
      const contactSection = html.match(/<(?:div|section|footer|aside)[^>]*class="[^"]*contact[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|footer|aside)/i);
      if (contactSection) {
        const emails = contactSection[1].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emails) {
          for (const e of emails) {
            const clean = e.replace(/[\s>);]+$/, "");
            if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) {
              b.email = clean;
              break;
            }
          }
        }
      }
    }
    if (!b.email) {
      const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
      if (mailM && !JUNK.test(mailM[1]) && !EMAIL_FILE.test(mailM[1])) b.email = mailM[1].trim();
      if (!b.email) {
        const labelM = html.match(/(?:email|e-mail|mail|contact)\s*[:;=\s"'>]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
        if (labelM && !JUNK.test(labelM[1]) && !EMAIL_FILE.test(labelM[1])) b.email = labelM[1];
      }
      if (!b.email) {
        const jsonLdEmails = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        for (const m of jsonLdEmails) {
          try {
            const data = JSON.parse(m[1]);
            const entities = Array.isArray(data) ? data : [data];
            for (const e of entities) {
              if (e.email && !JUNK.test(e.email) && !EMAIL_FILE.test(e.email)) {
                b.email = e.email;
                break;
              }
            }
          } catch {
          }
          if (b.email) break;
        }
      }
      if (!b.email) {
        const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emails) {
          for (const e of emails) {
            const clean = e.replace(/[\s>);]+$/, "");
            if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) {
              b.email = clean;
              break;
            }
          }
        }
      }
      if (!b.email) {
        const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
        if (cfM) {
          try {
            const bytes = cfM[1].match(/.{2}/g).map((h) => parseInt(h, 16));
            const key = bytes[0];
            const decoded = bytes.slice(1).map((x) => x ^ key).map((x) => String.fromCharCode(x)).join("");
            if (decoded.includes("@") && !JUNK.test(decoded)) b.email = decoded;
          } catch {
          }
        }
      }
      if (!b.email) {
        const entM = html.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (entM && !JUNK.test(entM[0])) b.email = entM[1] + "@" + entM[2];
      }
      if (!b.email) {
        const jsEmailM = html.match(/['"]([\w][\w._%+-]*@[\w.-]+\.[a-zA-Z]{2,})['"]/);
        if (jsEmailM && !JUNK.test(jsEmailM[1]) && !EMAIL_FILE.test(jsEmailM[1]) && jsEmailM[1].length > 6) b.email = jsEmailM[1];
      }
      if (!b.email) {
        const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
        if (dataEmailM && !JUNK.test(dataEmailM[1]) && !EMAIL_FILE.test(dataEmailM[1])) b.email = dataEmailM[1];
      }
    }
    if (!b.website) {
      const links = html.matchAll(/href="([^"]+)"/g);
      const DENY = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest\.com|tumblr|reddit\.com|quora|wikipedia\.org|youtube\.com|tiktok\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|snapchat|threads|medium\.com|substack|archive\.org|amazon\.|ebay\.|aliexpress|2gis\.|yandex\.|uber\.com|doordash|grubhub|glassdoor|indeed\.com|thumbtack|bbb\.org|trustpilot|google\.|gstatic|apple\.com|microsoft\.com/i;
      for (const link of links) {
        let url = link[1];
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        if (!url.startsWith("http")) continue;
        let host = "";
        try {
          host = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          continue;
        }
        if (DENY.test(host)) continue;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
        b.website = url;
        break;
      }
    }
    if (!b.facebook) {
      const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
      if (fbM && !fbM[0].includes("login") && !fbM[0].includes("sharer") && !fbM[0].includes("dialog")) {
        b.facebook = "https://facebook.com/" + fbM[1].replace(/\/$/, "");
      }
    }
    if (!b.instagram) {
      const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
      if (igM && !igM[0].includes("accounts") && !igM[0].includes("explore")) {
        b.instagram = "https://instagram.com/" + igM[1].replace(/\/$/, "");
      }
    }
    if (!b.twitter) {
      const twM = html.match(/(?:twitter|x)\.com\/([a-zA-Z0-9._]+)/i);
      if (twM && !twM[0].includes("login") && !twM[0].includes("intent") && !twM[0].includes("share")) {
        b.twitter = "https://twitter.com/" + twM[1].replace(/\/$/, "");
      }
    }
    if (!b.pinterest) {
      const pinM = html.match(/pinterest\.com\/([a-zA-Z0-9._]+)/i);
      if (pinM && !pinM[0].includes("login")) {
        b.pinterest = "https://pinterest.com/" + pinM[1].replace(/\/$/, "");
      }
    }
    if (!b.rating) {
      const ratingM = html.match(/(?:ratingValue|rating)["\s:=]*(?:content)?["\s:=]*(\d\.\d)/i) || html.match(/(\d\.\d)\s*(?:out of|\/)\s*5/i);
      if (ratingM) {
        const val = parseFloat(ratingM[1]);
        if (val >= 1 && val <= 5) b.rating = val;
      }
    }
    if (!b.reviewCount) {
      const revM = html.match(/(?:reviewCount|ratingCount)["\s:=]+(\d+)/i) || html.match(/(\d[\d,]*)\s*reviews?/i);
      if (revM) {
        const val = parseInt(revM[1].replace(/,/g, ""));
        if (val > 0 && val < 1e5) b.reviewCount = val;
      }
    }
  }
  async function tryCommonEmailPatterns(b) {
    if (b.email || !b.website) return;
    try {
      const host = new URL(b.website).hostname.replace(/^www\./, "");
      const prefixes = ["info", "contact", "hello", "mail", "office", "admin", "support", "reception", "reservations", "booking", "sales"];
      const base = b.website.replace(/\/$/, "");
      const contactPaths = ["/contact", "/contact-us", "/about", "/about-us"];
      for (const path of contactPaths) {
        if (b.email) break;
        try {
          const r = await corsFetch(base + path, { signal: AbortSignal.timeout(3e3) });
          if (!r.ok) continue;
          const html = await r.text();
          const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, "");
              const junk = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org|duckduckgo/i;
              if (!junk.test(clean) && clean.length > 6 && clean.length < 80) {
                b.email = clean;
                break;
              }
            }
          }
        } catch {
        }
      }
      if (!b.email) {
        for (const prefix of prefixes.slice(0, 5)) {
          const guessedEmail = prefix + "@" + host;
          break;
        }
      }
    } catch {
    }
  }
  function extractFromText(text, b) {
    if (!b.phone) {
      const m = text.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
      if (m && m[0].length >= 8) b.phone = m[0].trim();
    }
    if (!b.email) {
      const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (m && !m[0].includes("example.com") && !m[0].includes("google") && !m[0].includes("facebook") && !m[0].includes("instagram")) b.email = m[0];
    }
    if (!b.facebook) {
      const m = text.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
      if (m && !m[0].includes("login") && !m[0].includes("sharer")) b.facebook = "https://facebook.com/" + m[1];
    }
    if (!b.instagram) {
      const m = text.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
      if (m && !m[0].includes("accounts")) b.instagram = "https://instagram.com/" + m[1];
    }
    if (!b.rating) {
      const ratingM = text.match(/(?:rating|stars|rated?)\s*[:=]?\s*(\d\.\d)\s*(?:\/\s*5)?/i) || text.match(/(\d\.\d)\s*(?:stars?|\/\s*5|out\s*of\s*5)/i);
      if (ratingM) {
        const val = parseFloat(ratingM[1]);
        if (val >= 1 && val <= 5) b.rating = val;
      }
    }
    if (!b.reviewCount) {
      const revM = text.match(/(\d[\d,]*)\s*(?:reviews?|ratings?)/i) || text.match(/\((\d[\d,]*)\)/);
      if (revM) {
        const val = parseInt(revM[1].replace(/,/g, ""));
        if (val > 0 && val < 1e5) b.reviewCount = val;
      }
    }
    if (!b.website) {
      const m = text.match(/youtube\.com\/(?:channel\/([a-zA-Z0-9_-]+)|@([a-zA-Z0-9._-]+))/i);
      if (m) b.website = m[1] ? "https://youtube.com/channel/" + m[1] : "https://youtube.com/@" + m[2];
    }
    if (!b.website) {
      const m = text.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9._-]+)/i);
      if (m) b.website = "https://linkedin.com/company/" + m[1];
    }
  }
  async function searchBing(query) {
    try {
      const r = await corsFetch("https://www.bing.com/search?q=" + query + "&count=10", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8e3)
      });
      if (!r.ok) return [];
      const html = await r.text();
      const results2 = [];
      const blocks = html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/gi) || [];
      for (const block of blocks) {
        const titleMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (titleMatch) {
          let url = titleMatch[1];
          if (url.includes("bing.com/ck/a")) {
            const uMatch = url.match(/u=([^&]+)/);
            if (uMatch) {
              const raw = uMatch[1];
              if (raw.startsWith("a1")) {
                try {
                  url = atob(raw.substring(2));
                } catch {
                }
              }
            }
          }
          results2.push({
            url,
            title: titleMatch[2].replace(/<[^>]+>/g, "").replace(/&#\d+;/g, ""),
            snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#\d+;/g, "") : ""
          });
        }
      }
      return results2;
    } catch {
      return [];
    }
  }
  async function searchDDGLite(query) {
    try {
      const r = await corsFetch("https://lite.duckduckgo.com/lite/?q=" + query, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8e3)
      });
      if (!r.ok) return [];
      const html = await r.text();
      const results2 = [];
      const links = html.matchAll(/<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]*)<\/a>/gi);
      for (const m of links) {
        const url = m[1];
        const title = m[2].replace(/&amp;/g, "&").replace(/&#\d+;/g, "");
        if (url.startsWith("http") && !url.includes("duckduckgo")) {
          results2.push({ url, title, snippet: "" });
        }
      }
      const snippetBlocks = html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi);
      let si = 0;
      for (const m of snippetBlocks) {
        if (si < results2.length) {
          results2[si].snippet = m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#\d+;/g, "").trim();
          si++;
        }
      }
      if (results2.length === 0) {
        const fallbackBlocks = html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
        for (const m of fallbackBlocks) {
          if (m[1].startsWith("http") && !m[1].includes("duckduckgo")) {
            results2.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, ""), snippet: "" });
          }
        }
      }
      return results2.slice(0, 10);
    } catch {
      return [];
    }
  }
  async function probeDomains(b) {
    if (b.website) return;
    const nameEn = getEnglishCityName(b.name);
    const cityEn = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
    const slugs = [];
    if (nameEn && nameEn !== b.name) {
      slugs.push(nameEn.toLowerCase().replace(/[^a-z0-9]+/g, "").substring(0, 20));
      slugs.push(nameEn.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 25));
    }
    const translit = transliterateGeo(b.name);
    if (translit !== b.name && translit !== nameEn) {
      slugs.push(translit.toLowerCase().replace(/[^a-z0-9]+/g, "").substring(0, 20));
    }
    const tlds = [".com", ".ge", ".org", ".net", ".io", ".am", ".ru", ".tr", ".fr", ".de", ".co"];
    for (const slug of slugs) {
      if (slug.length < 3) continue;
      for (const tld of tlds) {
        try {
          const domain = "https://" + slug + tld;
          const r = await corsFetch(domain, {
            method: "HEAD",
            signal: AbortSignal.timeout(4e3)
          });
          if (r.ok) {
            b.website = domain;
            return;
          }
        } catch {
        }
      }
    }
  }
  const BRAVE_API_KEY = import_meta.env?.VITE_BRAVE_API_KEY || "BSAded3tnZfvadieW5pz0tiLrlh2lvn";
  const CITY_EN_MAP = {
    // Georgian
    "\u10D7\u10D1\u10D8\u10DA\u10D8\u10E1\u10D8": "Tbilisi",
    "\u10D1\u10D0\u10D7\u10E3\u10DB\u10D8": "Batumi",
    "\u10E5\u10E3\u10D7\u10D0\u10D8\u10E1\u10D8": "Kutaisi",
    "\u10E0\u10E3\u10E1\u10D7\u10D0\u10D5\u10D8": "Rustavi",
    "\u10D6\u10E3\u10D2\u10D3\u10D8\u10D3\u10D8": "Zugdidi",
    "\u10D2\u10DD\u10E0\u10D8": "Gori",
    "\u10E4\u10DD\u10D7\u10D8": "Poti",
    "\u10E5\u10DD\u10D1\u10E3\u10DA\u10D4\u10D7\u10D8": "Kobuleti",
    "\u10D7\u10D4\u10DA\u10D0\u10D5\u10D8": "Telavi",
    "\u10E1\u10D0\u10DB\u10E2\u10E0\u10D4\u10D3\u10D8\u10D0": "Samtredia",
    "\u10E1\u10D4\u10DC\u10D0\u10D9\u10D8": "Senaki",
    "\u10EE\u10D0\u10E8\u10E3\u10E0\u10D8": "Khashuri",
    "\u10D0\u10EE\u10D0\u10DA\u10EA\u10D8\u10EE\u10D4": "Akhaltsikhe",
    "\u10DD\u10D6\u10E3\u10E0\u10D2\u10D4\u10D7\u10D8": "Ozurgeti",
    "\u10DB\u10D0\u10E0\u10DC\u10D4\u10E3\u10DA\u10D8": "Marneuli",
    // Armenian
    "\u0535\u0580\u0587\u0561\u0576": "Yerevan",
    "\u0533\u0575\u0578\u0582\u0574\u0580\u056B": "Gyumri",
    "\u054E\u0561\u0576\u0561\u0571\u0578\u0580": "Vanadzor",
    "\u0531\u0562\u0578\u057E\u0575\u0561\u0576": "Abovyan",
    "\u053F\u0561\u057A\u0561\u0576": "Kapan",
    "\u0540\u0580\u0561\u0566\u0564\u0561\u0576": "Hrazdan",
    // Russian
    "\u041C\u043E\u0441\u043A\u0432\u0430": "Moscow",
    "\u0421\u0430\u043D\u043A\u0442-\u041F\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433": "Saint Petersburg",
    "\u041D\u043E\u0432\u043E\u0441\u0438\u0431\u0438\u0440\u0441\u043A": "Novosibirsk",
    "\u0415\u043A\u0430\u0442\u0435\u0440\u0438\u043D\u0431\u0443\u0440\u0433": "Yekaterinburg",
    "\u041A\u0430\u0437\u0430\u043D\u044C": "Kazan",
    "\u041D\u0438\u0436\u043D\u0438\u0439 \u041D\u043E\u0432\u0433\u043E\u0440\u043E\u0434": "Nizhny Novgorod",
    "\u041A\u0440\u0430\u0441\u043D\u043E\u0434\u0430\u0440": "Krasnodar",
    "\u0421\u043E\u0447\u0438": "Sochi",
    "\u0421\u0430\u043C\u0430\u0440\u0430": "Samara",
    "\u041E\u043C\u0441\u043A": "Omsk",
    // Turkish
    "\u0130stanbul": "Istanbul",
    "Ankara": "Ankara",
    "\u0130zmir": "Izmir",
    "Bursa": "Bursa",
    "Antalya": "Antalya",
    "Adana": "Adana",
    "Trabzon": "Trabzon",
    "Gaziantep": "Gaziantep",
    "Konya": "Konya",
    "Mersin": "Mersin",
    "Diyarbak\u0131r": "Diyarbakir",
    // Azerbaijani
    "Bak\u0131": "Baku",
    "G\u0259nc\u0259": "Ganja",
    "Sumqay\u0131t": "Sumqayit",
    // Arabic
    "\u0627\u0644\u0642\u0627\u0647\u0631\u0629": "Cairo",
    "\u0627\u0644\u0631\u064A\u0627\u0636": "Riyadh",
    "\u062C\u062F\u0629": "Jeddah",
    "\u062F\u0628\u064A": "Dubai",
    "\u0628\u064A\u0631\u0648\u062A": "Beirut",
    "\u0639\u0645\u0651\u0627\u0646": "Amman",
    // Hindi
    "\u092E\u0941\u0902\u092C\u0908": "Mumbai",
    "\u0926\u093F\u0932\u094D\u0932\u0940": "Delhi",
    "\u092C\u0947\u0902\u0917\u0932\u0941\u0930\u0941": "Bangalore",
    // Chinese/Japanese/Korean
    "\uC11C\uC6B8": "Seoul",
    "\uB3C4\uCFC4": "Tokyo",
    // Ukrainian
    "\u041A\u0438\u0457\u0432": "Kyiv",
    "\u0425\u0430\u0440\u043A\u0456\u0432": "Kharkiv",
    "\u041E\u0434\u0435\u0441\u0430": "Odesa",
    "\u0414\u043D\u0456\u043F\u0440\u043E": "Dnipro"
  };
  function transliterateGeo(text) {
    if (!text) return text;
    const map = {
      // Georgian
      "\u10D0": "a",
      "\u10D1": "b",
      "\u10D2": "g",
      "\u10D3": "d",
      "\u10D4": "e",
      "\u10D5": "v",
      "\u10D6": "z",
      "\u10D7": "t",
      "\u10D8": "i",
      "\u10D9": "k",
      "\u10DA": "l",
      "\u10DB": "m",
      "\u10DC": "n",
      "\u10DD": "o",
      "\u10DE": "p",
      "\u10DF": "zh",
      "\u10E0": "r",
      "\u10E1": "s",
      "\u10E2": "t",
      "\u10E3": "u",
      "\u10E4": "p",
      "\u10E5": "k",
      "\u10E6": "gh",
      "\u10E7": "q",
      "\u10E8": "sh",
      "\u10E9": "ch",
      "\u10EA": "ts",
      "\u10EB": "dz",
      "\u10EC": "ts",
      "\u10ED": "ch",
      "\u10EE": "kh",
      "\u10EF": "j",
      "\u10F0": "h",
      // Armenian
      "\u0531": "A",
      "\u0532": "B",
      "\u0533": "G",
      "\u0534": "D",
      "\u0535": "Ye",
      "\u0536": "Z",
      "\u0537": "E",
      "\u0538": "Y",
      "\u0539": "T",
      "\u053A": "Zh",
      "\u053B": "I",
      "\u053C": "L",
      "\u053D": "Kh",
      "\u053F": "K",
      "\u0540": "H",
      "\u0541": "Dz",
      "\u0542": "Gh",
      "\u0543": "Ch",
      "\u0544": "M",
      "\u0545": "Y",
      "\u0546": "N",
      "\u0547": "Sh",
      "\u0548": "Vo",
      "\u0549": "Ch",
      "\u054A": "P",
      "\u054B": "J",
      "\u054C": "R",
      "\u054D": "S",
      "\u054E": "V",
      "\u054F": "T",
      "\u0550": "R",
      "\u0551": "Ts",
      "\u0553": "P",
      "\u0554": "K",
      "\u0555": "O",
      "\u0556": "F",
      "\u0561": "a",
      "\u0562": "b",
      "\u0563": "g",
      "\u0564": "d",
      "\u0565": "ye",
      "\u0566": "z",
      "\u0567": "e",
      "\u0568": "y",
      "\u0569": "t",
      "\u056A": "zh",
      "\u056B": "i",
      "\u056C": "l",
      "\u056D": "kh",
      "\u056F": "k",
      "\u0570": "h",
      "\u0571": "dz",
      "\u0572": "gh",
      "\u0573": "ch",
      "\u0574": "m",
      "\u0575": "y",
      "\u0576": "n",
      "\u0577": "sh",
      "\u0578": "vo",
      "\u0579": "ch",
      "\u057A": "p",
      "\u057B": "j",
      "\u057C": "r",
      "\u057D": "s",
      "\u057E": "v",
      "\u057F": "t",
      "\u0580": "r",
      "\u0581": "ts",
      "\u0578\u0582": "u",
      "\u0583": "p",
      "\u0584": "k",
      "\u0587": "ev",
      "\u0585": "o",
      "\u0586": "f",
      // Russian/Cyrillic
      "\u0410": "A",
      "\u0411": "B",
      "\u0412": "V",
      "\u0413": "G",
      "\u0414": "D",
      "\u0415": "E",
      "\u0401": "Yo",
      "\u0416": "Zh",
      "\u0417": "Z",
      "\u0418": "I",
      "\u0419": "Y",
      "\u041A": "K",
      "\u041B": "L",
      "\u041C": "M",
      "\u041D": "N",
      "\u041E": "O",
      "\u041F": "P",
      "\u0420": "R",
      "\u0421": "S",
      "\u0422": "T",
      "\u0423": "U",
      "\u0424": "F",
      "\u0425": "Kh",
      "\u0426": "Ts",
      "\u0427": "Ch",
      "\u0428": "Sh",
      "\u0429": "Shch",
      "\u042A": "",
      "\u042B": "Y",
      "\u042C": "",
      "\u042D": "E",
      "\u042E": "Yu",
      "\u042F": "Ya",
      "\u0430": "a",
      "\u0431": "b",
      "\u0432": "v",
      "\u0433": "g",
      "\u0434": "d",
      "\u0435": "e",
      "\u0451": "yo",
      "\u0436": "zh",
      "\u0437": "z",
      "\u0438": "i",
      "\u0439": "y",
      "\u043A": "k",
      "\u043B": "l",
      "\u043C": "m",
      "\u043D": "n",
      "\u043E": "o",
      "\u043F": "p",
      "\u0440": "r",
      "\u0441": "s",
      "\u0442": "t",
      "\u0443": "u",
      "\u0444": "f",
      "\u0445": "kh",
      "\u0446": "ts",
      "\u0447": "ch",
      "\u0448": "sh",
      "\u0449": "shch",
      "\u044A": "",
      "\u044B": "y",
      "\u044C": "",
      "\u044D": "e",
      "\u044E": "yu",
      "\u044F": "ya"
    };
    return text.split("").map((c) => map[c] || c).join("");
  }
  function getEnglishCityName(name) {
    if (!name) return "";
    if (CITY_EN_MAP[name]) return CITY_EN_MAP[name];
    if (/^[a-zA-Z\s-]+$/.test(name)) return name;
    const translit = transliterateGeo(name);
    if (translit !== name) return translit;
    return name;
  }
  const EXCLUDE_DOMAINS = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com/i;
  function buildSearchQuery(b) {
    const nameEn = getEnglishCityName(b.name);
    const cityEn = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
    const category = b.categoryLabel || "";
    const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
    const street = b.address ? b.address.split(",")[0]?.trim() || "" : "";
    const streetEn = getEnglishCityName(street);
    const parts = [];
    if (isLatin) {
      parts.push(`"${b.name}"`);
      if (cityEn) parts.push(cityEn);
    } else {
      if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
      if (cityEn) parts.push(cityEn);
      if (category) parts.push(category);
      if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
      parts.push(`"${b.name}"`);
    }
    parts.push("phone email website contact");
    return encodeURIComponent(parts.join(" "));
  }
  function buildSearchQueries(b) {
    const queries = [];
    const nameEn = getEnglishCityName(b.name);
    const cityEn = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
    const street = b.address ? b.address.split(",")[0]?.trim() || "" : "";
    const streetEn = getEnglishCityName(street);
    const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
    if (isLatin) {
      queries.push(encodeURIComponent(`"${b.name}" ${cityEn || ""} phone email contact`));
    } else {
      if (nameEn && nameEn !== b.name) {
        queries.push(encodeURIComponent(`"${nameEn}" ${cityEn || ""} phone email contact`));
      }
    }
    if (streetEn && streetEn !== street) {
      queries.push(encodeURIComponent(`"${b.name}" "${streetEn}" ${cityEn || ""} phone email`));
    }
    if (!isLatin && nameEn && nameEn !== b.name) {
      queries.push(encodeURIComponent(`"${nameEn}" ${b.categoryLabel || ""} ${cityEn || ""} phone email website`));
    }
    if (!isLatin) {
      queries.push(encodeURIComponent(`"${b.name}" ${cityEn || ""} phone email website contact`));
    }
    return queries.filter((q) => q.length > 5);
  }
  function buildContactQuery(b) {
    const nameEn = getEnglishCityName(b.name);
    const cityEn = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
    const street = b.address ? b.address.split(",")[0]?.trim() || "" : "";
    const streetEn = getEnglishCityName(street);
    const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
    const parts = [];
    if (isLatin) {
      parts.push(`"${b.name}"`);
    } else {
      if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
      if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
    }
    if (cityEn) parts.push(cityEn);
    parts.push('site:facebook.com OR site:instagram.com OR "contact us"');
    return encodeURIComponent(parts.join(" "));
  }
  function buildEmailQuery(b) {
    const nameEn = getEnglishCityName(b.name);
    const cityEn = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
    const street = b.address ? b.address.split(",")[0]?.trim() || "" : "";
    const streetEn = getEnglishCityName(street);
    const category = b.categoryLabel || "";
    const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
    const parts = [];
    if (isLatin) {
      parts.push(`"${b.name}"`);
    } else {
      if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
      if (category) parts.push(category);
      if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
    }
    if (cityEn) parts.push(cityEn);
    parts.push("email address contact");
    return encodeURIComponent(parts.join(" "));
  }
  function buildPhoneQuery(b) {
    const nameEn = getEnglishCityName(b.name);
    const cityEn = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
    const street = b.address ? b.address.split(",")[0]?.trim() || "" : "";
    const streetEn = getEnglishCityName(street);
    const category = b.categoryLabel || "";
    const isLatin = /^[a-zA-Z\s\-'&.]+$/.test(b.name);
    const parts = [];
    if (isLatin) {
      parts.push(`"${b.name}"`);
    } else {
      if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
      if (category) parts.push(category);
      if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
    }
    if (cityEn) parts.push(cityEn);
    parts.push("phone number telephone call");
    return encodeURIComponent(parts.join(" "));
  }
  async function tryGoogleCache(_b) {
    return;
  }
  async function tryAMPVersion(b) {
    if (b.email && b.phone) return;
    if (!b.website) return;
    try {
      const ampUrl = b.website.replace(/\.html$/, "") + "/amp";
      const r = await corsFetch(ampUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4e3)
      });
      if (r.ok) {
        const html = await r.text();
        extractFromHtml(html, b);
      }
    } catch {
    }
  }
  async function scrapeContactPageForEmail(b) {
    if (b.email || !b.website) return;
    try {
      const base = b.website.replace(/\/$/, "");
      const paths = [
        "/contact",
        "/contact-us",
        "/about",
        "/about-us",
        "/kontakti",
        "/\u043A\u043E\u043D\u0442\u0430\u043A\u0442\u044B",
        "/iletisim",
        "/contato",
        "/contacto",
        "/kontakt",
        "/scontattaci",
        "/ contacting",
        "/team",
        "/info",
        "/impressum",
        "/locations",
        "/find-us",
        "/where-to-find-us",
        "/reach-us",
        "/get-in-touch",
        "/kontaktay",
        "/momkhmarebeli",
        "/\u8054\u7CFB\u65B9\u5F0F",
        "/\u304A\u554F\u3044\u5408\u308F\u305B",
        "/\u0627\u062A\u0635\u0644-\u0628\u0646\u0627",
        "/\u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C-\u043D\u0430\u043C",
        "/\u8054\u7CFB\u6211\u4EEC"
      ];
      for (const path of paths) {
        if (b.email) break;
        try {
          let r;
          try {
            r = await fetch(base + path, { signal: AbortSignal.timeout(2500), headers: { "User-Agent": "Mozilla/5.0 (compatible; BlueOcean/1.0)" } });
          } catch {
            r = await corsFetch(base + path, { signal: AbortSignal.timeout(2500) });
          }
          if (!r.ok) continue;
          const html = await r.text();
          const junk = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org|duckduckgo/i;
          const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, "");
              if (!junk.test(clean) && clean.length > 6 && clean.length < 80) {
                b.email = clean;
                break;
              }
            }
          }
          if (!b.email) {
            const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
            if (cfM) {
              try {
                const bytes = cfM[1].match(/.{2}/g).map((h) => parseInt(h, 16));
                const key = bytes[0];
                const decoded = bytes.slice(1).map((x) => x ^ key).map((x) => String.fromCharCode(x)).join("");
                if (decoded.includes("@") && !junk.test(decoded)) b.email = decoded;
              } catch {
              }
            }
          }
          if (!b.phone) {
            const telM = html.match(/href="tel:([^"]+)"/);
            if (telM) b.phone = telM[1].trim();
            if (!b.phone) {
              const phM = html.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
              if (phM) {
                for (const p of phM) {
                  const digits = p.replace(/[^\d+]/g, "");
                  if (digits.length >= 8 && digits.length <= 15 && !junk.test(p)) {
                    b.phone = p.trim();
                    break;
                  }
                }
              }
            }
            if (!b.phone) {
              const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls)\s*[:;]\s*([+\d][\d\s\-\.()]{7,18})/i);
              if (labeledPh && labeledPh[1].replace(/[^\d]/g, "").length >= 8) b.phone = labeledPh[1].trim();
            }
          }
          if (!b.facebook) {
            const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
            if (fbM && !fbM[0].includes("login") && !fbM[0].includes("sharer")) {
              b.facebook = "https://facebook.com/" + fbM[1].replace(/\/$/, "");
            }
          }
          if (!b.instagram) {
            const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
            if (igM && !igM[0].includes("accounts")) {
              b.instagram = "https://instagram.com/" + igM[1].replace(/\/$/, "");
            }
          }
          const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
          for (const href of hrefs) {
            if (!b.facebook && /facebook\.com\/[^/]+/i.test(href) && !href.includes("login")) {
              const m2 = href.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
              if (m2) b.facebook = "https://facebook.com/" + m2[1];
            }
            if (!b.instagram && /instagram\.com\/[^/]+/i.test(href) && !href.includes("accounts")) {
              const m3 = href.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
              if (m3) b.instagram = "https://instagram.com/" + m3[1];
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
  async function enrichFromBrave(businesses, onProgress2) {
    const NEEDS = businesses.filter((b) => !b.phone || !b.website || !b.email || !b.facebook && !b.instagram);
    if (NEEDS.length === 0 || !BRAVE_API_KEY) return;
    const BATCH = 3;
    const max = Math.min(NEEDS.length, 50);
    let found = 0;
    for (let i = 0; i < max; i += BATCH) {
      const batch = NEEDS.slice(i, i + BATCH);
      await Promise.all(batch.map(async (b) => {
        try {
          const q = buildSearchQuery(b);
          const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=3`, {
            headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY },
            signal: AbortSignal.timeout(8e3)
          });
          if (!r.ok) return;
          const data = await r.json();
          const results2 = data.web?.results || [];
          for (const res of results2) {
            const desc = (res.description || "") + " " + (res.title || "");
            if (!b.phone) {
              const m = desc.match(/\+?\d[\d\s\-\.\(\)]{7,18}/);
              if (m && m[0].length >= 8) {
                b.phone = m[0].trim();
                found++;
              }
            }
            if (!b.website && res.url && !res.url.includes("google.com") && !res.url.includes("facebook.com")) {
              b.website = res.url;
              found++;
            }
            if (!b.email) {
              const m = desc.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              if (m && !m[0].includes("example.com")) {
                b.email = m[0];
                found++;
              }
            }
            if (!b.facebook) {
              const m = desc.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
              if (m) {
                b.facebook = "https://facebook.com/" + m[1];
                found++;
              }
            }
            if (!b.instagram) {
              const m = desc.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
              if (m) {
                b.instagram = "https://instagram.com/" + m[1];
                found++;
              }
            }
            if (!b.website && data.knowledge_graph?.url) {
              const kgUrl = data.knowledge_graph.url;
              if (!kgUrl.includes("google.com") && !EXCLUDE_DOMAINS.test(kgUrl)) {
                b.website = kgUrl;
                found++;
              }
            }
          }
        } catch {
        }
      }));
      if (i + BATCH < max) await wait(1500);
      onProgress2?.(88, `Brave search\u2026 ${Math.min(i + BATCH, max)}/${max} (${found} found)`);
    }
  }
  async function enrichFromWeb(businesses, onProgress2) {
    const NEEDS_DATA = businesses.filter((b) => !b.website || !b.phone || !b.email || !b.facebook && !b.instagram);
    if (NEEDS_DATA.length === 0) return;
    const BATCH = 5;
    const maxEnrich2 = Math.min(NEEDS_DATA.length, 120);
    let found = 0;
    for (let i = 0; i < maxEnrich2; i += BATCH) {
      const batch = NEEDS_DATA.slice(i, i + BATCH);
      const promises = batch.map(async (b) => {
        try {
          const query = buildSearchQuery(b);
          const url = `https://html.duckduckgo.com/html/?q=${query}`;
          const r = await corsFetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(12e3)
          });
          if (!r.ok) return;
          const html = await r.text();
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
          if (!b.phone) {
            const geoMatch = html.match(/\+995\s?\d{3}\s?\d{2}\s?\d{2}\s?\d{2}/);
            if (geoMatch) {
              b.phone = geoMatch[0].trim();
              found++;
            }
          }
          if (!b.website) {
            const linkMatches = html.matchAll(/href="([^"]+)"[^>]*class="result__a"[^>]*>([^<]+)/g);
            for (const match of linkMatches) {
              const href = match[1];
              const text = match[2].toLowerCase();
              if (href.match(/google\.|facebook\.com|instagram\.com|yelp\.com|tripadvisor|wikipedia|linkedin|twitter|x\.com|youtube|tiktok|pinterest/i)) continue;
              let actualUrl = href;
              const uddgMatch = href.match(/uddg=([^&]+)/);
              if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
              if (actualUrl.startsWith("http")) {
                b.website = actualUrl;
                found++;
                break;
              }
            }
          }
          if (!b.email) {
            const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            if (emails) {
              const junk = ["example.com", "duckduckgo", "googleapis", "sentry", "wixpress", "cloudflare", "schema.org"];
              for (const e of emails) {
                const clean = e.replace(/[\s>);]+$/, "");
                if (junk.every((j) => !clean.includes(j)) && clean.length > 6 && clean.length < 80) {
                  b.email = clean;
                  found++;
                  break;
                }
              }
            }
          }
          const snippetMatch = html.match(/class="result__snippet"[^>]*>([^<]+)/g);
          if (snippetMatch) {
            for (const s of snippetMatch) {
              const text = s.replace(/class="result__snippet"[^>]*>/, "");
              if (!b.facebook) {
                const fbMatch = text.match(/facebook\.com\/[^\s<"]+/i);
                if (fbMatch) b.facebook = "https://" + fbMatch[0];
              }
              if (!b.instagram) {
                const igMatch = text.match(/instagram\.com\/[^\s<"]+/i);
                if (igMatch) b.instagram = "https://" + igMatch[0];
              }
            }
          }
        } catch {
        }
      });
      await Promise.all(promises);
      if (i + BATCH < maxEnrich2) await wait(2e3);
      onProgress2?.(85, `Web enrichment\u2026 ${Math.min(i + BATCH, maxEnrich2)}/${maxEnrich2} (${found} found)`);
    }
  }
  if (skipEnrichment) {
    onProgress?.(100, `Found ${totalBiz} businesses`);
    return results;
  }
  const allBizList = [];
  for (const bizs of results.values()) {
    for (const b of bizs) allBizList.push(b);
  }
  const selectedCityEn = allBizList.length > 0 ? getEnglishCityName((allBizList[0].address || "").split(",").pop()?.trim() || "") : "";
  const _ep = {
    activePass: "Initializing\u2026",
    passNumber: 0,
    totalPasses: 8,
    engines: [
      { name: "DuckDuckGo", icon: "\u{1F986}", status: "idle", found: 0 },
      { name: "Brave", icon: "\u{1F981}", status: "idle", found: 0 },
      { name: "Bing", icon: "\u{1F50D}", status: "idle", found: 0 },
      { name: "DDG Lite", icon: "\u{1F310}", status: "idle", found: 0 },
      { name: "2GIS", icon: "\u{1F4CD}", status: "idle", found: 0 },
      { name: "Yandex", icon: "\u{1F534}", status: "idle", found: 0 },
      { name: "Website Scraper", icon: "\u{1F578}\uFE0F", status: "idle", found: 0 }
    ],
    contacts: { emails: 0, phones: 0, websites: 0, social: 0, total: 0 },
    businessesProcessed: 0,
    businessesTotal: allBizList.length,
    percent: 0
  };
  function emitEP() {
    _ep.contacts.emails = allBizList.filter((b) => b.email).length;
    _ep.contacts.phones = allBizList.filter((b) => b.phone).length;
    _ep.contacts.websites = allBizList.filter((b) => b.website).length;
    _ep.contacts.social = allBizList.filter((b) => b.facebook || b.instagram).length;
    _ep.contacts.total = _ep.contacts.emails + _ep.contacts.phones + _ep.contacts.websites + _ep.contacts.social;
    onEnrichProgress?.({ ..._ep, engines: _ep.engines.map((e) => ({ ...e })) });
  }
  _ep.activePass = "Filling missing addresses";
  _ep.passNumber = 0;
  _ep.percent = 70;
  emitEP();
  if (allBizList.length > 0) {
    const maxEnrich2 = Math.min(allBizList.length, 150);
    const CONCURRENCY = 5;
    for (let i = 0; i < maxEnrich2; i += CONCURRENCY) {
      if (isCancelled()) break;
      const batch = allBizList.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (b) => {
        if (b.address) return;
        try {
          const r = await fetch(`https://photon.komoot.io/reverse?lat=${b.lat}&lon=${b.lon}&lang=en`, {
            signal: AbortSignal.timeout(3e3)
          });
          if (r.ok) {
            const d = await r.json();
            const f = d.features?.[0]?.properties;
            if (f) {
              const parts = [f.name, f.housenumber, f.district || f.locality, f.city].filter(Boolean);
              b.address = parts.join(", ") || "";
            }
          }
        } catch {
        }
      }));
      if (i + CONCURRENCY < maxEnrich2) await wait(500);
      onProgress?.(75, `Filling addresses\u2026 ${Math.min(i + CONCURRENCY, maxEnrich2)}/${maxEnrich2}`);
      _ep.businessesProcessed = Math.min(i + CONCURRENCY, maxEnrich2);
      emitEP();
    }
  }
  onProgress?.(80, `Found ${totalBiz} businesses \u2014 enriching data in parallel\u2026`);
  if (isCancelled()) {
    onProgress?.(100, "Cancelled");
    return results;
  }
  const NEEDS_ENRICHMENT = allBizList.filter((b) => !b.phone || !b.website || !b.email || !b.facebook && !b.instagram);
  const maxEnrich = Math.min(NEEDS_ENRICHMENT.length, 200);
  const _EXCLUDE = /example\.com|wixpress|sentry\.io|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress/i;
  _ep.activePass = "Enriching contacts (priority pipeline)";
  _ep.passNumber = 1;
  _ep.percent = 80;
  _ep.engines.forEach((e) => {
    e.status = "active";
    e.found = 0;
  });
  emitEP();
  const _BATCH = 10;
  let enrichedCount = 0;
  for (let i = 0; i < maxEnrich; i += _BATCH) {
    if (isCancelled()) break;
    const batch = NEEDS_ENRICHMENT.slice(i, i + _BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const hasSufficientData = () => b.phone && b.email || b.phone && b.website || b.email && b.website;
        let websiteScraped = false;
        const scrapeWebsiteOnce = async () => {
          if (websiteScraped || !b.website) return;
          websiteScraped = true;
          if (!b.email || !b.phone || !b.facebook) {
            try {
              await enrichFromWebsiteDeep(b);
            } catch {
            }
          }
          if (!b.email && b.website) {
            try {
              await scrapeContactPageForEmail(b);
            } catch {
            }
          }
        };
        const q = buildSearchQuery(b);
        await Promise.all([
          // Brave API
          (async () => {
            try {
              const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
                headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY },
                signal: AbortSignal.timeout(3e3)
              });
              if (r.ok) {
                const data = await r.json();
                for (const res of data.web?.results || []) {
                  extractFromText((res.description || "") + " " + (res.title || ""), b);
                  if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes("google.com/maps") && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
                }
                if (!b.website && data.knowledge_graph?.url && !_EXCLUDE.test(data.knowledge_graph.url)) b.website = data.knowledge_graph.url;
              }
            } catch {
            }
          })(),
          // DuckDuckGo HTML
          (async () => {
            try {
              const r = await corsFetch("https://html.duckduckgo.com/html/?q=" + q, {
                headers: { "User-Agent": "Mozilla/5.0" },
                signal: AbortSignal.timeout(4e3)
              });
              if (r.ok) extractFromHtml(await r.text(), b);
            } catch {
            }
          })(),
          // Bing
          (async () => {
            try {
              const bingResults = await searchBing(q);
              for (const res of bingResults) {
                extractFromText((res.snippet || "") + " " + (res.title || ""), b);
                if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes("bing.com") && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
              }
            } catch {
            }
          })(),
          // DDG Lite
          (async () => {
            try {
              const spResults = await searchDDGLite(decodeURIComponent(q));
              for (const res of spResults) {
                extractFromText((res.snippet || "") + " " + (res.title || ""), b);
                if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes("duckduckgo.com/lite") && isLikelyBusinessWebsite(res.url, b.name)) b.website = res.url;
              }
            } catch {
            }
          })()
        ]);
        await scrapeWebsiteOnce();
        if (hasSufficientData()) {
          enrichedCount++;
          return;
        }
        if (!b.email) {
          const emailQ = buildEmailQuery(b);
          await Promise.all([
            (async () => {
              try {
                const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${emailQ}&count=5`, {
                  headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY },
                  signal: AbortSignal.timeout(3e3)
                });
                if (r.ok) {
                  const data = await r.json();
                  for (const res of data.web?.results || []) {
                    extractFromText((res.description || "") + " " + (res.title || ""), b);
                    if (!b.email && res.url && /contact|about|team/i.test(res.url)) {
                      try {
                        const pageR = await corsFetch(res.url, { signal: AbortSignal.timeout(3e3) });
                        if (pageR.ok) extractFromHtml(await pageR.text(), b);
                      } catch {
                      }
                    }
                  }
                }
              } catch {
              }
            })(),
            (async () => {
              try {
                const r = await corsFetch("https://html.duckduckgo.com/html/?q=" + emailQ, {
                  headers: { "User-Agent": "Mozilla/5.0" },
                  signal: AbortSignal.timeout(4e3)
                });
                if (r.ok) extractFromHtml(await r.text(), b);
              } catch {
              }
            })()
          ]);
        }
        if (hasSufficientData()) {
          enrichedCount++;
          return;
        }
        if (!b.website) {
          try {
            await probeDomains(b);
          } catch {
          }
          await scrapeWebsiteOnce();
        }
        if (!b.email && b.website) {
          if (!websiteScraped) {
            try {
              await scrapeContactPageForEmail(b);
            } catch {
            }
          }
          if (!b.email) {
            try {
              await tryCommonEmailPatterns(b);
            } catch {
            }
          }
        }
        if (!b.facebook && !b.instagram && !hasSufficientData()) {
          try {
            const nameEn2 = getEnglishCityName(b.name);
            const cityEn2 = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
            const parts2 = ["'" + (nameEn2 || b.name) + "'"];
            if (cityEn2) parts2.push(cityEn2);
            parts2.push("facebook instagram social");
            const sq = encodeURIComponent(parts2.join(" "));
            const sr = await corsFetch("https://html.duckduckgo.com/html/?q=" + sq, {
              headers: { "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(3e3)
            });
            if (sr.ok) extractFromHtml(await sr.text(), b);
          } catch {
          }
        }
        if (b.phone || b.email || b.website) enrichedCount++;
      } catch {
      }
    }));
    if (i + _BATCH < maxEnrich) await wait(200);
    _ep.businessesProcessed = Math.min(i + _BATCH, maxEnrich);
    _ep.engines.find((e) => e.name === "DuckDuckGo").found = _ep.contacts.emails;
    _ep.engines.find((e) => e.name === "Brave").found = _ep.contacts.phones;
    _ep.engines.find((e) => e.name === "Bing").found = _ep.contacts.websites;
    _ep.engines.find((e) => e.name === "Website Scraper").found = _ep.contacts.social;
    emitEP();
    onProgress?.(
      80 + Math.round(10 * Math.min(i + _BATCH, maxEnrich) / maxEnrich),
      `Enriching\u2026 ${Math.min(i + _BATCH, maxEnrich)}/${maxEnrich} (\u{1F4E7}${_ep.contacts.emails} \u{1F4DE}${_ep.contacts.phones} \u{1F310}${_ep.contacts.websites} \u{1F464}${_ep.contacts.social})`
    );
  }
  _ep.engines.find((e) => e.name === "DuckDuckGo").status = "done";
  _ep.engines.find((e) => e.name === "Brave").status = "done";
  _ep.engines.find((e) => e.name === "Bing").status = "done";
  _ep.engines.find((e) => e.name === "DDG Lite").status = "done";
  if (isCancelled()) {
    onProgress?.(100, "Cancelled");
    return results;
  }
  const need2GIS = allBizList.filter((b) => !b.phone && !b.email && !b.website);
  if (need2GIS.length > 0) {
    _ep.activePass = "Pass 2: Regional (2GIS)";
    _ep.passNumber = 2;
    _ep.percent = 92;
    _ep.engines.find((e) => e.name === "2GIS").status = "active";
    emitEP();
    for (let i2 = 0; i2 < Math.min(need2GIS.length, 40); i2 += _BATCH) {
      if (isCancelled()) break;
      const batch2 = need2GIS.slice(i2, i2 + _BATCH);
      await Promise.all(batch2.map(async (b) => {
        try {
          const nameEn3 = getEnglishCityName(b.name);
          const q2 = encodeURIComponent((nameEn3 || b.name) + " " + (b.address?.split(",").pop() || ""));
          const r2 = await corsFetch("https://catalog.api.2gis.com/3.0/items?q=" + q2 + "&key=rurbbn3446&fields=items.contact_groups,items.reviews", {
            signal: AbortSignal.timeout(6e3)
          });
          if (r2.ok) {
            const d2 = await r2.json();
            const items2 = d2.result?.items || [];
            for (const item of items2) {
              const itemName = (item.name || "").toLowerCase();
              const bizName = (nameEn3 || b.name).toLowerCase();
              if (itemName.includes(bizName.substring(0, 5)) || bizName.includes(itemName.substring(0, 5))) {
                if (!b.phone && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of grp.contacts || []) {
                      if (contact.type === "phone" && contact.value && contact.value.replace(/\D/g, "").length >= 8) {
                        b.phone = contact.value;
                      }
                    }
                  }
                }
                if (!b.website && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of grp.contacts || []) {
                      if (contact.type === "website" && contact.value && !contact.value.includes("2gis.com")) {
                        b.website = contact.value.startsWith("http") ? contact.value : "https://" + contact.value;
                      }
                    }
                  }
                }
                if (!b.address && item.address_name) b.address = item.address_name;
                break;
              }
            }
          }
        } catch {
        }
      }));
      if (i2 + _BATCH < need2GIS.length) await wait(1e3);
    }
    _ep.engines.find((e) => e.name === "2GIS").status = "done";
    emitEP();
  }
  const needYandex = allBizList.filter((b) => !b.phone && !b.email && !b.website);
  if (needYandex.length > 0) {
    _ep.activePass = "Pass 3: Regional (Yandex)";
    _ep.passNumber = 3;
    _ep.percent = 94;
    _ep.engines.find((e) => e.name === "Yandex").status = "active";
    emitEP();
    for (let i3 = 0; i3 < Math.min(needYandex.length, 30); i3 += _BATCH) {
      if (isCancelled()) break;
      const batch3 = needYandex.slice(i3, i3 + _BATCH);
      await Promise.all(batch3.map(async (b) => {
        try {
          const nameEn4 = getEnglishCityName(b.name);
          const cityEn3 = b.address ? getEnglishCityName(b.address.split(",").pop()?.trim() || "") : "";
          const q3 = encodeURIComponent(`site:yandex.* ${nameEn4 || b.name} ${cityEn3 || ""} phone`);
          const r3 = await corsFetch("https://html.duckduckgo.com/html/?q=" + q3, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(6e3)
          });
          if (r3.ok) {
            const html3 = await r3.text();
            extractFromHtml(html3, b);
          }
        } catch {
        }
      }));
      if (i3 + _BATCH < needYandex.length) await wait(1200);
    }
    _ep.engines.find((e) => e.name === "Yandex").status = "done";
    emitEP();
  }
  _ep.activePass = "Complete";
  _ep.percent = 100;
  _ep.engines.forEach((e) => {
    if (e.status === "active") e.status = "done";
  });
  _ep.engines.find((e) => e.name === "Website Scraper").status = "done";
  emitEP();
  return results;
}
async function getAIAnalysis(cityName, countryName, topOpps, population) {
  try {
    const oppText = topOpps.slice(0, 8).map(
      (o) => `${o.label}: ${o.existing} existing, gap of ${o.gap}, score ${o.score}/100`
    ).join("\n");
    const prompt = `Analyze business opportunities in ${cityName}, ${countryName} (pop. ${population.toLocaleString()}). Market data:
${oppText}

Provide 3-5 concise insights about the best investment opportunities, underserved markets, and competitive advantages. Be specific and actionable. Format as bullet points.`;
    const r = await fetch("https://api-inference.huggingface.co/models/facebook/bart-large-cnn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_length: 300, min_length: 50, do_sample: false }
      }),
      signal: AbortSignal.timeout(15e3)
    });
    if (!r.ok) {
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
function generateLocalAnalysis(cityName, countryName, topOpps, population) {
  const insights = [];
  const biggestGap = topOpps.reduce((best, o) => o.gap > best.gap ? o : best, topOpps[0]);
  if (biggestGap) {
    insights.push(`\u{1F50D} **Biggest opportunity**: ${biggestGap.label} \u2014 only ${biggestGap.existing} exist but ${biggestGap.gap + biggestGap.existing} are expected for a city of ${population.toLocaleString()}. Gap score: ${biggestGap.score}/100.`);
  }
  const underserved = topOpps.filter((o) => o.score >= 60);
  if (underserved.length > 0) {
    insights.push(`\u{1F4CA} **${underserved.length} underserved categories** (score \u226560): ${underserved.map((o) => o.label).join(", ")}.`);
  }
  const totalExisting = topOpps.reduce((s, o) => s + o.existing, 0);
  const per10k = (totalExisting / Math.max(population, 1) * 1e4).toFixed(1);
  insights.push(`\u{1F4C8} Market density: ${totalExisting} businesses across ${topOpps.length} categories = ${per10k} per 10k residents.`);
  const lowComp = topOpps.filter((o) => o.existing < 5);
  if (lowComp.length > 0) {
    insights.push(`\u{1F3C6} **Low competition** (<5 businesses): ${lowComp.map((o) => o.label).join(", ")}. First-mover advantage available.`);
  }
  if (population > 5e5) {
    insights.push(`\u{1F465} Large population (${(population / 1e6).toFixed(1)}M) supports specialized niches \u2014 consider premium/quality positioning.`);
  } else if (population < 1e5) {
    insights.push(`\u{1F3D8}\uFE0F Smaller market (${population.toLocaleString()}) \u2014 focus on essential services with proven demand.`);
  }
  return insights.join("\n\n");
}
function getGoogleMapsUrl(b) {
  if (b.name) {
    const query = [b.name, b.address].filter(Boolean).join(" ");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }
  return `https://www.google.com/maps?q=${b.lat},${b.lon}`;
}
async function getDemandSignals(categoryLabel, cityName) {
  const signals = {
    score: 0,
    confidence: 0,
    wikipedia: 0,
    reddit: 0,
    webSearch: 0,
    explanation: "",
    sources: []
  };
  const wikiP = fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(categoryLabel.replace(/ /g, "_"))}/monthly/20240101/20260101`,
    { headers: { "User-Agent": "BlueOcean/1.0" } }
  ).then(async (r) => {
    if (r.ok) {
      const d = await r.json();
      const t = d.items?.reduce((s, i) => s + (i.views || 0), 0) || 0;
      signals.wikipedia = Math.min(100, Math.round(Math.log10(t + 1) * 16.7));
      signals.sources.push("Wikipedia");
    }
  }).catch(() => {
  });
  const redditP = fetch(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(`${categoryLabel} ${cityName}`)}&sort=new&t=month&limit=25`,
    { headers: { "User-Agent": "BlueOcean/1.0" } }
  ).then(async (r) => {
    if (r.ok) {
      const d = await r.json();
      signals.reddit = Math.min(100, (d.data?.children?.length || 0) * 5);
      signals.sources.push("Reddit");
    }
  }).catch(() => {
  });
  const ddgP = corsFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${categoryLabel}" "${cityName}"`)}`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  ).then(async (r) => {
    if (r.ok) {
      const h = await r.text();
      signals.webSearch = Math.min(100, (h.match(/class="result__snippet"/g)?.length || 0) * 10);
      signals.sources.push("Web Search");
    }
  }).catch(() => {
  });
  const gtP = Promise.resolve();
  await Promise.race([
    Promise.all([wikiP, redditP, ddgP, gtP]),
    new Promise((r) => setTimeout(r, 1e4))
  ]);
  signals.score = Math.round(
    0.3 * signals.webSearch + 0.3 * signals.wikipedia + 0.25 * signals.reddit + 0.15 * Math.max(signals.webSearch, signals.wikipedia, signals.reddit)
  );
  signals.confidence = Math.round(
    [signals.wikipedia, signals.reddit, signals.webSearch].filter((s) => s > 0).length / 3 * 100
  );
  const p = [];
  if (signals.webSearch > 50) p.push("Strong web presence");
  else if (signals.webSearch > 20) p.push("Moderate web presence");
  if (signals.wikipedia > 30) p.push("Active knowledge-seeking");
  if (signals.reddit > 20) p.push(`${signals.reddit} community discussions`);
  signals.explanation = p.length ? p.join(", ") : "Limited demand data available";
  return signals;
}
function computeOpportunities(businesses, population, demandSignals) {
  const results = [];
  const per10kValues = [];
  for (const [, bizs] of businesses) {
    per10kValues.push(bizs.length / Math.max(population, 1) * 1e4);
  }
  per10kValues.sort((a, b) => a - b);
  const median = per10kValues.length > 0 ? per10kValues[Math.floor(per10kValues.length / 2)] : 5;
  const GLOBAL_BASELINES = {
    cafe: 4,
    restaurant: 5,
    bar: 2,
    pub: 1.5,
    fast_food: 3,
    hotel: 1,
    gym: 1.5,
    beauty_salon: 2,
    hair_salon: 2,
    pharmacy: 1.5,
    bank: 1,
    supermarket: 1.5,
    clothing: 3,
    electronics: 2,
    bakery: 1.5,
    cinema: 0.3
  };
  for (const [cat, bizs] of businesses) {
    const existing = bizs.length;
    const per10k = existing / Math.max(population, 1) * 1e4;
    const baseline = GLOBAL_BASELINES[cat] || median;
    const expected = Math.round(baseline * population / 1e4);
    const gap = Math.max(0, expected - existing);
    const gapPct = expected > 0 ? gap / expected : 0;
    const gapScore = Math.min(100, Math.round(gapPct * 120));
    const sizeScore = Math.min(100, Math.round(Math.log10(Math.max(population, 1)) * 18));
    const compScore = existing === 0 ? 90 : Math.max(0, Math.round(100 - existing * 3));
    let score = Math.round(0.45 * gapScore + 0.25 * sizeScore + 0.3 * compScore);
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
      demandBonus
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
function plausiblePhone(p) {
  const t = p.trim();
  const digits = t.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return false;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(t)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return false;
  if (/^1\d{9,12}$/.test(digits) && !t.startsWith("+")) return false;
  return true;
}
var __internals = {};
__internals.corsFetch = corsFetch;
__internals.extractFromHtml = extractFromHtmlModule;
function extractFromHtmlModule(html, b) {
  const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org|privacy.*policy|terms.*service|cookie/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
  if (!b.phone) {
    const telM = html.match(/href="tel:([^"]+)"/);
    if (telM) b.phone = (() => {
      try {
        return decodeURIComponent(telM[1]).trim();
      } catch {
        return telM[1].trim();
      }
    })();
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
    if (!b.phone) {
      const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls?|whatsapp|viber|contact)\s*[:;=\s"'>]*([+\d][\d\s\-\.()]{7,18})/i);
      if (labeledPh && labeledPh[1].replace(/[^\d]/g, "").length >= 8 && plausiblePhone(labeledPh[1])) b.phone = labeledPh[1].trim();
    }
    if (!b.phone) {
      const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
      if (phM) {
        for (const p of phM) {
          if (!p.includes("+")) continue;
          const digits = p.replace(/[^\d+]/g, "");
          if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(p) && !JUNK.test(p)) {
            b.phone = p.trim();
            break;
          }
        }
      }
    }
  }
  if (!b.email) {
    const contactSection = html.match(/<(?:div|section|footer|aside)[^>]*class="[^"]*contact[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|footer|aside)/i);
    if (contactSection) {
      const emails = contactSection[1].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, "");
          if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) {
            b.email = clean;
            break;
          }
        }
      }
    }
  }
  if (!b.email) {
    const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
    if (mailM && !JUNK.test(mailM[1]) && !EMAIL_FILE.test(mailM[1])) b.email = mailM[1].trim();
    if (!b.email) {
      const labelM = html.match(/(?:email|e-mail|mail|contact)\s*[:;=\s"'>]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (labelM && !JUNK.test(labelM[1]) && !EMAIL_FILE.test(labelM[1])) b.email = labelM[1];
    }
    if (!b.email) {
      const jsonLdEmails = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of jsonLdEmails) {
        try {
          const data = JSON.parse(m[1]);
          const entities = Array.isArray(data) ? data : [data];
          for (const e of entities) {
            if (e.email && !JUNK.test(e.email) && !EMAIL_FILE.test(e.email)) {
              b.email = e.email;
              break;
            }
          }
        } catch {
        }
        if (b.email) break;
      }
    }
    if (!b.email) {
      const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, "");
          if (!JUNK.test(clean) && !EMAIL_FILE.test(clean) && clean.length > 6 && clean.length < 80) {
            b.email = clean;
            break;
          }
        }
      }
    }
    if (!b.email) {
      const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
      if (cfM) {
        try {
          const bytes = cfM[1].match(/.{2}/g).map((h) => parseInt(h, 16));
          const key = bytes[0];
          const decoded = bytes.slice(1).map((x) => x ^ key).map((x) => String.fromCharCode(x)).join("");
          if (decoded.includes("@") && !JUNK.test(decoded)) b.email = decoded;
        } catch {
        }
      }
    }
    if (!b.email) {
      const entM = html.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (entM && !JUNK.test(entM[0])) b.email = entM[1] + "@" + entM[2];
    }
    if (!b.email) {
      const jsEmailM = html.match(/['"]([\w][\w._%+-]*@[\w.-]+\.[a-zA-Z]{2,})['"]/);
      if (jsEmailM && !JUNK.test(jsEmailM[1]) && !EMAIL_FILE.test(jsEmailM[1]) && jsEmailM[1].length > 6) b.email = jsEmailM[1];
    }
    if (!b.email) {
      const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
      if (dataEmailM && !JUNK.test(dataEmailM[1]) && !EMAIL_FILE.test(dataEmailM[1])) b.email = dataEmailM[1];
    }
  }
  if (!b.website) {
    const links = html.matchAll(/href="([^"]+)"/g);
    const DENY = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest\.com|tumblr|reddit\.com|quora|wikipedia\.org|youtube\.com|tiktok\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|snapchat|threads|medium\.com|substack|archive\.org|amazon\.|ebay\.|aliexpress|2gis\.|yandex\.|uber\.com|doordash|grubhub|glassdoor|indeed\.com|thumbtack|bbb\.org|trustpilot|google\.|gstatic|apple\.com|microsoft\.com/i;
    for (const link of links) {
      let url = link[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!url.startsWith("http")) continue;
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (DENY.test(host)) continue;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
      b.website = url;
      break;
    }
  }
  if (!b.facebook) {
    const fbM = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/i);
    if (fbM && !fbM[0].includes("login") && !fbM[0].includes("sharer") && !fbM[0].includes("dialog")) {
      b.facebook = "https://facebook.com/" + fbM[1].replace(/\/$/, "");
    }
  }
  if (!b.instagram) {
    const igM = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
    if (igM && !igM[0].includes("accounts") && !igM[0].includes("explore")) {
      b.instagram = "https://instagram.com/" + igM[1].replace(/\/$/, "");
    }
  }
  if (!b.twitter) {
    const twM = html.match(/(?:twitter|x)\.com\/([a-zA-Z0-9._]+)/i);
    if (twM && !twM[0].includes("login") && !twM[0].includes("intent") && !twM[0].includes("share")) {
      b.twitter = "https://twitter.com/" + twM[1].replace(/\/$/, "");
    }
  }
  if (!b.pinterest) {
    const pinM = html.match(/pinterest\.com\/([a-zA-Z0-9._]+)/i);
    if (pinM && !pinM[0].includes("login")) {
      b.pinterest = "https://pinterest.com/" + pinM[1].replace(/\/$/, "");
    }
  }
  if (!b.rating) {
    const ratingM = html.match(/(?:ratingValue|rating)["\s:=]*(?:content)?["\s:=]*(\d\.\d)/i) || html.match(/(\d\.\d)\s*(?:out of|\/)\s*5/i);
    if (ratingM) {
      const val = parseFloat(ratingM[1]);
      if (val >= 1 && val <= 5) b.rating = val;
    }
  }
  if (!b.reviewCount) {
    const revM = html.match(/(?:reviewCount|ratingCount)["\s:=]+(\d+)/i) || html.match(/(\d[\d,]*)\s*reviews?/i);
    if (revM) {
      const val = parseInt(revM[1].replace(/,/g, ""));
      if (val > 0 && val < 1e5) b.reviewCount = val;
    }
  }
}

// src/__overpasstest.ts
async function main() {
  console.log("=== LIVE OVERPASS REGRESSION: focused cafe scan (Tbilisi, 3km) ===");
  const t0 = Date.now();
  const all = await queryBusinesses(
    41.6934,
    44.8015,
    // Tbilisi center
    3e3,
    (pct, msg) => {
      if (pct % 20 === 0) console.log(`  ${pct}%: ${msg}`);
    },
    "cafe",
    // focused category query
    true
    // skipEnrichment (test the Overpass path itself)
  );
  const cafes = all.get("cafe") || [];
  console.log(`elapsed: ${Math.round((Date.now() - t0) / 1e3)}s`);
  console.log(`cafes found: ${cafes.length}`);
  const withName = cafes.filter((c) => c.name).length;
  const withPhone = cafes.filter((c) => c.phone).length;
  const withWebsite = cafes.filter((c) => c.website).length;
  console.log(`named: ${withName}, with phone (OSM tags): ${withPhone}, with website (OSM tags): ${withWebsite}`);
  for (const c of cafes.slice(0, 8)) {
    console.log(`  - ${c.name || "(unnamed)"} @ ${c.address || "(no addr)"} ${c.phone ? "\u260E" : ""}${c.website ? "\u2302" : ""}`);
  }
  if (cafes.length < 15) throw new Error(`only ${cafes.length} cafes in central Tbilisi 3km \u2014 Overpass path broken`);
  if (withName < cafes.length * 0.7) throw new Error("too many unnamed businesses");
  console.log("\nOVERPASS LIVE PASS");
}
main().catch((e) => {
  console.error("OVERPASS LIVE FAIL:", e && e.message || e);
  process.exit(1);
});
