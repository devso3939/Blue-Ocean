#!/usr/bin/env python3
"""v2.9.6: Fix map pins race condition + improve email enrichment"""
import re, os

os.chdir("C:/Users/Anania Light Laptop/Downloads/Blue Ocean")

# ══════════════════════════════════════════════════════════════
# 1. FIX MAP: After async import resolves, add markers if businesses exist
# ══════════════════════════════════════════════════════════════
with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()

# FIX 1a: After map creation in the async import callback, add markers + fitBounds
OLD_MAP_CREATE = """      mapInstanceRef.current = map;
    });
  }, [selectedCity, opportunities.length]);"""

NEW_MAP_CREATE = """      mapInstanceRef.current = map;
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

if OLD_MAP_CREATE in app:
    app = app.replace(OLD_MAP_CREATE, NEW_MAP_CREATE, 1)
    print("✅ Fixed map creation: markers added after map 'load' event")
else:
    print("⚠️  Could not find map creation block (may already be fixed)")

# FIX 1b: In the marker useEffect, add retry if maplibreRef isn't loaded yet
OLD_MARKER_USEEFFECT = """  // Update markers whenever businesses change (separate from map creation)
  useEffect(() => {
    if (!mapInstanceRef.current || !maplibreRef.current) return;
    const map = mapInstanceRef.current;
    // Ensure map is sized correctly after React render
    requestAnimationFrame(() => {
      map.resize();
      addMarkers(map, businesses);
      // Auto-zoom to fit all markers
      const allBiz: Business[] = [];
      businesses.forEach(bizs => allBiz.push(...bizs));
      if (allBiz.length > 1) {
        const bounds = new (maplibreRef.current as any).LngLatBounds();
        allBiz.forEach(b => bounds.extend([b.lon, b.lat]));
        map.fitBounds(bounds, { padding: 80, maxZoom: 15, duration: 1200 });
      }
    });
  }, [businesses]);"""

NEW_MARKER_USEEFFECT = """  // Update markers whenever businesses change (separate from map creation)
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;
    const tryAddMarkers = () => {
      if (!maplibreRef.current) {
        // maplibre-gl not loaded yet — retry after short delay
        setTimeout(tryAddMarkers, 200);
        return;
      }
      requestAnimationFrame(() => {
        map.resize();
        addMarkers(map, businesses);
        const allBiz: Business[] = [];
        businesses.forEach(bizs => allBiz.push(...bizs));
        if (allBiz.length > 1) {
          const bounds = new (maplibreRef.current as any).LngLatBounds();
          allBiz.forEach(b => bounds.extend([b.lon, b.lat]));
          map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 1200 });
        }
      });
    };
    tryAddMarkers();
  }, [businesses]);"""

if OLD_MARKER_USEEFFECT in app:
    app = app.replace(OLD_MARKER_USEEFFECT, NEW_MARKER_USEEFFECT, 1)
    print("✅ Fixed marker useEffect: retries if maplibre not loaded yet")
else:
    print("⚠️  Could not find marker useEffect block")

# FIX 1c: Change zoom from 12 to 13 so pins are more visible at default zoom
# (12 is too zoomed out for 36px markers to be easily clickable)
# Actually 12 is fine, let's keep it

# FIX 1d: Make marker size slightly larger and ensure they have proper z-index
OLD_MARKER_STYLE = """el.style.cssText = `width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,0.7);border:2.5px solid rgba(255,255,255,0.9);transform-origin:bottom center;transition:transform 0.15s,box-shadow 0.15s;position:relative;z-index:1;`;"""

NEW_MARKER_STYLE = """el.style.cssText = `width:38px;height:38px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:19px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.8),0 0 0 2px rgba(255,255,255,0.85);transform-origin:bottom center;transition:box-shadow 0.15s;position:relative;z-index:2;pointer-events:auto;`;"""

if OLD_MARKER_STYLE in app:
    app = app.replace(OLD_MARKER_STYLE, NEW_MARKER_STYLE, 1)
    print("✅ Fixed marker style: bigger, better shadow, no transform on hover")
else:
    print("⚠️  Could not find marker style block")

# FIX 1e: Remove the hover translate effect that causes "running away" behavior
OLD_HOVER = """      el.onmouseenter = () => { el.style.transform = 'scale(1.25)'; el.style.boxShadow = '0 6px 20px rgba(0,0,0,0.8)'; el.style.zIndex = '999'; };
      el.onmouseleave = () => { el.style.transform = 'scale(1)'; el.style.boxShadow = '0 3px 12px rgba(0,0,0,0.7)'; el.style.zIndex = '1'; };"""

NEW_HOVER = """      el.onmouseenter = () => { el.style.boxShadow = '0 4px 20px rgba(0,0,0,0.9),0 0 0 3px rgba(255,255,255,1)'; el.style.zIndex = '999'; };
      el.onmouseleave = () => { el.style.boxShadow = '0 2px 10px rgba(0,0,0,0.8),0 0 0 2px rgba(255,255,255,0.85)'; el.style.zIndex = '2'; };"""

if OLD_HOVER in app:
    app = app.replace(OLD_HOVER, NEW_HOVER, 1)
    print("✅ Fixed hover: no transform, only glow effect")
else:
    print("⚠️  Could not find hover block")

with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)
print("✅ App.tsx saved")

# ══════════════════════════════════════════════════════════════
# 2. FIX ENRICHMENT: Better email extraction + more aggressive scraping
# ══════════════════════════════════════════════════════════════
with open("client/src/clientEngine.ts", "r", encoding="utf-8") as f:
    eng = f.read()

# FIX 2a: Improve enrichFromWebsite to scan /contact and /about pages
OLD_WEBSITE_FN = """async function enrichFromWebsite(b: Business): Promise<void> {
  if (!b.website) return;
  const urls = [b.website];
  // Also try common contact page paths
  const base = b.website.replace(/\\/$/, '');
  urls.push(base + '/contact', base + '/about', base + '/about-us', base + '/kontakti');

  for (const url of urls) {
    try {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const html = await r.text().then(t => t.substring(0, 30000));

      // Extract email from mailto links and text
      if (!b.email) {
        const mailtos = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/g);
        if (mailtos) {
          for (const m of mailtos) {
            const addr = m.replace('mailto:', '').trim();
            if (!addr.includes('example.com') && !addr.includes('sentry') && addr.length > 6) {
              b.email = addr;
              break;
            }
          }
        }
        if (!b.email) {
          const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              if (!e.includes('example.com') && !e.includes('wixpress') && !e.includes('sentry') && !e.includes('googleapis') && !e.includes('cloudflare') && e.length > 6 && e.length < 80) {
                b.email = e;
                break;
              }
            }
          }
        }
      }"""

NEW_WEBSITE_FN = """async function enrichFromWebsite(b: Business): Promise<void> {
  if (!b.website) return;
  const urls = [b.website];
  const base = b.website.replace(/\\/$/, '');
  // Extended contact page paths for different languages/platforms
  urls.push(
    base + '/contact', base + '/contact-us', base + '/about',
    base + '/about-us', base + '/kontakti', base + '/kontakt',
    base + '/team', base + '/impressum', base + '/imprint'
  );

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
  const junkDomains = ['example.com', 'wixpress', 'sentry', 'googleapis', 'cloudflare', 'schema.org', 'w3.org', 'facebook.com', 'google.com', 'instagram.com', 'twitter.com', 'yelp.com', 'tripadvisor', 'booking.com', 'pinterest', 'linkedin.com', 'youtube.com', 'tiktok.com', 'mapbox.com', 'maplibre', 'openstreetmap', 'jsdelivr', 'unpkg', 'gstatic', 'jquery', 'wordpress.org', 'gravatar', 'w.org', 'cloudfront'];

  for (const url of urls) {
    try {
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const html = await r.text().then(t => t.substring(0, 50000));

      // Extract email from mailto links and text
      if (!b.email) {
        const mailtos = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/g);
        if (mailtos) {
          for (const m of mailtos) {
            const addr = m.replace('mailto:', '').trim();
            if (junkDomains.every(d => !addr.includes(d)) && addr.length > 6) {
              b.email = addr;
              break;
            }
          }
        }
        // Decode Cloudflare email protection
        if (!b.email) {
          const cfEmails = html.match(/data-cfemail="([a-f0-9]+)"/g);
          if (cfEmails) {
            for (const cf of cfEmails) {
              const hex = cf.match(/"([a-f0-9]+)"/)?.[1];
              if (hex && hex.length >= 8) {
                let decoded = '';
                const key = parseInt(hex.substring(0, 2), 16);
                for (let i = 2; i < hex.length; i += 2) {
                  decoded += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16) ^ key);
                }
                if (decoded.includes('@') && junkDomains.every(d => !decoded.includes(d))) {
                  b.email = decoded;
                  break;
                }
              }
            }
          }
        }
        if (!b.email) {
          const emails = html.match(emailRegex);
          if (emails) {
            for (const e of emails) {
              if (junkDomains.every(d => !e.includes(d)) && e.length > 6 && e.length < 80) {
                b.email = e;
                break;
              }
            }
          }
        }
      }"""

if OLD_WEBSITE_FN in eng:
    eng = eng.replace(OLD_WEBSITE_FN, NEW_WEBSITE_FN, 1)
    print("✅ Fixed enrichFromWebsite: more contact paths + Cloudflare decode + better filtering")
else:
    print("⚠️  Could not find enrichFromWebsite (checking partial match)")
    # Try partial match
    if 'async function enrichFromWebsite' in eng:
        print("  Function exists, trying smaller replacement...")
        # Find and replace just the URL list expansion
        OLD_URLS = """  const urls = [b.website];
  // Also try common contact page paths
  const base = b.website.replace(/\\/$/, '');
  urls.push(base + '/contact', base + '/about', base + '/about-us', base + '/kontakti');"""
        NEW_URLS = """  const urls = [b.website];
  const base = b.website.replace(/\\/$/, '');
  urls.push(
    base + '/contact', base + '/contact-us', base + '/about',
    base + '/about-us', base + '/kontakti', base + '/kontakt',
    base + '/team', base + '/impressum', base + '/imprint'
  );"""
        if OLD_URLS in eng:
            eng = eng.replace(OLD_URLS, NEW_URLS, 1)
            print("  ✅ Fixed URL list")

# FIX 2b: In the email-focused search (Layer 2.7), improve the query to be smarter
OLD_EMAIL_Q = """          const q = encodeURIComponent(`"${b.name}" ${cityPart} email`);"""
NEW_EMAIL_Q = """          const q = encodeURIComponent(`"${b.name}" ${cityPart || ''} ${b.categoryLabel || ''} email contact`);"""
eng = eng.replace(OLD_EMAIL_Q, NEW_EMAIL_Q, 1)

# FIX 2c: Improve the DuckDuckGo web search to scan more results (increase from 60 to 100 businesses)
OLD_DDG_LIMIT = """  const hasWebsite = allBizList.filter(b => b.website && (!b.facebook || !b.instagram || !b.phone || !b.email));
  const webBatch = 5;
  for (let i = 0; i < Math.min(hasWebsite.length, 80); i += webBatch) {"""
NEW_DDG_LIMIT = """  const hasWebsite = allBizList.filter(b => b.website && (!b.facebook || !b.instagram || !b.phone || !b.email));
  const webBatch = 5;
  for (let i = 0; i < Math.min(hasWebsite.length, 100); i += webBatch) {"""
eng = eng.replace(OLD_DDG_LIMIT, NEW_DDG_LIMIT, 1)

# FIX 2d: In enrichFromWeb (DuckDuckGo), also extract emails from search result descriptions
OLD_DDG_EXTRACT = """          // Extract from search result descriptions and snippets
          const allText = html.join(' ');
          if (!b.website) {
            // Look for URLs in results
            const urls = html.join(' ').match(/https?:\\/\\/[^\\s"'<>]+/g) || [];
            for (const u of urls) {
              const clean = u.replace(/[)\\]}>]+$/, '');
              if (clean.includes(b.name.toLowerCase().replace(/\\s+/g, '')) || clean.includes(b.name.toLowerCase().split(' ')[0])) {
                if (!clean.match(/google\\.|facebook|instagram|yelp|tripadvisor|wikipedia|duckduckgo|youtube/i)) {
                  b.website = clean;
                  break;
                }
              }
            }
          }"""

NEW_DDG_EXTRACT = """          // Extract from search result descriptions and snippets
          const allText = html.join(' ');
          // Extract emails from search result snippets (many results show email in description)
          if (!b.email) {
            const descEmails = allText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g);
            if (descEmails) {
              for (const e of descEmails) {
                const clean = e.replace(/[\\s>);]+$/, '');
                const junk = ['example.com', 'duckduckgo', 'googleapis', 'sentry.io', 'wixpress', 'cloudflare', 'schema.org', 'w3.org'];
                if (junk.every(j => !clean.includes(j)) && clean.length > 6 && clean.length < 80) {
                  b.email = clean;
                  break;
                }
              }
            }
          }
          if (!b.website) {
            // Look for URLs in results
            const urls = html.join(' ').match(/https?:\\/\\/[^\\s"'<>]+/g) || [];
            for (const u of urls) {
              const clean = u.replace(/[)\\]}>]+$/, '');
              if (clean.includes(b.name.toLowerCase().replace(/\\s+/g, '')) || clean.includes(b.name.toLowerCase().split(' ')[0])) {
                if (!clean.match(/google\\.|facebook|instagram|yelp|tripadvisor|wikipedia|duckduckgo|youtube/i)) {
                  b.website = clean;
                  break;
                }
              }
            }
          }"""

if OLD_DDG_EXTRACT in eng:
    eng = eng.replace(OLD_DDG_EXTRACT, NEW_DDG_EXTRACT, 1)
    print("✅ Fixed DuckDuckGo: extract emails from search snippets")
else:
    print("⚠️  Could not find DDG extract block")

# FIX 2e: In the second pass social media search, also extract emails
OLD_SOCIAL2 = """            if (!b.email) {
              const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
              if (m && !m[0].includes('example.com') && !m[0].includes('duckduckgo')) b.email = m[0];
            }
          } catch {}
        }
      } catch {}
    }));
    if (i + socialBatch < stillMissingSocial.length) await wait(2000);"""

NEW_SOCIAL2 = """            if (!b.email) {
              const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
              const junk = ['example.com', 'duckduckgo', 'googleapis', 'sentry'];
              if (m && junk.every(j => !m[0].includes(j))) b.email = m[0];
            }
            // Also extract phone from full text
            if (!b.phone) {
              const m = html.match(/(?:\\+?\\d[\\d\\s\\-\\.\\(\\)]{7,15})/g);
              if (m) {
                for (const p of m) {
                  if (p.replace(/[^\\d]/g, '').length >= 8) { b.phone = p.trim(); break; }
                }
              }
            }
          } catch {}
        }
      } catch {}
    }));
    if (i + socialBatch < stillMissingSocial.length) await wait(2000);"""

if OLD_SOCIAL2 in eng:
    eng = eng.replace(OLD_SOCIAL2, NEW_SOCIAL2, 1)
    print("✅ Fixed second pass: also extracts phone from social search")
else:
    print("⚠️  Could not find second pass social block")

with open("client/src/clientEngine.ts", "w", encoding="utf-8") as f:
    f.write(eng)
print("✅ clientEngine.ts saved")

# ══════════════════════════════════════════════════════════════
# 3. BUMP VERSION TO 2.9.6
# ══════════════════════════════════════════════════════════════
with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()

app = app.replace("APP_VERSION = '2.9.3'", "APP_VERSION = '2.9.6'")
# Fix any hardcoded version badges
app = re.sub(r'v2\.9\.[0-9]', 'v2.9.6', app)

with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)
print("✅ Version bumped to 2.9.6")

print("\n🎉 All fixes applied!")
