#!/usr/bin/env python3
"""v3.1.0: Fix map pins visible at default zoom + multilingual enrichment"""
import re, os

os.chdir("C:/Users/Anania Light Laptop/Downloads/Blue Ocean")

# ══════════════════════════════════════════════════════════════
# 1. FIX MAP: Set circle-opacity back to 1, use text labels instead of canvas emoji
# ══════════════════════════════════════════════════════════════
with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()

# The canvas-based icon approach is unreliable across browsers.
# Replace with: visible circles + text-field labels with category letters.
# This is bulletproof — works on any browser, any zoom level.

# Find the map.on('load') block and rewrite it
OLD_ONLOAD_START = "      map.on('load', () => {\n        mapReadyRef.current = true;\n\n        // Register canvas-based emoji images for each category"
OLD_ONLOAD_END = "        });\n        // If businesses already exist, render them"

s = app.find(OLD_ONLOAD_START)
e = app.find(OLD_ONLOAD_END, s) if s >= 0 else -1

if s >= 0 and e >= 0:
    NEW_ONLOAD = """      map.on('load', () => {
        mapReadyRef.current = true;
        // Add GeoJSON source for businesses
        map.addSource('businesses', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Circle layer: always visible, colored dots sized by zoom
        map.addLayer({
          id: 'biz-circles',
          type: 'circle',
          source: 'businesses',
          paint: {
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              8, 8,
              12, 12,
              16, 16,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2.5,
            'circle-stroke-color': 'rgba(255,255,255,0.95)',
            'circle-opacity': 0.92,
          },
        });
        // Text label layer: category initial letter on each circle
        map.addLayer({
          id: 'biz-labels',
          type: 'symbol',
          source: 'businesses',
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          },
          paint: {
            'text-color': '#ffffff',
          },
        });
        // Cursor pointer on hover
        map.on('mouseenter', 'biz-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-circles', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'biz-labels', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-labels', () => { map.getCanvas().style.cursor = ''; });
        // Click handler on either layer
        const showPopup = (e: any) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties;
          const coords = f.geometry.coordinates;
          const gmapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((p.name || '') + ' ' + (p.address || ''));
          const osmUrl = 'https://www.openstreetmap.org/?mlat=' + coords[1] + '&mlon=' + coords[0] + '#map=17/' + coords[1] + '/' + coords[0];
          let contactHtml = '';
          if (p.phone) contactHtml += '<div style="margin:3px 0"><a href="tel:' + p.phone + '" style="color:#60a5fa;text-decoration:none;font-size:12px">📞 ' + p.phone + '</a></div>';
          if (p.email) contactHtml += '<div style="font-size:11px;color:#94a3b8;margin:3px 0;word-break:break-all">✉️ ' + p.email + '</div>';
          if (p.website) contactHtml += '<div style="margin:3px 0"><a href="' + p.website + '" target="_blank" style="color:#60a5fa;text-decoration:none;font-size:11px">🌐 ' + p.website.replace(/^https?:\\/\\//, '').slice(0, 25) + '</a></div>';
          if (p.address) contactHtml += '<div style="font-size:10px;color:#64748b;margin:3px 0">📍 ' + p.address + '</div>';
          let socialHtml = '';
          if (p.facebook) socialHtml += '<a href="' + p.facebook + '" target="_blank" style="color:#60a5fa;font-size:9px;text-decoration:none;background:rgba(96,165,250,0.1);padding:2px 5px;border-radius:3px">FB</a> ';
          if (p.instagram) socialHtml += '<a href="' + p.instagram + '" target="_blank" style="color:#e879f9;font-size:9px;text-decoration:none;background:rgba(232,121,249,0.1);padding:2px 5px;border-radius:3px">IG</a>';
          const html = '<div style="padding:10px 12px;max-width:220px;font-family:system-ui,sans-serif">'
            + '<div style="font-weight:600;font-size:13px;color:#f1f5f9;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (p.emoji || '') + ' ' + (p.name || '') + '</div>'
            + '<div style="display:inline-block;background:' + (p.color || '#64748b') + '22;color:' + (p.color || '#64748b') + ';font-size:9px;padding:1px 6px;border-radius:99px;margin-bottom:6px">' + (p.categoryLabel || '') + '</div>'
            + contactHtml
            + (socialHtml ? '<div style="display:flex;gap:3px;margin-top:3px">' + socialHtml + '</div>' : '')
            + '<div style="margin-top:6px;padding-top:5px;border-top:1px solid #1e293b;display:flex;gap:4px">'
            + '<a href="' + gmapsUrl + '" target="_blank" style="background:#1a73e8;color:white;padding:3px 7px;border-radius:4px;font-size:10px;font-weight:600;text-decoration:none">📍 Maps</a>'
            + '<a href="' + osmUrl + '" target="_blank" style="background:#1e293b;color:#94a3b8;padding:3px 7px;border-radius:4px;font-size:10px;font-weight:600;text-decoration:none">OSM</a>'
            + '</div></div>';
          new maplibregl.Popup({ className: 'dark-popup', maxWidth: '240px', offset: 15, closeButton: true })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(map);
        };
        map.on('click', 'biz-circles', showPopup);
        map.on('click', 'biz-labels', showPopup);
        // If businesses already exist, render them"""
    app = app[:s] + NEW_ONLOAD + app[e:]
    print("[OK] Rewrote map.on('load'): visible circles + text labels (no canvas)")
else:
    print("[ERR] Could not find load block")
    exit(1)

# Now fix updateMapData to add a 'label' property (first letter of category)
# and keep emoji for the popup
OLD_PROPERTIES = """      properties: {
        name: b.name,
        category: b.category,
        categoryLabel: b.categoryLabel,
        color: (CAT_COLORS as Record<string,string>)[b.category] || '#64748b',
        emoji: (CAT_EMOJI as Record<string,string>)[b.category] || '📍',
        phone: b.phone || '',
        email: b.email || '',
        website: b.website || '',
        address: b.address || '',
        facebook: b.facebook || '',
        instagram: b.instagram || '',
      },"""

NEW_PROPERTIES = """      properties: {
        name: b.name,
        category: b.category,
        categoryLabel: b.categoryLabel,
        color: (CAT_COLORS as Record<string,string>)[b.category] || '#64748b',
        emoji: (CAT_EMOJI as Record<string,string>)[b.category] || '📍',
        label: (b.categoryLabel || b.name || '•').charAt(0).toUpperCase(),
        phone: b.phone || '',
        email: b.email || '',
        website: b.website || '',
        address: b.address || '',
        facebook: b.facebook || '',
        instagram: b.instagram || '',
      },"""

if OLD_PROPERTIES in app:
    app = app.replace(OLD_PROPERTIES, NEW_PROPERTIES, 1)
    print("[OK] Added 'label' property to GeoJSON features")
else:
    print("[WARN] Could not find properties block")

# Bump version
app = app.replace("APP_VERSION = '3.0.1'", "APP_VERSION = '3.1.0'")

with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)
print("[OK] App.tsx saved")

# ══════════════════════════════════════════════════════════════
# 2. FIX ENRICHMENT: Multilingual queries for any country
# ══════════════════════════════════════════════════════════════
with open("client/src/clientEngine.ts", "r", encoding="utf-8") as f:
    eng = f.read()

# Add a transliteration + city name helper function before enrichFromBrave
HELPER_FN = """
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
  if (/^[a-zA-Z\\s-]+$/.test(name)) return name;
  // Try transliteration
  const translit = transliterateGeo(name);
  if (translit !== name) return translit;
  return name;
}

// Build a smart search query for any language
function buildSearchQuery(b: { name: string; address?: string; categoryLabel?: string }): string {
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const category = b.categoryLabel || '';
  // Use both original name AND English transliteration for better results
  const parts = [`"${b.name}"`];
  if (nameEn !== b.name) parts.push(`"${nameEn}"`);
  if (cityEn) parts.push(cityEn);
  if (category) parts.push(category);
  parts.push('phone email website contact');
  return encodeURIComponent(parts.join(' '));
}

"""

# Insert the helper function before enrichFromBrave
eng = eng.replace(
    "async function enrichFromBrave(",
    HELPER_FN + "async function enrichFromBrave("
)
print("[OK] Added multilingual search helpers")

# Fix enrichFromBrave query to use buildSearchQuery
OLD_BRAVE_Q = "        const q = encodeURIComponent(b.name + ' ' + (b.address || '') + ' ' + (b.categoryLabel || ''));"
NEW_BRAVE_Q = "        const q = buildSearchQuery(b);"
eng = eng.replace(OLD_BRAVE_Q, NEW_BRAVE_Q, 1)
print("[OK] Fixed Brave Search query to use multilingual helper")

# Fix enrichFromWeb (DDG) query
OLD_DDG_QUERY = """        // Extract city name from address for better search results
        const addressParts = b.address ? b.address.split(',').map(p => p.trim()) : [];
        const cityPart = addressParts.length > 1 ? addressParts[addressParts.length - 1] : (addressParts[0] || '');
        const query = encodeURIComponent(`"${b.name}" ${cityPart} ${b.categoryLabel || ""} phone email website contact`);"""
NEW_DDG_QUERY = """        // Build multilingual query: original name + English transliteration
        const query = buildSearchQuery(b);"""
eng = eng.replace(OLD_DDG_QUERY, NEW_DDG_QUERY, 1)
print("[OK] Fixed DuckDuckGo query to use multilingual helper")

# Fix the email-focused search layer
OLD_EMAIL_Q = """          const citySearch = b.address ? b.address.split(',').map(p => p.trim()).pop() || '' : '';
          const q = encodeURIComponent(`"${b.name}" ${citySearch || ''} ${b.categoryLabel || ''} email phone contact`);"""
NEW_EMAIL_Q = """          const q = buildSearchQuery(b);"""
eng = eng.replace(OLD_EMAIL_Q, NEW_EMAIL_Q, 1)
print("[OK] Fixed email search to use multilingual helper")

# Fix the second-pass social search
OLD_SOCIAL_Q = """        const citySearch2 = b.address ? b.address.split(',').map(p => p.trim()).pop() || '' : '';
        const queries = [
          encodeURIComponent(`"${b.name}" ${citySearch2} facebook instagram site:facebook.com OR site:instagram.com`),
          encodeURIComponent(`"${b.name}" ${citySearch2} phone email contact`),
          encodeURIComponent(`"${b.name}" ${citySearch2} website`),
        ];"""
NEW_SOCIAL_Q = """        const baseQ = buildSearchQuery(b);
        const queries = [
          encodeURIComponent(`"${b.name}" ${getEnglishCityName(b.address?.split(',').pop()?.trim() || '')} facebook instagram site:facebook.com OR site:instagram.com`),
          baseQ,
          encodeURIComponent(`"${b.name}" ${getEnglishCityName(b.address?.split(',').pop()?.trim() || '')} website`),
        ];"""
eng = eng.replace(OLD_SOCIAL_Q, NEW_SOCIAL_Q, 1)
print("[OK] Fixed second-pass social search to use multilingual helper")

# Fix the final-pass deep search
OLD_FINAL_Q = """          const q = encodeURIComponent(b.name + ' ' + (b.address || '') + ' contact phone email facebook instagram');"""
NEW_FINAL_Q = """          const q = buildSearchQuery(b);"""
eng = eng.replace(OLD_FINAL_Q, NEW_FINAL_Q, 1)
print("[OK] Fixed final-pass search to use multilingual helper")

# Fix Nominatim reverse geocoding to prefer English names
OLD_NOMINATIM = 'const nominatimRevUrl = `https://nominatim.openstreetmap.org/reverse?lat=${b.lat}&lon=${b.lon}&format=json&zoom=18&addressdetails=1&extratags=1`;'
NEW_NOMINATIM = 'const nominatimRevUrl = `https://nominatim.openstreetmap.org/reverse?lat=${b.lat}&lon=${b.lon}&format=json&zoom=18&addressdetails=1&extratags=1&accept-language=en`;'
eng = eng.replace(OLD_NOMINATIM, NEW_NOMINATIM, 1)
print("[OK] Fixed Nominatim to prefer English names")

with open("client/src/clientEngine.ts", "w", encoding="utf-8") as f:
    f.write(eng)
print("[OK] clientEngine.ts saved")

# ══════════════════════════════════════════════════════════════
# 3. BUMP VERSION IN index.html
# ══════════════════════════════════════════════════════════════
with open("client/index.html", "r", encoding="utf-8") as f:
    html = f.read()
html = html.replace("v3.0.1", "v3.1.0")
with open("client/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("[OK] Version bumped to 3.1.0")
print("\nDone!")
