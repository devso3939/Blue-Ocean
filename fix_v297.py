#!/usr/bin/env python3
"""v2.9.7: Fix map markers bleeding + improve enrichment"""
import re, os

os.chdir("C:/Users/Anania Light Laptop/Downloads/Blue Ocean")

# ══════════════════════════════════════════════════════════════
# 1. FIX MAP: Add overflow hidden to card container so markers stay inside
# ══════════════════════════════════════════════════════════════
with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()

# The map card wrapper needs overflow:hidden to contain MapLibre DOM markers
OLD_MAP_CARD = '<div className="rounded-xl border border-border bg-card">'
NEW_MAP_CARD = '<div className="rounded-xl border border-border bg-card overflow-hidden">'

# Only replace the map card, not other cards
# Find the map section comment and replace the next card div
count = 0
# Find the "{/* Map */}" comment and replace the card div after it
marker = '{/* Map */}'
idx = app.find(marker)
if idx >= 0:
    # Find the card div after the comment
    card_start = app.find(OLD_MAP_CARD, idx)
    if card_start >= 0:
        app = app[:card_start] + NEW_MAP_CARD + app[card_start + len(OLD_MAP_CARD):]
        count = 1
        print("[OK] Added overflow-hidden to map card container")

if count == 0:
    print("[WARN] Could not find map card div")

# ══════════════════════════════════════════════════════════════
# 2. FIX MAP: Remove the 'load' event handler that races with marker useEffect
# ══════════════════════════════════════════════════════════════
# The 'load' handler adds markers, but the businesses useEffect also adds markers
# This causes double-rendering. Remove the 'load' handler — the retry mechanism
# in the businesses useEffect handles it properly now.

# Actually, keep the load handler but DON'T fitBounds in it (let the businesses useEffect handle fitBounds)
# The load handler is needed because if businesses change BEFORE the map loads,
# the businesses useEffect can't add markers yet (map not ready).

OLD_LOAD = """      mapInstanceRef.current = map;
      // After map is ready, add markers if businesses already exist (fixes race condition)
      map.on('load', () => {
        requestAnimationFrame(() => {
          map.resize();
          addMarkers(map, businesses);
          const allBiz: Business[] = [];
          businesses.forEach(bizs => allBiz.push(...bizs));
          if (allBiz.length > 1) {
            const bounds = new (maplibregl as any).LngLatBounds();
            allBiz.forEach(b => bounds.extend([b.lon, b.lat]));
            map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 1200 });
          }
        });
      });
    });
  }, [selectedCity, opportunities.length]);"""

NEW_LOAD = """      mapInstanceRef.current = map;
      // After map loads, add markers if businesses already exist (race condition fix)
      map.on('load', () => {
        requestAnimationFrame(() => {
          map.resize();
          addMarkers(map, businesses);
        });
      });
    });
  }, [selectedCity, opportunities.length]);"""

if OLD_LOAD in app:
    app = app.replace(OLD_LOAD, NEW_LOAD, 1)
    print("[OK] Simplified map load handler")
else:
    print("[WARN] Could not find load handler block")

with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)
print("[OK] App.tsx saved")

# ══════════════════════════════════════════════════════════════
# 3. IMPROVE ENRICHMENT: Better queries + local language support
# ══════════════════════════════════════════════════════════════
with open("client/src/clientEngine.ts", "r", encoding="utf-8") as f:
    eng = f.read()

# Fix 3a: Improve DuckDuckGo query to include city name (not just street part)
OLD_DDG_Q = """        const cityPart = b.address ? b.address.split(',').pop()?.trim() || '' : '';
        const query = encodeURIComponent(`${b.name} ${cityPart} ${b.categoryLabel || ""} phone website contact`);"""
NEW_DDG_Q = """        // Extract city name from address for better search results
        const addressParts = b.address ? b.address.split(',').map(p => p.trim()) : [];
        const cityPart = addressParts.length > 1 ? addressParts[addressParts.length - 1] : (addressParts[0] || '');
        const query = encodeURIComponent(`"${b.name}" ${cityPart} ${b.categoryLabel || ""} phone email website contact`);"""
if OLD_DDG_Q in eng:
    eng = eng.replace(OLD_DDG_Q, NEW_DDG_Q, 1)
    print("[OK] Improved DDG query: quoted business name + city")

# Fix 3b: Increase DDG timeout from default to 12s
OLD_DDG_TIMEOUT = """        const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });"""
NEW_DDG_TIMEOUT = """        const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(12000),
        });"""
if OLD_DDG_TIMEOUT in eng:
    eng = eng.replace(OLD_DDG_TIMEOUT, NEW_DDG_TIMEOUT, 1)
    print("[OK] Added 12s timeout to DDG enrichment")

# Fix 3c: In the email search layer, also search for phone/website
OLD_EMAIL_SEARCH = """          // Targeted email search
          const q = encodeURIComponent(`"${b.name}" ${cityPart || ''} ${b.categoryLabel || ''} email contact`);"""
NEW_EMAIL_SEARCH = """          // Targeted email + phone search
          const citySearch = b.address ? b.address.split(',').map(p => p.trim()).pop() || '' : '';
          const q = encodeURIComponent(`"${b.name}" ${citySearch || ''} ${b.categoryLabel || ''} email phone contact`);"""
if OLD_EMAIL_SEARCH in eng:
    eng = eng.replace(OLD_EMAIL_SEARCH, NEW_EMAIL_SEARCH, 1)
    print("[OK] Email search now also targets phone numbers")

# Fix 3d: In the website scraping, also try the found website's /team and /about pages
OLD_CONTACT_PATHS = """    const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/kontakti', '/kontakt', '/contacte'];"""
NEW_CONTACT_PATHS = """    const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/kontakti', '/kontakt', '/contacte', '/team', '/info', '/impressum'];"""
if OLD_CONTACT_PATHS in eng:
    eng = eng.replace(OLD_CONTACT_PATHS, NEW_CONTACT_PATHS, 1)
    print("[OK] Added more contact page paths for scraping")

# Fix 3e: Make the second-pass social media search also try Georgian search terms
OLD_SOCIAL_PASS = """        const queries = [
          encodeURIComponent(`"${b.name}" ${cityPart} facebook instagram site:facebook.com OR site:instagram.com`),
          encodeURIComponent(`"${b.name}" ${cityPart} phone email contact`),
        ];"""
NEW_SOCIAL_PASS = """        const citySearch2 = b.address ? b.address.split(',').map(p => p.trim()).pop() || '' : '';
        const queries = [
          encodeURIComponent(`"${b.name}" ${citySearch2} facebook instagram site:facebook.com OR site:instagram.com`),
          encodeURIComponent(`"${b.name}" ${citySearch2} phone email contact`),
          encodeURIComponent(`"${b.name}" ${citySearch2} website`),
        ];"""
if OLD_SOCIAL_PASS in eng:
    eng = eng.replace(OLD_SOCIAL_PASS, NEW_SOCIAL_PASS, 1)
    print("[OK] Second pass: added website search query + improved city extraction")

with open("client/src/clientEngine.ts", "w", encoding="utf-8") as f:
    f.write(eng)
print("[OK] clientEngine.ts saved")

# ══════════════════════════════════════════════════════════════
# 4. BUMP VERSION TO 2.9.7
# ══════════════════════════════════════════════════════════════
with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()
app = app.replace("APP_VERSION = '2.9.6'", "APP_VERSION = '2.9.7'")
with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)

with open("client/index.html", "r", encoding="utf-8") as f:
    html = f.read()
html = html.replace("v2.9.6", "v2.9.7")
with open("client/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("[OK] Version bumped to 2.9.7")
print("\nDone!")
