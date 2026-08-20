#!/usr/bin/env python3
"""Fix remaining enrichment issues"""
import re, os

os.chdir("C:/Users/Anania Light Laptop/Downloads/Blue Ocean")

with open("client/src/clientEngine.ts", "r", encoding="utf-8") as f:
    eng = f.read()

# Fix 1: Add email extraction to enrichFromWeb (DuckDuckGo) - before the social media extraction
OLD_DDG_SOCIAL = """        // Extract Facebook/Instagram from search snippets
        const snippetMatch = html.match(/class="result__snippet"[^>]*>([^<]+)/g);"""
NEW_DDG_SOCIAL = """        // Extract email from search result text
        if (!b.email) {
          const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g);
          if (emails) {
            const junk = ['example.com', 'duckduckgo', 'googleapis', 'sentry', 'wixpress', 'cloudflare', 'schema.org'];
            for (const e of emails) {
              const clean = e.replace(/[\\s>);]+$/, '');
              if (junk.every(j => !clean.includes(j)) && clean.length > 6 && clean.length < 80) {
                b.email = clean;
                found++;
                break;
              }
            }
          }
        }
        // Extract Facebook/Instagram from search snippets
        const snippetMatch = html.match(/class="result__snippet"[^>]*>([^<]+)/g);"""

if OLD_DDG_SOCIAL in eng:
    eng = eng.replace(OLD_DDG_SOCIAL, NEW_DDG_SOCIAL, 1)
    print("[OK] Added email extraction to DuckDuckGo search results")
else:
    print("[WARN] Could not find DDG social extraction block")

# Fix 2: Also extract phone from the full DuckDuckGo response text (not just first match)
OLD_DDG_PHONE = """        // Extract phone numbers from search results
        if (!b.phone) {
          const phoneMatch = html.match(/(?:\\+?\\d[\\d\\s\\-\\.\\(\\)]{7,15})/);
          if (phoneMatch) {
            const phone = phoneMatch[0].trim();
            if (phone.length >= 8 && phone.length <= 20) {
              b.phone = phone;
              found++;
            }
          }
        }"""
NEW_DDG_PHONE = """        // Extract phone numbers from search results (look for local format too)
        if (!b.phone) {
          const phoneMatch = html.match(/(?:\\+?\\d[\\d\\s\\-\\.\\(\\)]{7,15})/);
          if (phoneMatch) {
            const phone = phoneMatch[0].trim();
            if (phone.length >= 8 && phone.length <= 20) {
              b.phone = phone;
              found++;
            }
          }
        }
        // Also look for Georgian-format phones (995 XXX XX XX XX)
        if (!b.phone) {
          const geoMatch = html.match(/\\+995\\s?\\d{3}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}/);
          if (geoMatch) {
            b.phone = geoMatch[0].trim();
            found++;
          }
        }"""

if OLD_DDG_PHONE in eng:
    eng = eng.replace(OLD_DDG_PHONE, NEW_DDG_PHONE, 1)
    print("[OK] Added Georgian phone format extraction to DDG")
else:
    print("[WARN] Could not find DDG phone block")

with open("client/src/clientEngine.ts", "w", encoding="utf-8") as f:
    f.write(eng)
print("[OK] clientEngine.ts saved")
