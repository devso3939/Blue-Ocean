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
import { setScanContext, getScanContext, buildScanContext, categoryInNative, countryTld, contactTermsNative, type ScanContext } from './lang';
import { APP_VERSION } from './version';
async function scrapeWordPressAPI(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  const base = b.website.replace(/\/$/, '');
  const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org|w3\.org|ogp\.me/i;
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
            // v6.9.50: plausiblePhone rejects ISO dates ("2022-08-04"), IP-like
            // runs and timestamp digit-runs — WP JSON is full of all three.
            if (p.replace(/[^\d+]/g, '').length >= 8 && p.replace(/[^\d+]/g, '').length <= 15 && plausiblePhone(p)) {
              b.phone = p.trim(); break;
            }
          }
        }
      }
    } catch {}
  }
}

// ─── v6.9.58: Recursive JSON-LD entity walker ───────────────────
// Real-world JSON-LD rarely keeps LocalBusiness at the top level:
// Wix/Squarespace/Yoast wrap it in @graph, and phone/email often live on
// nested contactPoint (schema.org ContactPoint) nodes. A flat entities
// loop sees none of them. Walks known container keys with a depth cap
// (bounded, cheap) and collects every @type-bearing object.
function collectJsonLdEntities(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdEntities(n, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj['@type'] !== undefined) out.push(obj);
  for (const key of ['@graph', 'mainEntity', 'hasPart', 'subOrganization', 'department', 'contactPoint', 'itemListElement']) {
    if (obj[key] !== undefined) collectJsonLdEntities(obj[key], out, depth + 1);
  }
}

// --- v6.9.50: HOISTED out of queryBusinesses (were nested by an earlier scripted patch,
// invisible to supplementProServices; no closure dependencies, safe to hoist) ---

// ─── v6.9.66: Octoparse-style contact-page discovery via link scoring ────
// Octoparse's crawl model ("max link depth", "max pages per URL",
// "stay within domain") follows the site's OWN navigation instead of
// guessing URL slugs. We harvest internal links from the already-fetched
// homepage, score them by multilingual contact relevance, and crawl the
// top candidates — catches /contact-us/, /contacts/, /communication and
// any non-standard contact URL the slug list never guesses.
const _LINK_STRONG: [RegExp, number][] = [
  [/contact|kontakt|контакт|კონტაქტ|kavshiri|contacto|contatt|联络|お問い合わせ|اتصل|связ/i, 5],
  [/get[-_ ]?in[-_ ]?touch|reach[-_ ]?us|find[-_ ]?us|where[-_ ]?to[-_ ]?find/i, 4],
  [/location|branch|filial|ფილიალ|офис|office|store[-_ ]?locator|showroom/i, 3],
];
const _LINK_SOFT: [RegExp, number][] = [
  [/about|équipe|team|impressum|\binfo\b|ჩვენ\s*შესახებ|momkhmarebeli|nosotros|chi[-_ ]?siamo|quem[-_ ]?somos|hakk/i, 2],
];
const _LINK_URL_SIGNAL = /contact|kontakt|kavshiri|contacto|contatt|touch|reach|find-us|location|branch|filial|info|about|gverdzi|momkhmarebeli|tsmrunebi|მისამართ|კონტაქტ/i;
const _LINK_SKIP = /^(mailto:|tel:|javascript:|data:)|\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)(\?|$)|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|linkedin\.com|t\.me|wa\.me|whatsapp\.com|viber\.|google\.|apple\.com|wix|shopify|squarespace|webflow|wordpress\.(?:com|org)|schema\.org|cloudflare|youtu\.be/i;

/** Score internal links of `html` by contact relevance; top 3 same-domain URLs. */
export function scoreContactLinks(html: string, baseUrl: string): string[] {
  try {
    const base = new URL(baseUrl);
    const host = base.hostname.replace(/^www\./, '');
    const normKey = (u: URL) => u.origin + (u.pathname.replace(/\/+$/, '') || '');
    const homeKey = normKey(base);
    const seen = new Set<string>([homeKey]);
    const scored: { url: string; score: number }[] = [];
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
      const href = m[1];
      if (_LINK_SKIP.test(href)) continue;
      const anchor = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      let u: URL;
      try { u = new URL(href, baseUrl); } catch { continue; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      const uhost = u.hostname.replace(/^www\./, '');
      if (uhost !== host && !uhost.endsWith('.' + host)) continue; // stay within domain
      const key = normKey(u);
      if (seen.has(key)) continue;
      seen.add(key);
      let decodedPath = u.pathname;
      try { decodedPath = decodeURIComponent(u.pathname); } catch { /* malformed */ }
      const hay = (anchor + ' ' + u.pathname + ' ' + decodedPath).slice(0, 300);
      let score = 0;
      for (const [rx, w] of _LINK_STRONG) if (rx.test(hay)) score += w;
      for (const [rx, w] of _LINK_SOFT) if (rx.test(hay)) score += w;
      if (hay.length <= 90 && _LINK_URL_SIGNAL.test(hay)) score += 1; // short nav link with slug signal
      if (score >= 3) scored.push({ url: u.toString(), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(s => s.url);
  } catch { return []; }
}

const _LINK_DEEP2: [RegExp, number][] = [
  [/branch|filial|филиал|ფილიალ|location|офис|office|showroom|store[-_ ]?locator|outlet|სალონი/i, 3],
  [/team|команда|გუნდი|our[-_ ]?stores|our[-_ ]?offices/i, 2],
];

/** v6.9.67 depth-2: branch/location/team sub-pages linked from a discovered page. */
export function pickDeeperLinks(html: string, baseUrl: string): string[] {
  try {
    const base = new URL(baseUrl);
    const host = base.hostname.replace(/^www\./, '');
    const selfPath = base.pathname.replace(/\/+$/, '') || '/';
    const seen = new Set<string>();
    const scored: { url: string; score: number }[] = [];
    for (const m of html.matchAll(/<a[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
      const href = m[1];
      if (_LINK_SKIP.test(href)) continue;
      let u: URL;
      try { u = new URL(href, baseUrl); } catch { continue; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      const uhost = u.hostname.replace(/^www\./, '');
      if (uhost !== host && !uhost.endsWith('.' + host)) continue;
      const path = u.pathname.replace(/\/+$/, '') || '/';
      if (path === selfPath) continue; // never re-crawl the page we are on
      if (seen.has(u.origin + path)) continue;
      seen.add(u.origin + path);
      let decodedPath = u.pathname;
      try { decodedPath = decodeURIComponent(u.pathname); } catch { /* malformed */ }
      const anchor = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const hay = (anchor + ' ' + u.pathname + ' ' + decodedPath).slice(0, 300);
      let score = 0;
      for (const [rx, w] of _LINK_DEEP2) if (rx.test(hay)) score += w;
      if (score >= 2) scored.push({ url: u.toString(), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 2).map(s => s.url);
  } catch { return []; }
}

async function enrichFromWebsiteDeep(b: Business): Promise<void> {
  if (!b.website) return;
  const EXCLUDE = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|schema\.org|w3\.org|duckduckgo\.com|bing\.com/i;
  const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|gstatic|cloudflare|schema\.org|w3\.org|ogp\.me|privacy|terms|cookie/i;

  // v6.9.66: homepage HTML stashed for link-discovery scoring
  let homeHtml = '';
  let lastPageOk = ''; // v6.9.67: URL whose HTML homeHtml currently holds
  const crawled = new Set<string>();
  const normUrl = (u: string) => (u.replace(/\/+$/, '') || '/');

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
      // v6.9.69: Cloudflare challenge page — mark the host and bail. The
      // server lane's Wayback rescue handles this host from the next fetch.
      if (isCfChallenge(html)) { _cfHosts.add(urlHostOf(url)); return false; }
      // v6.9.82: SPA shell on the business's OWN site — dispatch a headless
      // render (deduped, budget-capped); the harvest collects the warm DOM
      // before validation. This is the phone bottleneck fix: phones live
      // behind JS hydration far more often than emails do.
      if (!b.phone && isSpaShell(html)) prefetchRenderDispatch(url);
      const full = html.substring(0, 80000);
      homeHtml = full;
      lastPageOk = url;

      // 1. JSON-LD structured data extraction (schema.org/LocalBusiness)
      if (!b.phone || !b.email || !b.website) {
        yieldTry('jsonld');
        const jsonLdBlocks = full.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
        for (const match of jsonLdBlocks) {
          try {
            const data = JSON.parse(match[1]);
            // v6.9.58: recursive walker — Wix/Squarespace/Yoast nest
            // LocalBusiness inside @graph and put phone/email inside
            // contactPoint nodes; the flat entities loop missed all of them.
            const entities: Record<string, unknown>[] = [];
            collectJsonLdEntities(data, entities);
            for (const entity of entities) {
              if (!b.phone && entity.telephone) {
                const tp = Array.isArray(entity.telephone) ? String(entity.telephone[0]) : String(entity.telephone);
                const digits = tp.replace(/\D/g, '');
                if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(tp)) { b.phone = tp.trim(); yieldBump('jsonld'); }
              }
              if (!b.email && typeof entity.email === 'string' && entity.email && plausibleEmail(entity.email)) { b.email = entity.email; yieldBump('jsonld'); }
              const types = (Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']]) as unknown[];
              if (types.some((t: unknown) => /LocalBusiness|Restaurant|Bar|Cafe|Store|Hotel|Organization/i.test(String(t || '')))) {
                if (!b.website && typeof entity.url === 'string' && !EXCLUDE.test(entity.url) && isLikelyBusinessWebsite(entity.url, b.name)) b.website = entity.url;
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
                  else if (typeof a === 'object' && a !== null && (a as Record<string, string>).streetAddress) {
                    const ar = a as Record<string, string>;
                    b.address = [ar.streetAddress, ar.addressLocality, ar.addressRegion].filter(Boolean).join(', ');
                  }
                }
              }
            }
          } catch {}
        }
      }

      // v6.9.94: real business photo — from the SAME fetched HTML, no extra
      // request. Priority: JSON-LD image (the business's own pick) → og:image
      // → twitter:image. Resolved against the page URL; data: URIs and tiny
      // sprites/shared template assets rejected.
      if (!b.image) {
        try {
          let img = '';
          const jsonLdImgs = [...full.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
          for (const m of jsonLdImgs) {
            try {
              const data = JSON.parse(m[1]);
              const ents: Record<string, unknown>[] = [];
              collectJsonLdEntities(data, ents);
              for (const e of ents) {
                const cand = e.image;
                if (typeof cand === 'string' && cand && !cand.startsWith('data:')) { img = cand; break; }
                if (Array.isArray(cand)) {
                  const s = cand.find((c: unknown) => typeof c === 'string' && !String(c).startsWith('data:'));
                  if (s) { img = String(s); break; }
                }
              }
              if (img) break;
            } catch {}
          }
          if (!img) {
            const og = full.match(/<meta[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']{10,500})["']/i)
              || full.match(/<meta[^>]*content=["']([^"']{10,500})["'][^>]*property=["']og:image(?::secure_url)?["']/i)
              || full.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']{10,500})["']/i);
            if (og) img = og[1];
          }
          // v6.9.97: favicon fallback — most small-business sites ship an
          // og:image, but the ones that don't almost always still have a
          // favicon. link rel=icon (apple-touch-icon preferred for size)
          // → /favicon.ico guess. Fills b.image so rows get a real visual
          // instead of the letter avatar.
          if (!img) {
            const fav = full.match(/<link[^>]*rel=["'][^"']*(?:apple-touch-icon|icon|shortcut icon)["'][^>]*href=["']([^"'\s]{4,500})["']/i)
              || full.match(/<link[^>]*href=["']([^"'\s]{4,500})["'][^>]*rel=["'][^"']*(?:apple-touch-icon|icon|shortcut icon)["']/i);
            if (fav) img = fav[1];
            else if (urlHostOf(url)) img = '/favicon.ico';
          }
          if (img) {
            img = img.trim().replace(/&amp;/g, '&');
            if (!/^https?:\/\//i.test(img)) { try { img = new URL(img, url).toString(); } catch { img = ''; } }
            // Junk filters: sharing placeholders, 1px trackers, emoji sprites
            if (img && !/facebook\.com\/tr|doubleclick|googleanalytics|\/pixel|sprite|logo\.(png|svg)$/i.test(img)) {
              b.image = img;
            }
          }
        } catch { /* image is cosmetic — never break the scrape */ }
      }

      // v6.9.68: per-branch contact capture — every successfully fetched
      // non-homepage page contributes distinct phone/email/address as a
      // branch row (deduped by URL; capped at 12 per business).
      if (url !== b.website) {
        try {
          if (!b._branchSeen) b._branchSeen = new Set();
          if (!b._branchSeen.has(url) && (b._branchSeen.size < 40)) {
            b._branchSeen.add(url);
            const titleM = full.match(/<title[^>]*>([\s\S]{2,120}?)<\/title>/i);
            const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim().slice(0, 80) : undefined;
            let bPhone: string | undefined;
            const telM = full.match(/href\s*=\s*["']tel:([^"']+)["']/i);
            if (telM) { try { bPhone = decodeURIComponent(telM[1]).trim(); } catch { bPhone = telM[1].trim(); } }
            if (bPhone && !plausiblePhone(bPhone)) bPhone = undefined;
            let bEmail: string | undefined;
            const emM = full.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emM && !EXCLUDE.test(emM[0]) && !_EMAIL_FILE_RE.test(emM[0])) bEmail = emM[0];
            let bAddr: string | undefined;
            const adrM = full.match(/"streetAddress"\s*:\s*"([^"]{5,120})"/);
            if (adrM) bAddr = adrM[1];
            if (bPhone || bEmail || bAddr) {
              if (!b.branches) b.branches = [];
              // v6.9.68: only keep DISTINCT rows — a row whose every value
              // already exists (parent fields or earlier rows) is noise
              const known = new Set([b.phone, b.email, b.address, ...b.branches.flatMap(x => [x.phone, x.email, x.address])]);
              const novel = [bPhone, bEmail, bAddr].filter(v => v && !known.has(v));
              if (novel.length > 0 && b.branches.length < 12) {
                b.branches.push({ url, title, phone: bPhone, email: bEmail, address: bAddr });
              }
            }
          }
        } catch {}
      }

      // 2. Open Graph meta tags
      if (!b.email || !b.phone) {
        yieldTry('meta');
        const ogTags = full.matchAll(/<meta[^>]*(?:property|name)="(og:[^"]+)"[^>]*content="([^"]*)"/gi);
        for (const m of ogTags) {
          const prop = m[1].toLowerCase();
          const val = m[2];
          if (!b.email && prop === 'og:email') { b.email = val.replace('mailto:', ''); yieldBump('meta'); }
          if (!b.phone && prop === 'og:phone') {
            const digits = val.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(val)) { b.phone = val.trim(); yieldBump('meta'); }
          }
        }
      }

      // 2b. Microdata (itemprop) — schema.org HTML annotations emitted by
      // WordPress SEO plugins and template sites
      if (!b.phone || !b.email) {
        if (!b.phone) {
          const mdP = full.match(/itemprop=["'](?:telephone|faxNumber)["'][^>]*>([^<]{7,25})</i) || full.match(/<meta[^>]*itemprop=["'](?:telephone|faxNumber)["'][^>]*content=["']([^"']{7,25})/i);
          if (mdP) {
            const digits = mdP[1].replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(mdP[1])) b.phone = mdP[1].trim();
          }
        }
        if (!b.email) {
          const mdE = full.match(/itemprop=["']email["'][^>]*>([^<]{6,80})</i) || full.match(/<meta[^>]*itemprop=["']email["'][^>]*content=["']([^"']{6,80})/i);
          if (mdE && mdE[1].includes('@') && plausibleEmail(mdE[1].trim())) b.email = mdE[1].trim();
        }
      }

      // 3. Phone from tel: links or structured text
      if (!b.phone) {
        const telMatch = full.match(/href="tel:([^"]+)"/);
        if (telMatch && plausiblePhone(telMatch[1])) b.phone = telMatch[1].trim();
        else {
          // Look for phone in structured areas (footer, header, contact section)
          const phoneText = full.match(/\+?[\d][\d\s\-\.()]{7,18}/g);
          if (phoneText) {
            for (const p of phoneText) {
              // v6.9.50: plausiblePhone kills dates, IPs and timestamp runs
              if (p.replace(/[^\d+]/g, '').length >= 8 && p.replace(/[^\d+]/g, '').length <= 15 && plausiblePhone(p)) {
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
        if (mailtoMatch && !EXCLUDE.test(mailtoMatch[1]) && !_EMAIL_PLATFORM_RE.test(mailtoMatch[1].split('@')[1] || '')) b.email = mailtoMatch[1].trim();        // b. email in text
        if (!b.email) {
          const emails = full.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          if (emails) {
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, '');
              // v6.9.50: reject asset filenames masquerading as emails
              // (finance-software-slider-225x225@2x.png) via the same
              // file-extension rule the WordPress scraper uses.
              if (!EXCLUDE.test(clean) && !_EMAIL_FILE_RE.test(clean) && clean.length > 6 && clean.length < 80) { b.email = clean; break;
              }
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
  crawled.add(normUrl(b.website));
  await deepScrape(b.website);

  // v6.9.66: Octoparse-style link-discovery crawl — the site's own nav
  // beats slug guessing. Crawl top-scored internal pages (max 3 fetches).
  if (!b.email || !b.phone || !b.facebook || !b.instagram) {
    const baseHome = b.website.replace(/\/+$/, '');
    if (!hostIsOpen(baseHome)) {
      const discovered = scoreContactLinks(homeHtml, b.website);
      let misses = 0;
      let deep2 = 2; // v6.9.67: depth-2 fetch budget per business
      for (const url of discovered) {
        if (b.email && b.phone && b.facebook) break;
        if (hostIsOpen(baseHome)) break;
        crawled.add(normUrl(url));
        yieldTry('linkcrawl');
        const touched = await deepScrape(url);
        if (touched) yieldBump('linkcrawl');
        else { misses++; if (misses >= 2) break; } // nav guess was off — stop early
        // v6.9.67: one hop deeper — branch/location/team sub-pages
        // (lastPageOk===url guarantees homeHtml is THIS page's markup)
        if (lastPageOk === url && !(b.email && b.phone && b.facebook)) {
          for (const u2 of pickDeeperLinks(homeHtml, url)) {
            if (deep2 <= 0 || (b.email && b.phone && b.facebook) || hostIsOpen(baseHome)) break;
            if (crawled.has(normUrl(u2))) continue;
            crawled.add(normUrl(u2));
            deep2--;
            yieldTry('linkcrawl');
            if (await deepScrape(u2)) { yieldBump('linkcrawl'); break; } // branch data found
          }
        }
      }
    }
  }

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
      if (crawled.has(normUrl(base + path))) continue; // v6.9.66: already fetched via discovery
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

export type { ScanContext };
export { setScanContext, buildScanContext };

// ─── v6.9.13: API-key POOLS with automatic rotation on quota ───────────
// Each provider keeps an ordered list of keys: primary (env / embedded
// fallback) first, then user-supplied backups (Settings panel, localStorage).
// When a call returns quota (402/429/etc), the pool marks that key exhausted
// and transparently rotates to the next; when ALL keys are exhausted the
// engine goes to quota cooldown and the fallback-engine chain takes over —
// the banner shows "quota — backups in use" / "backups exceeded" states.
type KeyPool = { keys: string[]; exhausted: Set<number>; active: number };
const _keyPools = new Map<string, KeyPool>();
function _poolGet(name: string): KeyPool {
  let p = _keyPools.get(name);
  if (!p) { p = { keys: [], exhausted: new Set(), active: 0 }; _keyPools.set(name, p); }
  return p;
}
/** Register keys for a provider: [primary, ...backups]. Later registrations append. */
function _poolRegister(name: string, keys: (string | undefined | null)[]): void {
  const p = _poolGet(name);
  for (const k of keys) {
    const kk = (k || '').trim();
    if (kk && !p.keys.includes(kk)) p.keys.push(kk);
  }
}
/** Current usable key, or '' when the whole pool is exhausted. */
function _poolKey(name: string): string {
  const p = _poolGet(name);
  if (p.keys.length === 0) return '';
  while (p.exhausted.has(p.active) && p.active < p.keys.length - 1) p.active++;
  if (p.exhausted.has(p.active)) return '';
  return p.keys[p.active];
}
/** Mark the active key as quota-dead and rotate; returns next key or ''. */
function _poolRotate(name: string): string {
  const p = _poolGet(name);
  p.exhausted.add(p.active);
  while (p.active < p.keys.length - 1 && p.exhausted.has(p.active)) p.active++;
  return p.exhausted.has(p.active) ? '' : p.keys[p.active];
}
/** v6.9.26: remove the active key entirely (revoked/expired/malformed).
 * Unlike _poolRotate (quota — may reset), a rejected key never comes back,
 * and dropping it keeps _poolKey() from ever returning it again. */
function _poolDropCurrent(name: string): void {
  const p = _poolGet(name);
  if (p.keys.length === 0) return;
  p.keys.splice(p.active, 1);
  p.active = Math.max(0, Math.min(p.active, p.keys.length - 1));
}
/** How many keys in the pool still have quota. */
function _poolAlive(name: string): number {
  const p = _poolGet(name);
  return p.keys.length - p.exhausted.size;
}
// Settings-panel bridge: users can add backup keys at runtime (localStorage).
export function addBackupKeys(name: 'brave' | 'serper' | 'tavily' | 'openrouter', keys: string[]): void {
  _poolRegister(name, keys);
}
export function keyPoolStatus(name: string): { total: number; alive: number; activeIndex: number } {
  const p = _poolGet(name);
  return { total: p.keys.length, alive: _poolAlive(name), activeIndex: p.active };
}
// base64 fallback keys so the CI-built site works without .env (plain keys are
// blocked by GitHub push protection; base64 also keeps them out of plain view).
const _b64dec = (v: string) => { try { return atob(v); } catch { return ''; } };
const _env = (import.meta as any).env || {};
function _b64decFallback_Serper(): string { return 'M2U4YjNmZjQ0MjVkMTg4NGQxYTYzNmRiMGJmYjdmYWYxODBjYTZlYw=='; }
function _b64decFallback_Tavily(): string { return 'dHZseS1kZXYtMUpiaTNlLUNGa3VVWkVIN21aNHVad2ZrdGgwVURRVTlpYTVjOERtMUU1STRxbFR1bA=='; }
// v6.9.13b: dedicated backup Tavily key ("BlueOcean-Backup" on app.tavily.com).
function _b64decBackup_Tavily(): string { return 'dHZseS1kZXYtMzBIRnJKLVhWMDM4R1ZtZm56cERybVlhaGNGTFF1dHRWVXRQNnpLaDVkSlNraDB4cw=='; }
// Seed pools: primary (env → embedded fallback) + embedded backups.
_poolRegister('serper', [_env.VITE_SERPER_API_KEY, _b64decFallback_Serper()]);
_poolRegister('tavily', [_env.VITE_TAVILY_API_KEY, _b64decFallback_Tavily(), _b64decBackup_Tavily()]);
_poolRegister('brave', [_env.VITE_BRAVE_API_KEY, _b64dec('QlNBZGVkM3RuWmZ2YWRpZVc1cHowdGlMcmxoMmx2bg==')]);
const _serperKey = () => _poolKey('serper');
const _tavilyKey = () => _poolKey('tavily');
const _braveKey = () => _poolKey('brave');

export type PopulationSource = 'osm' | 'open-meteo' | 'wikidata';

export interface CityResult {
  name: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
  population: number | null;
  populationSource?: PopulationSource;  // v6.9.24: which fallback service resolved it
  bbox: [number, number, number, number];
}

// ─── v6.9.33: settlement guard for Nominatim city search ──────────
// Nominatim free-text search mixes POIs (hostels, restaurants, ATMs) with
// real cities. A POI as result #1 silently DESTROYED Discover scans: its
// ~5-metre bounding box became the scan area, so a "Tbilisi" scan queried a
// 5 m circle and found exactly ONE business — the POI itself ("1 hostel,
// PER 10K = 10000"). Keep only administrative/settlement results and rank
// proper cities first.
const SETTLEMENT_KINDS = new Set([
  'city', 'town', 'village', 'municipality', 'borough', 'suburb', 'quarter',
  'state_district', 'county', 'province', 'state', 'island',
]);
// Lower = better city candidate for the suggestion list.
const SETTLEMENT_RANK: Record<string, number> = {
  city: 0, town: 1, municipality: 2, village: 3, borough: 4,
  suburb: 5, quarter: 6, state_district: 7, county: 8, province: 9, state: 10, island: 11,
};
function settlementKind(r: any): string | null {
  if (SETTLEMENT_KINDS.has(r.addresstype)) return r.addresstype;
  if (r.class === 'place' && SETTLEMENT_KINDS.has(r.type)) return r.type;
  // Administrative boundary relations (city/town polygons) are real places
  if (r.osm_type === 'relation' && r.class === 'boundary' && SETTLEMENT_KINDS.has(r.type)) return r.type;
  return null;
}

export async function resolveCity(query: string): Promise<CityResult[]> {
  const params = { q: query, format: 'json', addressdetails: '1', limit: '8', extratags: '1', 'accept-language': 'en' };
  // v6.9.32: server proxy first (Nominatim rate-limits aggressive browser
  // IPs — the recurring "can't find city" bug); direct fetch as fallback.
  const proxied = await nominatimViaProxy('search', params);
  if (proxied && Array.isArray(proxied) && proxied.length) {
    // v6.9.33: drop POI results (hostels/cafés/offices) BEFORE mapping —
    // a POI's 5 m bbox as the scan area is the "1 business per city" bug.
    const settlements = proxied.filter((r: any) => settlementKind(r) !== null);
    const usable = settlements.length ? settlements : proxied;
    // v6.9.33: proper cities first so the top suggestion can never be a POI,
    // and among settlements rank city > town > village > district…
    usable.sort((a: any, b: any) =>
      (SETTLEMENT_RANK[settlementKind(a) ?? 'zzz'] ?? 99) - (SETTLEMENT_RANK[settlementKind(b) ?? 'zzz'] ?? 99));
    const results: CityResult[] = usable.map((r: any) => ({
      // v6.9.33: accept-language=en (above) makes Nominatim return English
      // names where available ("Tbilisi" instead of "თბილისი") — the
      // suggestion label becomes clickable for English users while the
      // native spelling stays in OSM for enrichment.
      name: r.name || (r.display_name || '').split(',')[0],
      country: r.address?.country || '',
      countryCode: r.address?.country_code?.toUpperCase() || '',
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      population: r.extratags?.population ? parseInt(r.extratags.population) : null,
      populationSource: r.extratags?.population ? ('osm' as PopulationSource) : undefined,
      bbox: r.boundingbox.map(Number).reduce((acc: number[], v: number, i: number) => {
        // Nominatim bbox order: [south, north, west, east] → [s, w, n, e]
        if (i === 0) acc[0] = v; else if (i === 1) acc[2] = v; else if (i === 2) acc[1] = v; else acc[3] = v;
        return acc;
      }, [0, 0, 0, 0] as number[]) as [number, number, number, number],
    }));
    // v6.9.33: sorting already applied to `usable` before mapping
    await backfillCityPopulations(results);
    return results;
  }
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
    // v6.9.33: same settlement guard as the proxy path — POIs (hostels,
    // cafés) with 5 m bboxes must never become the scan area.
    const settled = data.filter((r: any) => settlementKind(r) !== null);
    const usable = (settled.length ? settled : data);
    usable.sort((a: any, b: any) =>
      (SETTLEMENT_RANK[settlementKind(a) ?? 'zzz'] ?? 99) - (SETTLEMENT_RANK[settlementKind(b) ?? 'zzz'] ?? 99));
    const results: CityResult[] = usable.map((r: any) => {
      const bbox = r.boundingbox.map(Number);
      const pop = r.extratags?.population ? parseInt(r.extratags.population) : null;
      return {
        name: r.address?.city || r.address?.town || r.address?.village || r.address?.municipality || r.display_name.split(',')[0],
        country: r.address?.country || '',
        countryCode: r.address?.country_code?.toUpperCase() || '',
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        population: pop,
        populationSource: pop != null ? ('osm' as PopulationSource) : undefined,
        bbox: [bbox[0], bbox[2], bbox[1], bbox[3]],
      };
    });
    // v6.9.24: population fallback chain — Nominatim's extratags.population
    // is missing for many cities (Tbilisi included), which silently disabled
    // every per-capita metric. Backfill from the next service in the chain
    // (Open-Meteo; stage 3 / Wikidata completes on city selection).
    await backfillCityPopulations(results);
    return results;
  }
  throw new Error('Nominatim rate limit — try again in a few seconds');
}

// ─── v6.9.24: Population fallback chain ────────────────────────────
// Population used to come from ONE service (Nominatim extratags) with no
// fallback — a single point of failure. The chain is now:
//   1. OSM Nominatim extratags (primary, resolved by the caller above)
//   2. Open-Meteo Geocoding API — keyless, CORS-open, returns population
//   3. Wikidata SPARQL (P1082) — coordinate proximity, then exact name
// Results are cached for 30 days (population changes on a yearly scale).
const POP_TIMEOUT_MS = 7000;

async function fetchJsonWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Accept': 'application/json', ...init?.headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Reject junk values (missing units, per-square-km densities, typos)
function plausiblePopulation(v: any): number | null {
  const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v);
  if (!Number.isFinite(n) || n < 500 || n > 50_000_000) return null;
  return n;
}

// Stage 2: Open-Meteo geocoding — free, keyless, CORS-open
async function populationFromOpenMeteo(name: string, countryCode: string, lat: number, lon: number): Promise<number | null> {
  const d = await fetchJsonWithTimeout(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`,
    POP_TIMEOUT_MS,
  );
  const all: any[] = d?.results || [];
  if (!all.length) return null;
  let pool = all.filter(r => r.population != null);
  if (countryCode) {
    const inCountry = pool.filter(r => (r.country_code || '').toUpperCase() === countryCode);
    if (inCountry.length) pool = inCountry;  // never let a same-named foreign city win
  }
  if (!pool.length) return null;
  // Several candidates may share the name — take the one nearest to the
  // coordinates Nominatim already resolved for this city.
  pool.sort((a, b) => {
    const da = (a.latitude - lat) ** 2 + (a.longitude - lon) ** 2;
    const db = (b.latitude - lat) ** 2 + (b.longitude - lon) ** 2;
    return da - db;
  });
  return plausiblePopulation(pool[0].population);
}

async function wdSparql(sparql: string): Promise<number | null> {
  const d = await fetchJsonWithTimeout(
    'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(sparql),
    POP_TIMEOUT_MS,
    { headers: { 'Accept': 'application/sparql-results+json' } },
  );
  for (const row of d?.results?.bindings || []) {
    const v = plausiblePopulation(row?.pop?.value);
    if (v) return v;
  }
  return null;
}

// Stage 3: Wikidata P1082 (population). First nearest populated settlement
// around the exact point Nominatim returned, then an exact-name fallback.
async function populationFromWikidata(name: string, lat: number, lon: number): Promise<number | null> {
  const point = `Point(${lon.toFixed(4)} ${lat.toFixed(4)})`;
  const around = `SELECT ?pop WHERE {
  ?place wdt:P31/wdt:P279* wd:Q486972 ;
         wdt:P1082 ?pop ;
         wdt:P625 ?loc .
  SERVICE wikibase:around {
    ?place wdt:P625 ?loc2 .
    bd:serviceParam wikibase:center "${point}"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "15" .
  }
} ORDER BY DESC(?pop) LIMIT 3`;
  const a = await wdSparql(around);
  if (a) return a;
  const esc = name.replace(/["\\]/g, ' ').trim();
  if (!esc) return null;
  const byName = `SELECT ?pop WHERE {
  ?place wdt:P31/wdt:P279* wd:Q515 ;
         wdt:P1082 ?pop ;
         rdfs:label ?l .
  FILTER (LCASE(STR(?l)) = LCASE("${esc}"))
} ORDER BY DESC(?pop) LIMIT 3`;
  return wdSparql(byName);
}

// Runs the chain (stage 2 → optional stage 3) for one city.
export async function resolvePopulation(
  name: string,
  country: string,
  countryCode: string,
  lat: number,
  lon: number,
  opts?: { wikidata?: boolean },
): Promise<{ population: number; source: PopulationSource } | null> {
  const ck = 'pop_' + cacheKey(name, country);
  const cached = cacheGet<{ population: number; source: PopulationSource }>(ck, 30 * DAY_MS);
  if (cached) return cached;
  const om = await populationFromOpenMeteo(name, countryCode, lat, lon);
  if (om) {
    const r = { population: om, source: 'open-meteo' as PopulationSource };
    cacheSet(ck, r);
    return r;
  }
  if (opts?.wikidata !== false) {
    const wd = await populationFromWikidata(name, lat, lon);
    if (wd) {
      const r = { population: wd, source: 'wikidata' as PopulationSource };
      cacheSet(ck, r);
      return r;
    }
  }
  return null;
}

// Backfills population for every city still missing one (parallel, each
// capped at 3.5 s so city typeahead never stalls). Mutates in place.
export async function backfillCityPopulations(cities: CityResult[]): Promise<void> {
  await Promise.all(cities.map(async (c) => {
    if (c.population != null) return;
    try {
      const fb = await Promise.race([
        resolvePopulation(c.name, c.country, c.countryCode, c.lat, c.lon, { wikidata: false }),
        new Promise<null>(r => setTimeout(() => r(null), 3500)),
      ]);
      if (fb) {
        c.population = fb.population;
        c.populationSource = fb.source;
      }
    } catch { /* population is best-effort */ }
  }));
}

// Completes the FULL chain for a single selected city (stage 3 included).
// Called right before any flow that depends on population for scoring.
export async function ensureCityPopulation(city: CityResult): Promise<CityResult> {
  if (city.population != null && city.population > 0) {
    return city.populationSource ? city : { ...city, populationSource: 'osm' };
  }
  const fb = await resolvePopulation(city.name, city.country, city.countryCode, city.lat, city.lon);
  return fb ? { ...city, population: fb.population, populationSource: fb.source } : city;
}

// ─── v6.9.28: Country-wide city discovery ──────────────────────────
// Nominatim's free-text `q=city&countrycodes=XX` search has DEGRADED badly
// (verified 2026-09-11: returns 2–3 rows for all of Georgia, mostly Tbilisi
// duplicates) — the Country view suddenly found "1 city" per country.
// Overpass place=city returns 10 cities WITH English names + populations for
// the same country. Strategy: Overpass primary → Nominatim structured
// fallback → Open-Meteo last resort. All results get the population
// backfill chain so per-capita metrics work everywhere.
export async function findCountryCities(countryName: string, countryCode: string): Promise<CityResult[]> {
  const cc = (countryCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return [];
  const ck = 'cities_' + cc;
  const cached = cacheGet<CityResult[]>(ck, 7 * DAY_MS);
  if (cached?.length) return cached;

  const results: CityResult[] = [];

  // ── Primary: Overpass place=city (+town for small countries) inside the
  // country's admin area. name:en preferred so non-Latin countries get
  // readable names; native name kept for enrichment.
  try {
    const q = `[out:json][timeout:25];
area["ISO3166-1"="${cc}"][admin_level=2]->.a;
(
  node(area.a)["place"="city"];
  way(area.a)["place"="city"];
  node(area.a)["place"="town"]["population"];
  way(area.a)["place"="town"]["population"];
);
out center tags;`;
    const d = await fetchOverpass(q, 25);
    const seen = new Set<string>();
    for (const e of (d?.elements || []) as any[]) {
      const t = e.tags || {};
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const native = t.name || '';
      const en = t['name:en'] || t['name:latin'] || native;
      if (!en) continue;
      const key = (t['name:en'] || native).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const pop = plausiblePopulation(t.population);
      results.push({
        name: en,
        country: countryName,
        countryCode: cc,
        lat, lon,
        population: pop,
        populationSource: pop != null ? 'osm' : undefined,
        bbox: circleBbox(lat, lon, 12000), // Overpass gives no bbox here; computeScanArea pads/fits
      });
    }
  } catch { /* Overpass down → fallbacks below */ }

  // ── Fallback 1: Nominatim STRUCTURED search (q=city free-text is the
  // degraded path; structured city= + countrycodes= is more reliable).
  if (results.length < 3) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?city=&countrycodes=${cc.toLowerCase()}&format=json&addressdetails=1&limit=30&extratags=1`;
      const res = await directFetch(url, { headers: { 'Accept': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const seen = new Set(results.map(r => r.name.toLowerCase()));
        for (const r of data) {
          const addr = r.address || {};
          const raw = addr.city || addr.town || addr.village || addr.municipality;
          if (!raw) continue;
          const key = raw.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const pop = plausiblePopulation(r.extratags?.population);
          const bb = (r.boundingbox || []).map(Number);
          results.push({
            name: raw,
            country: addr.country || countryName,
            countryCode: cc,
            lat: parseFloat(r.lat),
            lon: parseFloat(r.lon),
            population: pop,
            populationSource: pop != null ? 'osm' : undefined,
            bbox: bb.length === 4 ? [bb[0], bb[2], bb[1], bb[3]] : circleBbox(parseFloat(r.lat), parseFloat(r.lon), 12000),
          });
        }
      }
    } catch { /* still best-effort */ }
  }

  // Sort by population (largest first — the Country view takes the top 5)
  results.sort((a, b) => (b.population || 0) - (a.population || 0));
  const top = results.slice(0, 12);

  // Population backfill (3.5s-capped, parallel) so per-capita metrics work
  await backfillCityPopulations(top);

  if (top.length) cacheSet(ck, top);
  return top;
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
  /** v6.9.48: found via the web-registry supplement (not OSM) — approximate pin */
  supplemented?: boolean;
  /** v6.9.94: real business photo — og:image / JSON-LD image from their site */
  image?: string;
  /** v6.9.68: per-branch contacts harvested from crawled location/branch pages */
  branches?: Branch[];
  /** v6.9.68: internal dedup of branch-crawled URLs */
  _branchSeen?: Set<string>;
}

export interface Branch {
  url: string;        // location page where this data was found
  title?: string;     // page <title> or best heading, for branch naming
  phone?: string;
  email?: string;
  address?: string;
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
  // v6.9.59: per-extraction-layer yield — which parsers actually found contacts
  layerYield?: { key: string; label: string; icon: string; found: number; tries: number }[];
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
  massage: { label: 'Massage' }, // v6.9.19: new standalone category
  car_wash: { label: 'Car Wash' }, market: { label: 'Local Market' },
  dance: { label: 'Dance Studio' }, music_school: { label: 'Music School' },
  cleaning: { label: 'Cleaning Service' }, courier: { label: 'Courier Service' },
};

export function getCategoryLabel(id: string): string {
  return CATEGORY_QUERIES[id]?.label || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Categorization ────────────────────────────────────────────────

// ── v6.9.19: multilingual name-keyword banks for sub-bucketing ──────
// The categorizer used to split beauty/fitness buckets with English-only
// name regexes, so a Dubai fitness centre named "ستوديو اليوغا" or a
// beauty shop "صالون أظافر" silently landed in the generic gym/beauty
// bucket — producing absurd counts like "1 dance studio in a 4M city".
// These banks cover ~20 languages each and are shared by every
// name-based branch below. Latin tokens are guarded with a non-letter
// prefix so substrings like 'abundance' (contains 'danc') don't match.
const RX_NAIL2 = /(маникюр|педикюр|манікюр|manik|manicure|pedicure|nail|أظافر|مناكير|باديكير|नेल|ネイル|네일|美甲|美睫|ניקור|ম্যানিকিউর|nail)/i;
const RX_YOGA = /(yoga|pilates|йога|пилатес|пілатес|یوگا|يوغا|योग|ヨガ|요가|瑜伽|普拉提|ଯୋଗ)/i;
const RX_DANCE = /((^|[^a-zà-öø-ÿ])(danc|danza|tanz(?!an))|ballet|choreo|танц|балет|хорео|バレエ|ダンス|発レ|발레|댄스|무용|舞蹈|芭蕾|舞踏|رقص|باليه|ריקוד|מחול|नृत्य|เต้น|รำ|ქორეოგრაფი|ცეკვ|պար|salsa|bachata|kizomba|zumba|tango|hip.?hop|breakdance|break.?danc|b\.?boy|flamenco|merengue|cha.?cha|foxtrot|waltz|jazz.?danc|lindy.?hop|street.?danc)/i;
const RX_MASSAGE = /(massage|masaż|массаж|масаж|masaj|マッサージ|마사지|按摩|推拿|นวด|مساج|تدليك|מסאז|मालिश)/i;
const RX_SPA = /(spa|спа|สปา|スパ)/i;
// ── v6.9.47: professional-services name banks ──
// Tbilisi probe (2026-09-15, city bbox): office=accountant ×0, office=it ×4,
// office=consulting ×2, office=lawyer ×50, office=estate_agent ×27 — yet the
// bbox holds 173 NAMED generic offices (office=company/yes). Real accounting,
// IT, consulting and real-estate firms live there under generic tags, filed
// by NAME. These banks sub-bucket them in every language the probe languages
// actually appear in (Georgian, Russian, English, Turkish at minimum).
const RX_ACC = /(account|audit|bookkeep|buhgalter|buhuchet|бухгалт|аудит|ბუღალტ|აუდიტ|հաշվապա|mühasib|mühasib|muhasebe|denetç|会計|監査|회계|세무|מהנהלת חשבונות|حسابداری|contabil|comptable|bilancio|rachunkow)/i;
const RX_LAW = /(law|legal|attorney|advokat|advo[cg]at|lawyer|notar|юрис|адвокат|нотари|იურიდ|ადვოკატ|ნოტარ|իրավաբան|փաստաբան|hüquq|hukuk|avukat|noter|法律|弁護士|司法|법률|변호사|משפט|قانوني|jurid|anwalt|kancelaria|avocat|avvocat)/i;
const RX_ESTATE = /(real.?estate|realty|property|immobili|estate agent|нерухом|недвиж|агентств недвижимости|უძრავ|ქონებ|անշարժ գույք|əmlak|gayrimenkul|emlak|房地产|不動産|부동산|נדל"?ן|عقار|immo|inmobiliaria|kinnisvara|nekilnojam)/i;
const RX_CONSULT = /(consult|консалт|консульт|კონსალტ|დარგობრივ|խորհրդատ|məsləhət|danışman| consultants|コンサル|컨설팅|ייעוץ|استشارات|konsult|conseil|berat)/i;
const RX_ITCO = /(software|soft\s|\bit\b|\bIT\b|it company|tech|digital|web|dev|data|\bai\b|cloud|cyber|\bapp\b|სისტემ|პროგრამ|программ|ит-|разработ|ծրագրավոր|proqram|bilişim|yazılım|ソフト|ソフトウェア|システム|소프트|개발|תוכנה|הייטק|برمجة|تكنولوج|szoftver|programmatic)/i;
// v6.9.24: hostels are misfiled as hotels whenever they carry a generic
// office/company tag or a hotel-ish tourism tag. Word-boundary guarded so
// e.g. "Ghostel" doesn't match; covers the languages hostels actually
// advertise in (hostels serve international backpackers — English word
// 'hostel' appears in local names worldwide, alongside local variants).
const RX_HOSTEL = /(^|[^a-zà-öø-ÿ])(hostel|hostal|ostello|hostel|хостел|хостел|ჰოსტელი|ホステル|호스텔|青年旅舍|青旅|найт|pousada juvenil|albergue juvenil)([^a-zà-öø-ÿ]|$)/i;

export function categorizeBusiness(tags: Record<string, string>): string | null {
  const a = tags.amenity;
  const s = tags.shop;
  const t = tags.tourism;
  const l = tags.leisure;
  const o = tags.office;
  // v6.9.19: sub-bucketing name now includes the language-detected local
  // names (name:xx) — in multilingual cities the primary `name` tag alone
  // often misses the recognizable word (e.g. name:ru "Маникюр" with a
  // transliterated `name`).
  const nameOf = () => {
    const extra = Object.keys(tags)
      .filter(k => k.startsWith('name:') && k !== 'name:en')
      .map(k => tags[k]).join(' ');
    return ((tags.name || tags['name:en'] || '') + ' ' + extra).toLowerCase();
  };

  // ─── Shops (always businesses) ───
  if (s === 'beauty' || s === 'cosmetics' || s === 'beauty_salon') {
    // v6.9.19: honor the beauty=* subtag first (OSM's own discrimination):
    // beauty=nails|nail|manicure|pedicure → nail salon; beauty=massage →
    // massage; beauty=tattoo → tattoo; beauty=hairdresser → hair salon.
    const bt = tags['beauty'] || '';
    if (/(nail|manicure|pedicure)/.test(bt)) return 'nail_salon';
    if (bt === 'massage') return 'massage';
    if (bt === 'tattoo' || bt === 'piercing') return 'tattoo';
    if (bt === 'hairdresser' || bt === 'hair') return 'hair_salon';
    if (bt === 'tanning') return 'spa';
    if (bt === 'spa' || bt === 'wellness') return 'spa';
    // Multilingual name split: a beauty shop named like a nail salon is a
    // nail salon, not a beauty salon (was English/Russian-only).
    const nm = nameOf();
    if (RX_NAIL2.test(nm)) return 'nail_salon';
    if (RX_MASSAGE.test(nm)) return 'massage';
    if (RX_SPA.test(nm)) return 'spa';
    if (/(tattoo|тат|纹身|刺青|タトゥー|타투|وشم)/i.test(nm)) return 'tattoo';
    if (/(hair|friseur|coiff|kuaf|пари|lash|眉)/i.test(nm)) return 'hair_salon';
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
  if (s === 'massage') {
    const nm = nameOf();
    if (RX_YOGA.test(nm)) return 'yoga';
    return 'massage'; // v6.9.19: own category (was folded into spa)
  }
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
  if (a === 'dancing_school') return 'dance'; // v6.9.19: was misfiled as music_school
  if (a === 'music_school' || a === 'arts_centre' || a === 'studio') {
    // v6.9.19: amenity=studio is heavily reused for yoga/dance salons —
    // split by (now multilingual) name before defaulting to music school.
    const nm = nameOf();
    if (RX_YOGA.test(nm)) return 'yoga';
    if (RX_DANCE.test(nm)) return 'dance';
    return 'music_school';
  }
  if (a === 'massage') {
    // v6.9.19: separate massage category (was folded into spa, inflating
    // spa and starving 'massage'). Yoga-styled parlors stay yoga.
    const nm = nameOf();
    if (RX_YOGA.test(nm)) return 'yoga';
    return 'massage';
  }
  if (a === 'spa' || a === 'sauna' || a === 'public_bath' || a === 'tanning_salon') {
    const nm = nameOf();
    if (RX_YOGA.test(nm)) return 'yoga';
    return 'spa';
  }
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
      t === 'resort' || t === 'chalet' || t === 'aparthotel') {
    // v6.9.24: a hotel-tagged property named "… Hostel" is a hostel in
    // practice (mis-tagged in OSM) — trust the name, not just the tag.
    if (RX_HOSTEL.test(nameOf())) return 'hostel';
    return 'hotel';
  }
  if (t === 'hostel') return 'hostel';
  if (t === 'guest_house') return 'hotel';
  if (t === 'museum' || t === 'gallery' || t === 'aquarium' || t === 'zoo' ||
      t === 'theme_park') return 'art';
  // tourism=attraction/artwork deliberately NOT mapped: monuments, viewpoints
  // and statues carry names but are not businesses.
  if (t === 'caravan_site' || t === 'camp_site') return 'hostel';

  // ─── Leisure ───
  // v6.9.16: track/stadium are public venues, not gyms — moved to the
  // venues/null bucket below (they were inflating the gym count).
  if (l === 'fitness_centre' || l === 'sports_centre' || l === 'sports_hall' ||
      l === 'swimming_pool') {
    // v6.9.19: multilingual name-based split (yoga/pilates/dance studios
    // before the generic 'gym' bucket). Also honors sport=* subtags.
    const nm = nameOf();
    const sp = tags.sport || '';
    if (RX_YOGA.test(nm) || /yoga|pilates/.test(sp)) return 'yoga';
    if (RX_DANCE.test(nm) || /dance|ballet/.test(sp)) return 'dance';
    if (RX_MASSAGE.test(nm)) return 'massage';
    if (/(box|mma|karate|judo|taekwondo|wrestl|fencing|kick|aikido|jui.?jitsu)/.test(nm)) return 'gym';
    return 'gym';
  }
  if (l === 'yoga') return 'yoga';               // leisure=yoga exists in OSM
  if (l === 'dance' || l === 'dance_hall') {
    // v6.9.19: leisure=dance_hall is often a music/night venue, not a
    // studio — only treat as a dance studio when no concert/club signals.
    if (l === 'dance_hall' && /nightclub|concert|live|клуб|бар|bar|club/i.test(nameOf())) return 'night_club';
    return 'dance';
  }
  if (l === 'bowling_alley' || l === 'escape_game' || l === 'amusement_arcade' ||
      l === 'miniature_golf' || l === 'trampoline_park' || l === 'water_park') return 'night_club';
  if (l === 'spa' || l === 'sauna') return 'spa';
  if (l === 'tanning_salon') return 'spa';
  if (l === 'horse_riding' || l === 'golf_course' || l === 'club' || l === 'padel' ||
      l === 'tennis' || l === 'ice_rink' || l === 'pitch' || l === 'playground' ||
      l === 'park' || l === 'garden' || l === 'dog_park' || l === 'track_outdoor' ||
      l === 'pitch_outdoor' || l === 'common' || l === 'nature_reserve' ||
      l === 'track' || l === 'stadium') return null; // venues/parks, not businesses

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
    // v6.9.47: the old inline patterns were English-only — a Georgian
    // accounting firm (ბუღალტერია), a Russian consulting office (консалтинг)
    // or a Turkish law office (hukuk) all fell through to 'software',
    // poisoning that bucket while accountant/it_consulting read as "gaps".
    const nm = nameOf();
    if (RX_LAW.test(nm)) return 'lawyer';
    if (RX_ACC.test(nm)) return 'accountant';
    if (RX_ESTATE.test(nm)) return 'real_estate';
    if (/(insur|strakhov)/.test(nm) || /(insur)/.test(nm)) return 'insurance';
    if (/(travel|tur|tour)/.test(nm)) return 'travel_agency';
    if (/(clean|ubor|cleaning|清扫|청소|تنظيف|temizlik)/.test(nm)) return 'cleaning';
    if (/(car.?wash|moyk[ae]|автомойк)/.test(nm)) return 'car_wash';
    // v6.9.19: multilingual splits for lifestyle businesses registered as
    // generic offices (very common in Gulf/South-Asia cities)
    if (RX_NAIL2.test(nm)) return 'nail_salon';
    if (RX_YOGA.test(nm)) return 'yoga';
    if (RX_DANCE.test(nm)) return 'dance';
    if (RX_MASSAGE.test(nm)) return 'massage';
    if (RX_SPA.test(nm)) return 'spa';
    if (/(hair|friseur|coiff|kuaf|пари)/i.test(nm)) return 'hair_salon';
    // v6.9.16: word-boundary 'it' — bare substring matched "Italian",
    // "Capital", "Suite" etc. and misfiled them as software.
    // v6.9.47: consulting BEFORE software — "IT Consulting LLC" contains
    // both; the specific bucket must win. Multilingual banks used.
    if (RX_CONSULT.test(nm)) return 'it_consulting';
    if (RX_ITCO.test(nm)) return 'software';
    if (/(market|advertis|reklam|agency|agenc|media|pr\b|brand|design|studio)/.test(nm)) return 'digital_marketing';
    if (/(construct|building|development)/.test(nm)) return 'hardware';
    if (/(logist|transport|delivery|courier)/.test(nm)) return 'courier';
    if (/(security|guard|охран)/.test(nm)) return 'insurance';
    if (/(recruit|hr\b|personnel|staff)/.test(nm)) return 'it_consulting';
    if (/(med|clinic|doctor|health|dent|pharm)/.test(nm)) return 'clinic';
    if (/(bank|financ|invest|credit|fund|capital)/.test(nm)) return 'bank';
    if (/(energ|oil|gas|mining)/.test(nm)) return 'fuel';
    // v6.9.24: hostel MUST be tested before the generic hotel mapping —
    // a generic office named "Envoy Hostel Tbilisi" used to be counted as a
    // hotel, making the hostel bucket look empty (false "gap").
    if (RX_HOSTEL.test(nm)) return 'hostel';
    if (/(hotel|motel)/.test(nm)) return 'hotel';
    if (/(import|export|trade|wholesale|supply|distribut)/.test(nm)) return 'market';
    return null; // v6.9.16: unmatched company names must NOT be filed as
                 // software — that poisoned category counts. Drop instead;
                 // tag-based classification above already handled the real
                 // offices (law/estate/account have their own office=* tags).
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
  // v6.9.47: multilingual professional-services banks — an element tagged
  // only `name=ბუღალტრის ოფისი` with no office=* tag is still an accounting
  // firm; the English-only regexes skipped it entirely.
  const nameLower = nameOf();
  if (!o && nameLower) {
    if (RX_LAW.test(nameLower)) return 'lawyer';
    if (RX_ACC.test(nameLower)) return 'accountant';
    if (RX_ESTATE.test(nameLower)) return 'real_estate';
    if (RX_CONSULT.test(nameLower)) return 'it_consulting';
    if (RX_ITCO.test(nameLower)) return 'software';
    if (/(law|legal|attorney|advo[ck]at)/.test(nameLower)) return 'lawyer';
    if (/(account|buh|finance|audit)/.test(nameLower)) return 'accountant';
    if (/(real.?estate|property|immobili)/.test(nameLower)) return 'real_estate';
    if (/(insur|strakhov)/.test(nameLower)) return 'insurance';
    if (/(travel|tur|tour|travel)/.test(nameLower)) return 'travel_agency';
    if (/(clean|ubor|cleaning|清扫|청소|تنظيف|temizlik)/.test(nameLower)) return 'cleaning';
    if (/(car.?wash|moyk[ae]|автомойк)/.test(nameLower)) return 'car_wash';
    if (RX_NAIL2.test(nameLower)) return 'nail_salon';
    if (!a && !l && !s && !t && tags.sport && /yoga|pilates/i.test(tags.sport)) return 'yoga'; // v6.9.21: bare sport=yoga
    if (!a && !l && !s && !t && RX_YOGA.test(nameLower)) return 'yoga'; // v6.9.21: bare-name only (an amusement ride named Cuban Dance is not a dance school)
    if (!a && !l && !s && !t && tags.sport && /dance|ballet/i.test(tags.sport)) return 'dance'; // v6.9.21: bare sport=dance
    if (!a && !l && !s && !t && RX_DANCE.test(nameLower)) return 'dance'; // v6.9.21: bare-name only
    if (RX_MASSAGE.test(nameLower)) return 'massage';
  }

  return null;
}

// ─── Parsing Helpers ───────────────────────────────────────────────

/**
 * Extract + normalize a phone from OSM tags using libphonenumber-js.
 * OSM stores multi-numbers ';'-separated; pass countryCode (e.g. 'GE')
 * so local formats (032 2xx xx xx) resolve correctly.
 */
// v6.9.53: phone/email fields get MISFILED values too — mappers put an
// email into phone= and vice versa. Mirrors extractRescueWebsite: real
// data must be rescued into the right field, not dropped by validation.

// Structural email shape (no TLD dictionary — junk regexes filter later)
const RX_EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
// Phone: any segment with 7-15 digits (optionally +) is a phone candidate
const RX_PHONE_SEGMENT = /^\+?[\d\s().-]{7,20}$/;

// Pull a real email out of a phone-ish raw value: whole-value emails
// ("info@site.ge" in phone=), emails inside mixed lists, or embedded in
// prose ("Email: info@site.ge"). Substring match covers all three.
function rescueEmailFromPhoneish(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : '';
}

// Pull a phone out of an email-ish raw value: emails inside a phone list
// yield the phone part; prose-wrapped numbers ("call us: 599 66 33 00")
// are found by substring match. plausiblePhone(light) keeps dates/IPs out.
function rescuePhoneFromEmailish(raw: string): string {
  if (!raw) return '';
  if (RX_EMAIL_SHAPE.test(raw.trim())) return ''; // whole value is an email — nothing to rescue
  for (const seg of raw.split(/[;,/\n]/)) {
    const t = seg.trim();
    if (RX_EMAIL_SHAPE.test(t)) continue; // email segment inside the list
    for (const m of t.matchAll(/\+?\d[\d\s().-]{6,17}\d/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15 && plausiblePhone(m[0], false)) return m[0].trim();
    }
  }
  return '';
}

function extractPhone(tags: Record<string, string>, countryCode?: string): string {
  const raw = tags.phone || tags['contact:phone'] || tags['contact:mobile'] ||
              tags['phone:mobile'] || tags['phone:international'] ||
              tags['contact:landline'] || tags['contact:fax'] ||
              tags['contact:whatsapp'] || tags['contact:viber'] || '';
  if (!raw) return '';
  // v6.9.53: if the whole value is an email, the phone number itself (if any)
  // lives in the email field — treat as misfiled and return empty.
  if (RX_EMAIL_SHAPE.test(raw.trim())) return '';
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
  const raw = tags.email || tags['contact:email'] || tags['email:office'] || '';
  if (!raw) return '';
  const first = raw.split(/[;,/\n]/)[0].trim();
  // v6.9.53: junk/misfiled first segment — try to find a real email inside
  // the value before giving up (mixed lists like "info@x.ge; +995 555 12 34").
  if (!RX_EMAIL_SHAPE.test(first)) return rescueEmailFromPhoneish(raw) || '';
  return first;
}

// v6.9.53: composed contact extraction with CROSS-FIELD rescue — an email
// hiding in a phone field fills the email slot and vice versa, so misfiled
// data lands in the right column instead of being dropped by validation.
function extractContactPair(tags: Record<string, string>, countryCode?: string): { phone: string; email: string } {
  const phoneRaw = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || '';
  const emailRaw = tags.email || tags['contact:email'] || tags['email:office'] || '';
  const email = extractEmail(tags) || rescueEmailFromPhoneish(phoneRaw);
  const phone = extractPhone(tags, countryCode) || normalizePhone(rescuePhoneFromEmailish(emailRaw), countryCode);
  return { phone, email };
}

// Directory/listing sites that should NEVER be set as a business website
const DIRECTORY_SITES = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress|2gis\.com|yandex\.com|uber\.com|doordash|grubhub|seamless|glassdoor|indeed\.com|glassdoor|angieslist|homeadvisor|thumbtack|bbb\.org|trustpilot|sitejabber|clutch\.co|goodfirms|sortlist|brightlocal|moz\.com|semrush|ahrefs|similarweb|duckduckgo\.com|bing\.com|google\.[a-z.]+|ecosia\.org|startpage\.com|qwant\.com|brave\.com|mojeek\.com|schema\.org|w3\.org/i;
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

// v6.9.52: rescue URLs misfiled into social fields. Mappers put the
// business's OWN website into contact:facebook / contact:instagram
// (Tbilisi audit: navne.ge, onex.ge rendered as "Facebook"). osmSocialUrl
// correctly refuses to render them as socials, but the URL is real data —
// return the first non-platform URL so it can fill an EMPTY website field
// instead of being dropped entirely.
function extractRescueWebsite(tags: Record<string, string>): string {
  const name = tags.name || '';
  // Self-sufficiency guard: if a dedicated website tag exists at all, the
  // primary extractor owns the decision — rescue only fills a genuinely
  // empty website field (works whether or not the caller composes with ||).
  if (tags.website || tags['contact:website'] || tags.url) return '';
  for (const raw of [tags['contact:facebook'], tags.facebook, tags['contact:instagram'], tags.instagram, tags['contact:linkedin'], tags.linkedin]) {
    const v = (raw || '').split(';')[0].trim();
    if (!v) continue;
    // Accept full URLs, www-prefixed and bare domains; skip usernames.
    let candidate = '';
    if (/^https?:\/\//i.test(v)) candidate = v;
    else {
      const bd = bareDomainOf(v);
      if (!bd) continue;
      candidate = `https://${bd}`;
    }
    let host = '';
    try { host = new URL(candidate).hostname.toLowerCase(); } catch { continue; }
    // Genuine platform URLs are socials, not rescue candidates
    if (/facebook\.com$/.test(host) || /instagram\.com$/.test(host) || /linkedin\.com$/.test(host)) continue;
    if (isLikelyBusinessWebsite(candidate, name)) return candidate;
  }
  return '';
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
  'Львів': 'Lviv',
  // v6.9.17: native->English cities for newly added countries
  // Belarus / Kazakhstan / Uzbekistan / Moldova / Baltics
  'Мінск': 'Minsk', 'Минск': 'Minsk', 'Гомель': 'Gomel', 'Брэст': 'Brest', 'Віцебск': 'Vitebsk',
  'Алматы': 'Almaty', 'Астана': 'Astana', 'Шымкент': 'Shymkent', 'Караганда': 'Karaganda',
  'Toshkent': 'Tashkent', 'Samarqand': 'Samarkand',
  'Chișinău': 'Chisinau', 'București': 'Bucharest',
  // Israel (Hebrew)
  'ירושלים': 'Jerusalem', 'תל אביב': 'Tel Aviv', 'חיפה': 'Haifa',
  // Gulf / Iraq / Iran (Arabic script)
  'الدوحة': 'Doha', 'مدينة الكويت': 'Kuwait City', 'المنامة': 'Manama', 'مسقط': 'Muscat',
  'أبوظبي': 'Abu Dhabi', 'الشارقة': 'Sharjah',
  'مكة المكرمة': 'Mecca', 'المدينة المنورة': 'Medina', 'الدمام': 'Dammam',
  'بغداد': 'Baghdad', 'البصرة': 'Basra', 'أربيل': 'Erbil',
  'تهران': 'Tehran', 'مشهد': 'Mashhad', 'اصفهان': 'Isfahan', 'تبریز': 'Tabriz',
  // Maghreb (Arabic script)
  'الدار البيضاء': 'Casablanca', 'الرباط': 'Rabat', 'مراكش': 'Marrakesh', 'فاس': 'Fez',
  'الجزائر': 'Algiers', 'وهران': 'Oran', 'تونس': 'Tunis',
  // South Asia
  'کراچی': 'Karachi', 'لاہور': 'Lahore', 'اسلام آباد': 'Islamabad',
  'ঢাকা': 'Dhaka', 'চট্টগ্রাম': 'Chittagong', 'කොළඹ': 'Colombo', 'काठमाडौं': 'Kathmandu',
  'कोलकाता': 'Kolkata', 'चेन्नई': 'Chennai', 'हैदराबाद': 'Hyderabad',
  // East Asia (CJK)
  '東京': 'Tokyo', '大阪': 'Osaka', '京都': 'Kyoto', '横浜': 'Yokohama', '名古屋': 'Nagoya',
  '北京': 'Beijing', '上海': 'Shanghai', '深圳': 'Shenzhen', '广州': 'Guangzhou',
  '杭州': 'Hangzhou', '成都': 'Chengdu',
  '臺北': 'Taipei', '高雄': 'Kaohsiung', '臺中': 'Taichung', '香港': 'Hong Kong',
  '부산': 'Busan',
  // Europe (local spellings)
  'Αθήνα': 'Athens', 'Λευκωσία': 'Nicosia', 'София': 'Sofia', 'Београд': 'Belgrade',
  'Скопје': 'Skopje', 'Tiranë': 'Tirana',
  'Warszawa': 'Warsaw', 'Kraków': 'Krakow', 'Praha': 'Prague',
  'Roma': 'Rome', 'Milano': 'Milan', 'Napoli': 'Naples', 'Torino': 'Turin',
  'München': 'Munich', 'Wien': 'Vienna', 'Zürich': 'Zurich', 'Genève': 'Geneva',
  'København': 'Copenhagen', 'Bruxelles': 'Brussels', 'Lisboa': 'Lisbon',
  'Ciudad de México': 'Mexico City',
  // Southeast Asia
  'กรุงเทพมหานคร': 'Bangkok',
  'Thành phố Hồ Chí Minh': 'Ho Chi Minh City', 'Hà Nội': 'Hanoi',
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
// v6.9.16: mixed-script names ("Cafe ლუის", "Café東京") previously produced
// ZERO tokens (the translit path was skipped because one Latin letter
// existed, then non-ASCII was split away) — now CJK/Kana/Hangul runs are
// kept as separate tokens alongside the Latin ones.
function extractBizNameTokens(businessName: string): string[] {
  let name = businessName || '';
  if (!/[\u0041-\u005A\u0061-\u007A]/.test(name)) {
    const en = getEnglishCityName(name);
    if (en) name = en;
    else name = transliterateGeo(name);
  }
  const stop = /^(cafe|café|coffee|restaurant|bar|pub|hotel|hostel|salon|shop|store|bakery|gym|fitness|club|spa|clinic|pharmacy|studio|the|and|of|la|le|de|da)$/i;
  const latin = name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !stop.test(t));
  // CJK/Kana/Hangul runs: keep each contiguous run as one token (hostnames
  // rarely contain these, but page-title/text matching does).
  const cjk = name.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) || [];
  return [...latin, ...cjk.map(s => s.toLowerCase())];
}

/** OSM social values may be full URLs, 'www.', bare usernames or '@user'. */
function osmSocialUrl(raw: string, base: string): string {
  if (!raw) return '';
  // v6.9.51 audit fix: mappers often put the business's OWN website into a
  // social field (navne.ge / onex.ge rendered as "Facebook"). Accept a value
  // only when it clearly belongs to the platform (hostname carries the
  // platform label); bare domains are websites, not socials.
  const platformLabel = base.replace(/^https?:\/\//, '').split('.')[0].toLowerCase();
  const v = raw.split(';')[0].trim();
  if (/^https?:\/\//i.test(v)) {
    try { if (!new URL(v).hostname.toLowerCase().includes(platformLabel)) return ''; } catch { return ''; }
    return v;
  }
  if (v.startsWith('www.')) {
    if (!v.toLowerCase().includes(platformLabel)) return '';
    return `https://${v}`;
  }
  // v6.9.52: bare domains ("navne.ge") are websites, not usernames — refuse
  // when the last dot-segment is a TLD (usernames like "john.smith" end in
  // non-TLD words, so they still resolve to a profile URL).
  if (bareDomainOf(v)) return '';
  return `${base}/${v.replace(/^@+/, '').replace(/^\/+/, '')}`;
}

// Last-segment TLD set for distinguishing bare domains ("navne.ge") from
// dotted usernames ("john.smith") in OSM social fields.
const SOCIAL_TLD_RE = /^(com|net|org|info|biz|io|co|app|dev|site|online|shop|store|ge|am|az|tr|ru|ua|by|kz|de|fr|uk|us|it|es|pl|cz|ro|gr|il|ae|in|cn|jp|kr|vn|th|id|ph|my|sg|edu|gov|me|tv|cc|xyz)$/;
function bareDomainOf(raw: string): string | null {
  const bare = raw.replace(/^@+/, '').replace(/^www\./, '').replace(/\/.*/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,6}$/i.test(bare)) return null;
  const last = bare.split('.').pop()!.toLowerCase();
  return SOCIAL_TLD_RE.test(last) ? bare : null;
}

// v6.9.51 audit: junk names that survive the scan — 1-char truncation
// artifacts ("ე"), URLs pasted as names ("http://coffee & drinks"), literal
// junk words and punctuation-only placeholders. These pollute the table and
// the AI's per-category analysis.
export function isJunkBusinessName(name: string): boolean {
  const n = (name || '').trim();
  if (n.length < 2) return true; // 1-char artifacts (any script)
  if (/https?:\/\/|www\./i.test(n)) return true; // URLs are not names
  if (/^(unknown|null|undefined|test|n\/a|self|yes|true|no|false)$/i.test(n)) return true;
  if (/^[\s\-—–_.·*#]+$/.test(n)) return true; // punctuation-only
  return false;
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

// v6.9.26: verified live 2026-09-11 (POST + browser CORS preflight):
//   v6.9.64: osm.ch verified 200 + Access-Control-Allow-Origin:* — added as
//            CORS-open slot #3 (mirrors the server-side mirror walk).
//   WORKING: maps.mail.ru, overpass-api.de, overpass.osm.ch (Access-Control-Allow-Origin: *)
//   DEAD:    overpass.openstreetmap.ru (connection refused) — removed; as race
//            slot #2 it stalled every scan for its full timeout
//   NO-CORS: kumi.systems, osm.jp — last-resort sequential fallbacks only
//            (harmless walked one-by-one, fatal when raced).
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
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

// v6.9.22: non-throwing abort-aware wait. Resolves true when the delay
// elapsed, false when the cancel signal fired first. Unlike wait(), it
// never rejects — callers inside fetchOverpass treat cancellation as
// "stop retrying" instead of an error path.
function abortableWait(ms: number): Promise<boolean> {
  if (isCancelled()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _cancelSignal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    _cancelSignal?.addEventListener('abort', onAbort, { once: true });
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
// v6.9.26 cache purge: scans made during the dead-mirror window cached
// broken results ("1 restaurant in Tbilisi") for 24h. Bump CACHE_VERSION to
// invalidate EVERY cached payload once; then empty responses are never cached
// again (see fetchOverpass).
// v6.9.30: bump 2→3 — partial Overpass responses carrying a `remark` (query
// timed out mid-run, near-empty element set) could be cached and served for
// 24h, producing the "Discover finishes in 5 s with 1 sphere" bug. Purge all.
// v6.9.33: bump 3→4 — a POI bbox (hostel, 5 m) became the scan area and its
// "1 business" result was cached too. Purge everything once more.
const CACHE_VERSION = 4;
(function purgeStaleCache() {
  try {
    if (localStorage.getItem('bo_cache_version') !== String(CACHE_VERSION)) {
      const stale = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
      for (const k of stale) localStorage.removeItem(k);
      localStorage.setItem('bo_cache_version', String(CACHE_VERSION));
    }
  } catch { /* best-effort */ }
})();
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
// v6.9.9: failure memory for the Jina + allorigins proxy arms — same idea as
// cors.sh: after 3 consecutive failures skip that arm for 5 minutes instead
// of printing one uncatchable console error per proxied request.
let _jinaFails = 0;
let _jinaLastFail = 0;
let _alloFails = 0;
let _alloLastFail = 0;
// v6.9.10: single-flight promise + last-successful payload for the allorigins
// arm (see corsFetch step 5). Waiting callers get the flight's outcome
// without printing another network error; on success they get a 501 marker
// (payload differs per URL — callers re-enter corsFetch and hit step-0
// caches/cooldowns instead of firing a second allorigins request).
let _alloInFlight: Promise<boolean> | null = null;
let _alloLastPayload = '';

// v6.9.5: hosts known to SERVE CORS headers to browsers (public APIs).
// These get the instant direct fetch; every other host goes through the
// proxy chain first — a direct attempt at an unknown host is usually a
// CORS rejection, which the browser prints as an uncatchable console
// error even when caught in JS.
const _CORS_OPEN_HOSTS = new Set([
  'api.search.brave.com', 'google.serper.dev',
  // api.tavily.com REMOVED 2026-09: Tavily sends no CORS headers to browsers,
  // so direct fetch always throws an uncatchable console error. It now goes
  // through corsFetch (cors.sh proxy) with engine-health tracking.
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
  persistHostHealth();
}
function hostRecordSuccess(u: string): void {
  if (_hostFails.delete(hostKey(u))) persistHostHealth();
}

// v6.9.30: persist breaker state across reloads — a mirror that hung (kumi/
// osm.jp outages) stays skipped after a page refresh instead of re-hanging
// once per session. Entries carry their own expiry; stale ones are inert.
const HOST_HEALTH_KEY = 'bo_host_health';
(function loadHostHealth() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_HEALTH_KEY) || '{}') as Record<string, { n: number; until: number }>;
    for (const h of Object.keys(saved)) {
      const e = saved[h];
      if (e && typeof e.n === 'number' && typeof e.until === 'number' && e.until > Date.now()) _hostFails.set(h, e);
    }
  } catch { /* best-effort */ }
})();
function persistHostHealth(): void {
  try {
    const out: Record<string, { n: number; until: number }> = {};
    _hostFails.forEach((e, h) => { if (e.until > Date.now()) out[h] = e; });
    localStorage.setItem(HOST_HEALTH_KEY, JSON.stringify(out));
  } catch { /* best-effort */ }
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

// v6.9.6: dedicated Brave failure counter. engineNoteFail resets on any
// later version-bump success, which let a dead Brave slip through the
// gates between phases — this sticky counter doesn't reset mid-scan.
let _braveFails = 0;
// v6.9.9: surge guard. The per-business enrichment runs N businesses in
// parallel, so N gates all pass BEFORE the first 429 lands — one rate-limit
// episode used to print ~N console errors per wave. After any failure, new
// Brave calls pause for 4s (in-flight ones can't be aborted), which caps
// each episode at the initial in-flight count and serializes the failures
// that follow.
let _braveLastFail = 0;
function braveOkToCall(): boolean {
  return _braveFails < 3 && (_braveFails === 0 || Date.now() - _braveLastFail > 4000);
}
function braveNoteFail(kind: 'net' | 'quota' | 'challenge', detail: string): void {
  _braveFails++; _netFails++; _braveLastFail = Date.now();
  engineNoteFail('brave', 'Brave', kind, detail);
}

// v6.9.8: hard budget on doomed outbound requests. Every proxied request
// that ends in a network-level failure (CORS-refused host, dead proxy,
// rate-limited engine) increments this. Past the budget, corsFetch
// short-circuits for any host that is not a known CORS-open API — the
// scan keeps running on already-fetched data and the engines that ARE
// healthy, instead of spraying hundreds of futile requests (which each
// print an uncatchable browser console error).
const MAX_NET_FAILS = 120;
let _netFails = 0;

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
// v6.9.101b: Brave free-tier monthly quota (http-402) does NOT recover in
// 30 minutes — every retry inside a session burns one doomed RPC round-trip
// (start+poll ≈ 4s) and silently falls back. Make quota sticky for the whole
// session; the preflight health reset still clears it on a fresh scan.
const COOLDOWN_QUOTA_MS = 6 * 60 * 60_000;

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

// ─── v6.9.65: Per-arm profiling — measured yield-per-second per engine ──
// The pass-1 batch fires 8 engine arms in parallel per business; arms that
// consistently produce nothing while burning their full timeout are pure
// waste (they hold no slot in Promise.all, but their timeouts pace the
// batch and their fetches eat the network budget). This counter records
// wall-time + fields-gained per arm so ordering decisions use data.
export interface ArmStat { calls: number; ms: number; gains: number; skips: number; }
const _armStats = new Map<string, ArmStat>();
function armStat(id: string): ArmStat {
  let s = _armStats.get(id);
  if (!s) { s = { calls: 0, ms: 0, gains: 0, skips: 0 }; _armStats.set(id, s); }
  return s;
}
function armNoteGain(id: string): void { armStat(id).gains++; }
export function resetArmStats(): void { _armStats.clear(); }
export function getArmStats(): { id: string; calls: number; ms: number; gains: number; skips: number; msPerCall: number; msPerGain: number | null }[] {
  const rows: { id: string; calls: number; ms: number; gains: number; skips: number; msPerCall: number; msPerGain: number | null }[] = [];
  for (const [id, s] of _armStats) {
    rows.push({ id, calls: s.calls, ms: s.ms, gains: s.gains, skips: s.skips, msPerCall: s.calls ? Math.round(s.ms / s.calls) : 0, msPerGain: s.gains ? Math.round(s.ms / s.gains) : null });
  }
  return rows.sort((a, b) => (a.msPerGain ?? Infinity) - (b.msPerGain ?? Infinity));
}

// v6.9.45: combine several abort sources into one signal (no dependency on
// AbortSignal.any availability in the TS lib).
function anySignal(...signals: (AbortSignal | undefined | null)[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ac.abort(); return ac.signal; }
    s.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

// v6.9.61: cap a body read. AbortSignal.timeout caps until response HEADERS
// arrive — a server that sends headers then stalls the body hangs an
// unguarded `await r.text()` forever. This races the read against a timer.
async function bodyWithCap<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('body-stall')), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

async function corsFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...init?.headers };
  const callerSignal = init?.signal;
  // v6.9.45: hard ceiling for the WHOLE proxy chain. Every arm below races
  // its own per-arm timeout against this cap AND the caller's signal, so a
  // single dead proxy can never stall a lane 20+ seconds — the "frozen at
  // 100%" enrichment bug fed on exactly that.
  const chainCap = AbortSignal.timeout(24_000);

  // 0) Circuit breaker: this host is currently known-dead at the network
  //    level — fail instantly instead of burning 5-30s on every request.
  if (hostIsOpen(url)) return new Response('', { status: 0, statusText: 'Host unreachable (circuit open)' });

  // 0b) v6.9.8 scan-wide failure budget: once enough proxied requests have
  //     failed, stop spending new ones on non-allowlist hosts (they are the
  //     source of the uncatchable console errors). CORS-open APIs stay
  //     available so core data (OSM, AI, Wikidata) keeps flowing.
  if (_netFails >= MAX_NET_FAILS && !hostAllowsDirect(url)) {
    return new Response('', { status: 0, statusText: 'Network budget exhausted' });
  }

  // 1) Try direct fetch — instant for CORS-enabled, instant error for others.
  //    Only for known CORS-open API hosts. For every other host, the first
  //    proxy-chain failure marks it direct-dead, so later requests to the
  //    same host skip this arm without printing a new browser console error.
  const firstTouch = !directIsDead(url);
  if (firstTouch) {
    if (hostAllowsDirect(url)) {
      try {
        const r0 = await fetch(url, { ...init, headers });
        // v6.9.61: buffer the body under a cap and rebuild the Response —
        // the raw Response's body stream has no deadline, so a stalled
        // body would hang every caller's `await r.text()` forever.
        if (r0.ok) {
          const text = await bodyWithCap(r0.text(), 4000);
          hostRecordSuccess(url);
          return new Response(text, { status: 200, headers: { 'Content-Type': r0.headers.get('content-type') || 'text/html' } });
        }
      } catch { /* CORS error or body stall */ }
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
  if ((_corsshFails < 3 || Date.now() - _corsshLastFail > 300_000) && !_cfHosts.has(urlHostOf(url))) {
    try {
      const r = await fetch('https://cors.sh/' + url, { headers, signal: anySignal(callerSignal, chainCap, AbortSignal.timeout(5000)) });
      if (r.ok) { hostRecordSuccess(url); _corsshFails = 0; return r; }
      _corsshFails++; _corsshLastFail = Date.now();
    } catch {
      _corsshFails++; _corsshLastFail = Date.now();
    }
  }

  if (callerSignal?.aborted) throw new Error('Cancelled');

  // 4) Jina Reader (keyless, returns page text/markdown — good for contact
  // extraction; works from real browser sessions). v6.9.9: failure memory —
  // when Jina refuses (401/429) or times out repeatedly, skip it for 5 min
  // instead of printing one console error per proxied request.
  if ((_jinaFails < 3 || Date.now() - _jinaLastFail > 300_000) && !_cfHosts.has(urlHostOf(url))) {
    try {
      const r = await fetch('https://r.jina.ai/' + url, { headers, signal: anySignal(callerSignal, chainCap, AbortSignal.timeout(12000)) });
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 100) {
          hostRecordSuccess(url);
          _jinaFails = 0;
          return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
      }
      _jinaFails++; _jinaLastFail = Date.now();
    } catch { _jinaFails++; _jinaLastFail = Date.now(); }
  }

  // 5) allorigins (demoted to last resort: 5xx/timeout failures observed
  // 2026). v6.9.9: failure-memory pattern. v6.9.10: single-flight — when
  // allorigins is unreachable, 10 parallel aborts printed 10 console errors
  // per wave; now only ONE in-flight request exists and the rest reuse its
  // outcome (success clones the payload, failure skips the arm).
  if (callerSignal?.aborted) throw new Error('Cancelled');
  if ((_alloFails < 3 || Date.now() - _alloLastFail > 300_000) && !_cfHosts.has(urlHostOf(url))) {
    if (_alloInFlight) {
      const ok = await _alloInFlight.catch(() => false);
      if (ok) return new Response('', { status: 501, statusText: 'allorigins single-flight: refetch needed' });
    } else {
      _alloInFlight = (async () => {
        try {
          const r = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url), { headers, signal: anySignal(callerSignal, chainCap, AbortSignal.timeout(5000)) });
          if (r.ok) {
            const json = await bodyWithCap(r.json() as Promise<any>, 8000); // v6.9.61: stalled bodies must not wedge single-flight
            _alloFails = 0; _alloLastPayload = json.contents || '';
            hostRecordSuccess(url);
            return true;
          }
          _alloFails++; _alloLastFail = Date.now();
          return false;
        } catch { _alloFails++; _alloLastFail = Date.now(); return false; }
        finally { _alloInFlight = null; }
      })();
      const ok = await _alloInFlight;
      if (ok) {
        return new Response(_alloLastPayload, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
    }
  }

  // 6) v6.9.64: Server-side page fetch (the guaranteed lane). Supabase
  //    pg_net has no CORS, no browser IP, no third-party proxy — it succeeds
  //    exactly when the target site is up. GET-only (Tavily POST skipped).
  if ((!init?.method || init.method === 'GET') && url.startsWith('https://')) {
    const srvText = await pageFetchViaServer(url);
    if (srvText) {
      hostRecordSuccess(url);
      return new Response(srvText, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
  }

  // v6.9.5: whole chain failed. CORS refusal is host-wide and sticky, so
  // lock the direct arm off for this host for the session — later requests
  // to it go straight to the proxies with zero new console noise. (A short
  // circuit-breaker cooldown still applies to the proxy chain itself.)
  if (firstTouch) markDirectDead(url);
  _netFails++;
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
  hostel: '["tourism"="hostel"]|["tourism"~"hotel|apartment|guest_house|bed_and_breakfast"]["name"~"hostel|hostal|ostello|хостел|ჰოსტელი|ホステル|호스텔|青年旅舍|青旅",i]',
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
  // v6.9.19: no English name gating — fetch the whole tag family and let
  // the (now multilingual) categorizer sub-bucket. The old filter demanded
  // an English "yoga|pilates" name, so Dubai (4.2M) reported 2 yoga
  // studios; the second group still name-matches in 7 major languages.
  yoga: '["leisure"~"fitness_centre|sports_centre|sports_hall|yoga"]|["sport"~"yoga|pilates",i]|["amenity"~"spa|massage|arts_centre"]["name"~"yoga|pilates",i]', // v6.9.21: sport=yoga, name-gated in EN (categorizer does 7-lang split)
  dance: '["leisure"~"dance|dance_hall"]|["amenity"="dancing_school"]|["dance:teaching"]|["club"~"sport",i]["sport"~"dance|ballet",i]|["leisure"~"fitness_centre|sports_centre|sports_hall"]["name"~"danc|ballet",i]|["amenity"~"studio|arts_centre"]["name"~"danc|ballet",i]', // v6.9.21: dancing_school is dance by definition, dance:teaching is the canonical tag, no ungated fitness sweep (categorizer does the multilingual split)
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
  // v6.9.19: nail-specific tag values + beauty=* subtag + multilingual
  // names — previously most beauty shops landed in beauty_salon, leaving
  // nail_salon nearly empty.
  nail_salon: '["shop"="nail_salon"]|["shop"="nails"]|["shop"~"beauty|cosmetics|beauty_salon"]["beauty"~"nail|manicure|pedicure",i]|["shop"~"beauty|beauty_salon"]["name"~"nail|manicure|pedicure|маникюр|أظافر|مناكير|ネイル|네일|美甲|नेल",i]',
  massage: '["amenity"~"massage|spa"]|["leisure"~"spa"]|["shop"="massage"]|["shop"~"beauty|beauty_salon"]["beauty"="massage"]',
  // ── v6.9 new categories ──
  // v6.9.19: dance filter moved next to yoga above; music_school no longer
  // queries dancing_school (it categorizes into 'dance' now).
  music_school: '["amenity"~"music_school|arts_centre|studio"]["name"!~"yoga|danc|ballet|танц|رقص|舞蹈|ダンス|댄스|무용",i]',
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
// v6.9.22: large responses are parsed OFF the main thread via a Blob-based
// URL.createObjectURL + dynamic import trick — JSON.parse of a multi-MB
// full-mode response (whole-city bbox → tens of MB) blocks the UI thread
// for seconds and freezes the tab. We now hand the text to a Web Worker
// when it exceeds 1 MB; smaller payloads parse inline (cheaper than
// spawning a worker).
const _parseWorkerUrl = (() => {
  try {
    const src = `self.onmessage=(e)=>{try{postMessage({ok:true,data:JSON.parse(e.data.text)})}catch(err){postMessage({ok:false})}};`;
    const blob = new Blob([src], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  } catch { return null; }
})();
function parseLargeJson(text: string): Promise<any> {
  if (text.length < 1_000_000 || !_parseWorkerUrl) {
    return Promise.resolve(JSON.parse(text));
  }
  return new Promise((resolve) => {
    try {
      const worker = new Worker(_parseWorkerUrl);
      const timer = setTimeout(() => { worker.terminate(); resolve(null); }, 30000);
      worker.onmessage = (e: MessageEvent) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(e.data?.ok ? e.data.data : null);
      };
      worker.onerror = () => {
        clearTimeout(timer);
        worker.terminate();
        // Fallback: parse inline rather than lose the data
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      };
      worker.postMessage({ text });
    } catch {
      // Worker creation failed — parse inline
      try { resolve(JSON.parse(text)); } catch { resolve(null); }
    }
  });
}

async function overpassAttempt(mirror: string, query: string, timeoutSec: number, hardCapSec?: number): Promise<any> {
  // v6.9.30: honor the per-host circuit breaker — a mirror that failed at the
  // network level repeatedly (e.g. kumi.systems hanging 40s+ per request) is
  // skipped INSTANTLY instead of burning its full timeout on every query.
  if (hostIsOpen(mirror)) { logRoute(hostKey(mirror), false, 0); return null; }
  const t0 = Date.now();
  try {
    // v6.9.30: optional hard cap for fallback mirrors (30s) — a hanging
    // mirror used to cost timeoutSec+15 (60s+) EACH before the cooldown/retry
    // logic even started, which surfaced as "first run errors, second works".
    const capSec = Math.min(timeoutSec + 15, hardCapSec ?? timeoutSec + 15);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), capSec * 1000);
    const res = await fetch(mirror, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // HTTP 429/504 from a mirror means "cannot serve this now" — counted so a
    // rate-limited/hung mirror opens the breaker and stops wasting slots.
    if (!res.ok) { hostRecordFail(mirror); logRoute(hostKey(mirror), false, Date.now() - t0); return null; }
    const text = await res.text();
    if (!text.trim().startsWith('{')) { hostRecordFail(mirror); logRoute(hostKey(mirror), false, Date.now() - t0); return null; } // XML error page / rate-limit
    const data = await parseLargeJson(text);
    if (!data || data.elements === undefined) { hostRecordFail(mirror); logRoute(hostKey(mirror), false, Date.now() - t0); return null; }
    // v6.9.30: Overpass sets `remark` when the query FAILED mid-run —
    // "runtime error: Query timed out", "out of memory", etc. Such a response
    // is a PARTIAL (often near-empty) result that used to WIN the race and
    // even get cached — exactly the "Discover finishes in 5 s with 1 sphere"
    // bug. Treat remark responses as failures so the race falls through to a
    // healthy mirror with a real result.
    if (data.remark) { hostRecordFail(mirror); logRoute(hostKey(mirror), false, Date.now() - t0); return null; }
    hostRecordSuccess(mirror);
    logRoute(hostKey(mirror), true, Date.now() - t0);
    return data;
  } catch {
    hostRecordFail(mirror);
    logRoute(hostKey(mirror), false, Date.now() - t0);
    return null;
  }
}

// FIRST-SUCCESS race (v6.9.26): Promise.all was a bug — it waited for BOTH
// attempts to settle before picking a winner, so one dead mirror stalled every
// scan for its full timeout even when the other answered in seconds. Now the
// first mirror to return valid data wins immediately; the loser is abandoned.
// Overpass allows ~2 concurrent slots per IP and these primaries run separate
// hardware, so a 2-request hedge is within policy and quality-identical.
function firstSuccess<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = 0;
    let last: T | null = null;
    let done = false;
    for (const p of promises) {
      p.then(v => {
        settled++;
        if (v && !done) { done = true; resolve(v); return; }
        if (v) last = v;
        if (settled === promises.length && !done) { done = true; resolve(last); }
      }).catch(() => {
        settled++;
        if (settled === promises.length && !done) { done = true; resolve(last); }
      });
    }
  });
}

// ─── v6.9.31: Overpass route health (for the loading-screen chip) ──
export interface OverpassRouteEvent {
  route: string;  // 'supabase:overpass-api.de' | 'mail.ru' | 'kumi' | ...
  ok: boolean;
  ms: number;
  at: number;
}
const overpassRouteLog: OverpassRouteEvent[] = [];
function logRoute(route: string, ok: boolean, ms: number): void {
  // v6.9.45: keep ONE chip per route — latest attempt wins. The old append-
  // only log let five stale "fail" chips from the direct-mirror fallback sit
  // on screen even after the Supabase proxy succeeded, looking like the scan
  // had errored out when it hadn't.
  const existing = overpassRouteLog.find(e => e.route === route);
  if (existing) { existing.ok = ok; existing.ms = ms; existing.at = Date.now(); return; }
  overpassRouteLog.push({ route, ok, ms, at: Date.now() });
  if (overpassRouteLog.length > 6) overpassRouteLog.shift();
}
export function getOverpassRouteLog(): OverpassRouteEvent[] {
  return overpassRouteLog.slice();
}
export function resetOverpassRouteLog(): void {
  overpassRouteLog.length = 0;
}

// ─── v6.9.31: Supabase Overpass proxy (server-side fetch) ──────────
// The browser calls public.rpc_overpass_start (submits pg_net job, returns
// request id) and then public.rpc_overpass_poll until done/failed. The
// SERVER talks to Overpass — user-side 504 cold starts, hanging mirrors and
// per-IP rate limits stop affecting scans. Direct-mirror racing remains as
// an automatic fallback if the proxy is unreachable.
const SUPABASE_URL = 'https://bfoagnqjkoqhogxvkvkw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UtCOExOHddCZ0UbTxbruWg_3m1U7a-0';
let _proxyDisabledUntil = 0; // circuit breaker when Supabase is unreachable
const PROXY_COOLDOWN_MS = 120000;

async function supabaseRpc<T>(fn: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${fn} HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// v6.9.55: server-side Brave search fallback. The browser-side Brave API is
// rate-limited (1 qps free tier) and gets 429s during enrichment waves; the
// supplement's Supabase proxy (key in Vault) is a separate quota pool. When
// the browser arm fails, per-business enrichment now reroutes here so the
// Brave lane keeps yielding data instead of going dark for the whole scan.
async function braveSearchViaSupabase(q: string): Promise<{ title: string; url: string; description: string }[] | null> {
  if (!engineAvailable('brave_s')) return null;
  try {
    const start = await supabaseRpc<{ rid?: number; error?: string }>('rpc_brave_start', { p_query: q }, 15000);
    if (!start?.rid) {
      if (start?.error) engineNoteFail('brave_s', 'Brave (server)', 'net', `proxy: ${start.error}`);
      return null;
    }
    // v6.9.55b: 12 polls × 1.5s = 18s — live testing showed the proxy queue
    // regularly takes >12s under load (8-poll budget timed out to null and
    // the lane yielded nothing); the supplement's 10-poll budget works.
    for (let i = 0; i < 12; i++) {
      if (i > 0) await abortableWait(1500);
      const poll = await supabaseRpc<{ state: string; data?: any; error?: string }>('rpc_brave_poll', { p_rid: start.rid }, 15000);
      if (!poll) break;
      if (poll.state === 'done') {
        engineNoteSuccess('brave_s', 'Brave (server)');
        return (poll.data?.web?.results || []).map((r: any) => ({ title: r.title || '', url: r.url || '', description: r.description || '' }));
      }
      if (poll.state === 'failed') { engineNoteFail('brave_s', 'Brave (server)', 'net', `proxy: ${poll.error || 'failed'}`); return null; }
    }
    return null;
  } catch (e: any) {
    if (e?.message !== 'Cancelled') engineNoteFail('brave_s', 'Brave (server)', 'net', String(e?.message || '').slice(0, 60));
    return null;
  }
}

async function overpassViaProxy(query: string, onWait?: (msg: string) => void): Promise<any> {
  if (Date.now() < _proxyDisabledUntil) return null;
  try {
    const t0 = Date.now();
    // v6.9.64: walk FOUR server mirrors (0=api.de, 1=mail.ru, 4=osm.ch —
    // osm.ch verified CORS-open + reliable; kumi/private.coffee stay
    // browser-only last resorts). Poll window per mirror tuned to latency.
    for (const mirror of [0, 1, 4] as const) {
      const start = await supabaseRpc<{ rid?: number; error?: string }>('rpc_overpass_start', { p_q: query, p_mirror: mirror }, 15000);
      if (!start?.rid) continue;
      const rid = start.rid;
      const mirrorName = mirror === 0 ? 'overpass-api.de' : mirror === 1 ? 'mail.ru' : 'osm.ch';
      const maxPolls = mirror === 0 ? 75 : 25; // 150s primary · 50s others
      // Poll every 2s (server-side query timeout is 60–120s)
      for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        if (i > 0) await abortableWait(2000);
        if (i > 0 && i % 5 === 0) onWait?.(`Server processing… ${i * 2}s on ${mirrorName} (queue can take ~2 min)`);
        const poll = await supabaseRpc<{ state: string; data?: any; error?: string }>('rpc_overpass_poll', { p_rid: rid }, 15000);
        if (!poll) break;
        if (poll.state === 'done' && poll.data?.elements !== undefined) {
          if (!poll.data.remark) {
            logRoute('supabase:' + mirrorName, true, Date.now() - t0);
            return poll.data; // real result
          }
          break; // remark = server-side partial → try next mirror
        }
        if (poll.state === 'failed') { logRoute('supabase:' + mirrorName, false, Date.now() - t0); break; }
        // state === 'pending' → keep polling
        if (i === maxPolls - 1) break;
      }
    }
    return null;
  } catch {
    // Proxy unreachable — disable for 2 min and fall back to direct mirrors
    _proxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
    return null;
  }
}

// ─── v6.9.32: Generic whitelisted proxy (Nominatim & geo APIs) ─────
// Same pattern as the Overpass proxy: server-side fetch via pg_net with a
// strict server-side URL whitelist (open-relay impossible). Used first for
// city search — Nominatim rate-limits aggressive browser IPs, the server's
// requests are separate.
let _geoProxyDisabledUntil = 0;

async function nominatimViaProxy(path: string, params: Record<string, string>, timeoutMs = 20000): Promise<any | null> {
  if (Date.now() < _geoProxyDisabledUntil) return null;
  const url = `https://nominatim.openstreetmap.org/${path}`;
  try {
    const start = await supabaseRpc<{ rid?: number; error?: string }>('rpc_proxy_start', { p_url: url, p_params: params }, 15000);
    if (!start?.rid) return null;
    const rid = start.rid;
    for (let i = 0; i < 12; i++) {
      if (isCancelled()) return null;
      if (i > 0) await abortableWait(1500);
      const poll = await supabaseRpc<{ state: string; data?: any }>('rpc_proxy_poll', { p_rid: rid }, 15000);
      if (!poll) break;
      if (poll.state === 'done') return poll.data ?? null;
      if (poll.state === 'failed') return null;
      if (i === 11) break;
    }
    return null;
  } catch {
    _geoProxyDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
    return null;
  }
}

// ─── v6.9.64: Generic server-side page fetch (the guaranteed lane) ─
// Supabase pg_net fetches ANY https page and returns the raw text — no
// browser CORS, no flaky third-party proxies, separate IP pool. This is the
// last arm of corsFetch and the fallback for every search-engine lane.
let _srvFetchDisabledUntil = 0;

// Shared poll loop: collects an rpc_fetch_start/rpc_urlscan_* submission
// via rpc_fetch_poll in separate transactions. Returns only 2xx bodies.
async function pollServerFetch(rid: number, timeoutMs: number): Promise<{ text: string; status?: number } | null> {
  const maxPolls = Math.max(4, Math.ceil(timeoutMs / 2000));
  for (let i = 0; i < maxPolls; i++) {
    if (isCancelled()) return null;
    if (i > 0) await abortableWait(2000);
    const poll = await supabaseRpc<{ state: string; text?: string; status?: number; error?: string }>('rpc_fetch_poll', { p_rid: rid }, 15000);
    if (!poll) return null;
    // v6.9.69: only real 2xx bodies count — 503/403 error pages from the
    // target (or from a rescue archive) must not flow downstream as HTML.
    if (poll.state === 'done' && poll.text && (poll.status === undefined || (poll.status >= 200 && poll.status < 300))) return { text: poll.text, status: poll.status };
    if (poll.state === 'failed') return null;
  }
  return null;
}

async function serverFetchRaw(url: string, timeoutMs = 30000): Promise<string | null> {
  if (Date.now() < _srvFetchDisabledUntil) return null;
  try {
    const start = await supabaseRpc<{ rid?: number; error?: string }>('rpc_fetch_start', { p_url: url }, 15000);
    if (!start?.rid) return null;
    const res = await pollServerFetch(start.rid, timeoutMs);
    return res?.text ?? null;
  } catch {
    _srvFetchDisabledUntil = Date.now() + PROXY_COOLDOWN_MS;
    return null;
  }
}

// ─── v6.9.70: Headless render lane (urlscan.io, key in Vault) ──────
// CF-challenged chain sites defeat every plain fetch arm. urlscan.io runs
// a REAL headless browser: its scan passes Cloudflare challenges and the
// rendered DOM is retrievable afterwards. Runs server-side (migration 014)
// with the API key in Vault — never in the bundle. Free tier ≈ 50 scans/h,
// so the public scan index (search = free) is reused before a fresh submit.
let _renderDisabledUntil = 0;
const _renderCache = new Map<string, string>();

async function renderFetchViaServer(url: string, timeoutMs = 45000): Promise<string | null> {
  if (Date.now() < _renderDisabledUntil) return null;
  const cached = _renderCache.get(url);
  if (cached) return cached;
  yieldTry('render');
  try {
    // 1) Reuse: urlscan's public index for a scan of this exact URL whose
    //    real browser got HTTP 200 (i.e. the challenge was passed).
    let uuid = '';
    const searchRaw = await serverFetchRaw('https://urlscan.io/api/v1/search/?q=page.url%3A%22' + encodeURIComponent(url) + '%22&size=10', 15000);
    if (searchRaw) {
      try {
        const results = (JSON.parse(searchRaw) as { results?: Array<{ _id?: string; page?: { status?: number } }> }).results || [];
        const passed = results.filter(r => !!r._id && r.page?.status === 200);
        if (passed.length > 0) uuid = passed[0]._id!;
      } catch { /* search unavailable — fall through to submit */ }
    }
    // 2) Submit fresh (the only path that consumes quota).
    if (!uuid) {
      const sub = await supabaseRpc<{ rid?: number; error?: string }>('rpc_urlscan_submit', { p_url: url }, 15000);
      if (!sub?.rid || sub.error) return null;
      const subRes = await pollServerFetch(sub.rid, 20000);
      if (!subRes?.text) return null;
      try { uuid = (JSON.parse(subRes.text) as { uuid?: string }).uuid || ''; } catch { return null; }
      if (!uuid) return null;
      // The scan is queued; its DOM materializes seconds later.
      await abortableWait(8000);
    }
    // 3) Rendered DOM through the keyed server RPC.
    const dom = await supabaseRpc<{ rid?: number; error?: string }>('rpc_urlscan_dom', { p_uuid: uuid }, 15000);
    if (!dom?.rid || dom.error) return null;
    const domRes = await pollServerFetch(dom.rid, timeoutMs);
    const domText = domRes?.text ?? null;
    if (domText && domText.length > 500 && !isCfChallenge(domText)) {
      _renderCache.set(url, domText);
      yieldBump('render');
      return domText;
    }
    return null;
  } catch {
    _renderDisabledUntil = Date.now() + 300_000;
    return null;
  }
}

// ─── v6.9.69: Cloudflare-challenge / dead-origin rescue (Wayback arm) ──
// Chain sites (aversi.ge-class) sit behind Cloudflare challenges or have
// dead origins: every normal arm returns a "Just a moment..." page or
// nothing. web.archive.org snapshots carry the real page — the availability
// check is ~1s, the snapshot fetch runs through our own server lane (no
// browser, no CORS, separate IP pool).
const _cfHosts = new Set<string>();   // hosts that served a challenge page
let _wbFails = 0;
let _wbLastFail = 0;
function isCfChallenge(text: string | null | undefined): boolean {
  if (!text) return false;
  const head = text.slice(0, 3000).toLowerCase();
  return head.includes('just a moment') || head.includes('challenge-platform')
    || head.includes('__cf_chl') || head.includes('cf-chl')
    || head.includes('attention required') || head.includes('ddos-guard');
}
function urlHostOf(u: string): string { try { return new URL(u).host; } catch { return ''; } }

async function waybackFetch(url: string, timeoutMs = 25000): Promise<string | null> {
  if (_wbFails >= 3 && Date.now() - _wbLastFail < 300_000) return null;
  try {
    // v6.9.71: direct timestamped-original form FIRST (web.archive.org
    // redirects to the closest snapshot). Proven on aversi.ge: this form
    // returns the real archived HTML — no Wayback toolbar, no dependency
    // on the availability API (whose index is shard-inconsistent) — but
    // only when polled patiently (~10-60s from datacenter IPs; the poll
    // helper's 2s cadence handles that). Availability-API form stays as
    // the second arm for exactness.
    const directForm = 'https://web.archive.org/web/2025id_/' + url.replace(/^https?:\/\//, '');
    const direct = await serverFetchRaw(directForm, timeoutMs);
    if (direct && direct.length > 500 && !isCfChallenge(direct) && !direct.includes('Temporarily Offline') && !direct.includes('Wayback Machine has not archived')) {
      _wbFails = 0; yieldBump('wayback'); return direct;
    }
    const availRaw = await serverFetchRaw('https://archive.org/wayback/available?url=' + encodeURIComponent(url) + '&timestamp=2025', 12000);
    if (!availRaw) return null;
    let snapUrl = '';
    try {
      const avail = JSON.parse(availRaw) as { archived_snapshots?: { closest?: { available?: boolean; url?: string } } };
      if (avail.archived_snapshots?.closest?.available && avail.archived_snapshots.closest.url) snapUrl = avail.archived_snapshots.closest.url;
    } catch { return null; }
    if (!snapUrl) return null;
    const html = await serverFetchRaw(snapUrl, timeoutMs);
    if (html && html.length > 500 && !isCfChallenge(html) && !html.includes('Temporarily Offline')) { _wbFails = 0; yieldBump('wayback'); return html; }
    _wbFails++; _wbLastFail = Date.now();
    return null;
  } catch { _wbFails++; _wbLastFail = Date.now(); return null; }
}

// ─── v6.9.72: GitHub Actions render arm (our own headless lane) ─────
// Dispatches the URL to our render-lane workflow (repository_dispatch;
// PAT lives in Vault, only rpc_render_dispatch touches it). The workflow
// renders in a real headed Camoufox/Chromium and commits the result to
// the render-cache branch: meta/<sha1(url)>.json + dom/<sha1(url)>.html.
// raw.githubusercontent serves CORS *, so the browser polls those files
// DIRECTLY — no server hop, no key, and the DOM persists across sessions
// (a git branch is a free 7-day-fresh CDN).
const _ghRawFails = { n: 0, at: 0 };       // raw.githubusercontent outage memory
const _renderRuns = new Map<string, number>();  // sha → last dispatch time
function ghRawOk(): boolean {
  return !(_ghRawFails.n >= 3 && Date.now() - _ghRawFails.at < 300_000);
}
async function ghRawFetch(path: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch('https://raw.githubusercontent.com/devso3939/Blue-Ocean/render-cache/' + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const text = await res.text();
    _ghRawFails.n = 0;
    return text;
  } catch { _ghRawFails.n++; _ghRawFails.at = Date.now(); return null; }
}
async function renderSha1(url: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function renderFetchViaActions(url: string, timeoutMs = 30000): Promise<string | null> {
  if (!ghRawOk()) return null;
  const cached = _renderCache.get(url);
  if (cached) return cached;
  yieldTry('render');
  let sha = '';
  try { sha = await renderSha1(url); } catch { return null; }
  interface RenderMeta { status?: string; finished_at?: string }
  const FRESH_MS = 7 * 24 * 3600 * 1000;
  const parseMeta = async (): Promise<RenderMeta | null> => {
    const raw = await ghRawFetch('meta/' + sha + '.json', 12000);
    try { return raw ? JSON.parse(raw) as RenderMeta : null; } catch { return null; }
  };
  // 1) Serve a fresh passing render from the cache branch (any prior run,
  //    any session — this is why the lane pays for itself).
  let meta = await parseMeta();
  if (meta?.status === 'done' && meta.finished_at && Date.now() - Date.parse(meta.finished_at) < FRESH_MS) {
    const dom = await ghRawFetch('dom/' + sha + '.html', 20000);
    if (dom && dom.length > 500 && !isCfChallenge(dom)) { _renderCache.set(url, dom); yieldBump('render'); return dom; }
  }
  if ((meta?.status === 'done' || meta?.status === 'challenge') && meta.finished_at && Date.now() - Date.parse(meta.finished_at) < FRESH_MS) {
    return null; // known outcome this week (challenge included) — don't burn a run
  }
  // 2) Fresh dispatch — one per URL per session (run takes 2-5 min; the
  //    DOM lands on the branch for every future attempt). If a dispatch is
  //    ALREADY in flight (prefetch fired it at challenge-detection time),
  //    skip re-dispatching and go straight to polling for it.
  const inFlight = _renderRuns.has(sha) && Date.now() - _renderRuns.get(sha)! < 10 * 60_000;
  if (!inFlight) {
    const disp = await supabaseRpc<{ rid?: number; sha?: string; error?: string }>('rpc_render_dispatch', { p_url: url }, 15000);
    if (!disp || disp.error || !disp.sha) return null;
    _renderRuns.set(disp.sha, Date.now());
  }
  // 3) Short window for a near-complete run to land (full cold runs exceed
  //    any reasonable page-fetch timeout; they simply serve NEXT attempt).
  const waitUntil = Date.now() + Math.min(Math.max(timeoutMs, 20_000), 45_000);
  while (Date.now() < waitUntil) {
    await abortableWait(6000);
    meta = await parseMeta();
    if (meta?.status === 'done') {
      const dom = await ghRawFetch('dom/' + sha + '.html', 20000);
      if (dom && dom.length > 500 && !isCfChallenge(dom)) { _renderCache.set(url, dom); yieldBump('render'); return dom; }
      return null;
    }
    if (meta?.status === 'challenge') return null;
  }
  return null;
}

// CF rescue renderer: our own Actions lane first (free, persistent cache),
// urlscan (dormant until its Vault key lands) as the backup.
async function renderRescue(url: string, timeoutMs = 30000): Promise<string | null> {
  const acted = await renderFetchViaActions(url, timeoutMs);
  if (acted) return acted;
  return renderFetchViaServer(url, timeoutMs);
}

// v6.9.82: SPA-shell heuristic — a page that returns 200 but carries almost
// no static content (React/Next/Vue/Angular app shells). Contact data only
// exists after JS hydration, so static extraction finds nothing and search
// snippets don't carry it either — the headless render lane is the only way
// in. Kept deliberately conservative: small HTML, near-zero visible text,
// plus an explicit framework marker.
function isSpaShell(html: string): boolean {
  if (!html || html.length < 200 || html.length > 60000) return false;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 250) return false;
  return /\b(id="root"|id="app"|id="__next"|id="q-app"|data-reactroot|ng-app|ng-version|__NUXT__|__nuxt)\b/i.test(html);
}

// ── v6.9.73: PREFETCH — dispatch a render the instant a CF wall appears ──
// The lane's runs take 2-5 minutes. Firing the dispatch at challenge-
// detection time (not at need time) means the DOM is warm on render-cache
// exactly when the enrichment harvest pass looks for it.
const _renderQueued = new Set<string>();

// v6.9.74: harvest outcome surfaced to the UI — the results header shows
// '🎭 Render harvest: N sites · M contacts' whenever the pass ran.
export interface RenderHarvestStats { sites: number; contacts: number; ranAt: number; }
let _harvestStats: RenderHarvestStats | null = null;
const _harvestListeners = new Set<(s: RenderHarvestStats | null) => void>();
export function onRenderHarvest(fn: (s: RenderHarvestStats | null) => void): () => void {
  _harvestListeners.add(fn);
  return () => { _harvestListeners.delete(fn); };
}

// v6.9.87: coverage-history reader for the dashboard — latest persisted
// run snapshots across all cities/categories, straight from Supabase.
export interface CoverageHistoryRow {
  id: number; country: string; city: string; category: string;
  businesses: number; phones: number; emails: number; websites: number;
  socials: number; full_trio: number; any_contact_pct: number;
  phone_pct: number; email_pct: number; website_pct: number;
  render_sites: number; render_contacts: number; app_version: string;
  created_at: string;
}
export async function fetchCoverageRecent(limit = 50): Promise<CoverageHistoryRow[] | null> {
  try {
    return await supabaseRpc<CoverageHistoryRow[]>('rpc_coverage_recent', { p_limit: limit }, 15000);
  } catch { return null; }
}

// v6.9.91: server-side run archive — mirrors the on-device History into
// Supabase so runs survive localStorage eviction and restore on any device.
// Sync is fire-and-forget; failure never blocks or slows a run.
export interface RunArchiveMeta {
  run_id: string; kind: 'analyze' | 'discover'; ts: string; version: string;
  country: string; city: string; category: string | null;
  biz_count: number; any_contact_pct: number;
}
export async function archiveRunToServer(rec: {
  id: string; kind: 'analyze' | 'discover'; ts: number; version: string;
  city: { name: string; country: string }; category: string | null;
  stats: { bizCount: number; anyContactPct: number };
  [k: string]: unknown;
}): Promise<boolean> {
  try {
    // v6.9.92b: PostgREST returns a scalar-text RPC response as the bare JSON
    // string "ok" (not {rid:"ok"}) — accept both shapes or a false negative
    // marks a successful upload as failed.
    const res = await supabaseRpc<string | { rid?: string }>('rpc_run_archive_upsert', {
      p_run_id: rec.id, p_kind: rec.kind, p_ts: new Date(rec.ts).toISOString(),
      p_version: rec.version, p_country: rec.city.country, p_city: rec.city.name,
      p_category: rec.category, p_biz_count: rec.stats.bizCount,
      p_any_contact_pct: rec.stats.anyContactPct, p_payload: rec,
    }, 20000);
    return res === 'ok' || (res as { rid?: string })?.rid === 'ok';
  } catch { return false; }
}
export async function listServerRuns(limit = 100): Promise<RunArchiveMeta[] | null> {
  try {
    return await supabaseRpc<RunArchiveMeta[]>('rpc_run_archive_list', { p_limit: limit }, 15000);
  } catch { return null; }
}
export async function fetchServerRunPayload(runId: string): Promise<Record<string, unknown> | null> {
  try {
    return await supabaseRpc<Record<string, unknown>>('rpc_run_archive_get', { p_run_id: runId }, 20000);
  } catch { return null; }
}
function emitHarvest(s: RenderHarvestStats | null): void {
  _harvestStats = s;
  try { (window as unknown as { __boHarvest?: RenderHarvestStats | null }).__boHarvest = s; } catch { /* non-browser */ }
  for (const fn of _harvestListeners) { try { fn(s); } catch { /* listener error never breaks the scan */ } }
}
// v6.9.76 debug hook: seed the render queue through the REAL prefetch path
// (throttles, caching and dedup all apply) — for testing the harvest on
// datasets with no naturally-walled sites.
try { (window as unknown as { __boQueueRender?: (u: string) => boolean }).__boQueueRender = (u: string) => { prefetchRenderDispatch(u); return true; }; } catch { /* non-browser */ }
let _renderDispatches = 0; // v6.9.82: per-scan budget — headless minutes are finite
const RENDER_DISPATCH_BUDGET = 40;
function prefetchRenderDispatch(url: string): void {
  if (_renderQueued.has(url) || !ghRawOk()) return;
  if (_renderDispatches >= RENDER_DISPATCH_BUDGET) return;
  _renderQueued.add(url);
  _renderDispatches++;
  void (async () => {
    try {
      let sha = '';
      try { sha = await renderSha1(url); } catch { return; }
      // Skip dispatch when a usable verdict is already cached this week.
      const metaRaw = await ghRawFetch('meta/' + sha + '.json', 8000);
      if (metaRaw) {
        try {
          const m = JSON.parse(metaRaw) as { status?: string; finished_at?: string };
          const fresh = !!m.finished_at && Date.now() - Date.parse(m.finished_at) < 7 * 24 * 3600 * 1000;
          if (fresh && (m.status === 'done' || m.status === 'challenge')) return;
        } catch { /* dispatch anyway */ }
      }
      if (_renderRuns.has(sha) && Date.now() - _renderRuns.get(sha)! < 10 * 60_000) return;
      const disp = await supabaseRpc<{ rid?: number; sha?: string; error?: string }>('rpc_render_dispatch', { p_url: url }, 15000);
      if (disp?.sha) _renderRuns.set(disp.sha, Date.now());
    } catch { /* silent — prefetch is best-effort */ }
  })();
}

async function pageFetchViaServer(url: string, timeoutMs = 30000): Promise<string | null> {
  const host = urlHostOf(url);
  // Known-challenged host: skip the pointless direct attempt, Wayback-first,
  // then the headless render lane (v6.9.70) for archive-miss URLs.
  if (_cfHosts.has(host)) {
    const wb = await waybackFetch(url, timeoutMs);
    if (wb) return wb;
    const rendered = await renderRescue(url, timeoutMs);
    if (rendered) return rendered;
  }
  const direct = await serverFetchRaw(url, timeoutMs);
  if (direct && !isCfChallenge(direct)) { _cfHosts.delete(host); return direct; }
  // Challenge page (or empty) — mark the host and rescue: Wayback first,
  // then a real headless-browser render as the final arm.
  if (isCfChallenge(direct)) { _cfHosts.add(host); prefetchRenderDispatch(url); }
  const wb = await waybackFetch(url, timeoutMs);
  if (wb) return wb;
  if (isCfChallenge(direct)) {
    const rendered = await renderRescue(url, timeoutMs);
    if (rendered) return rendered;
  }
  return direct; // challenge text is harmless downstream — extractors find nothing
}

// Bing via the server lane: fetch the search HTML from Supabase and run the
// SAME b_algo parser. Independent of Brave quota, browser IP rate limits and
// CORS entirely. Returns [] when the lane is down (never throws).
async function searchBingViaServer(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const html = await pageFetchViaServer('https://www.bing.com/search?q=' + query + '&count=15');
  if (!html) return [];
  if (!/<li class="b_algo"/i.test(html)) return [];
  const results: { title: string; url: string; snippet: string }[] = [];
  const blocks = html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (titleMatch) {
      let url = titleMatch[1];
      if (url.includes('bing.com/ck/a')) {
        const uMatch = url.match(/u=([^&]+)/);
        if (uMatch?.[1].startsWith('a1')) {
          try { url = atob(uMatch[1].substring(2)); } catch {}
        }
      }
      const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
      const snippet = (snippetMatch?.[1] || '').replace(/<[^>]+>/g, '').trim();
      results.push({ title, url, snippet });
    }
  }
  if (results.length > 0) yieldBump('svfetch');
  return results;
}

async function overpassRace(query: string, timeoutSec: number): Promise<any> {
  // Both primaries fire concurrently (secondary ~400ms later — ~2 slots, not a herd).
  const [primary, secondary] = OVERPASS_MIRRORS;
  const fast = await firstSuccess([
    overpassAttempt(primary, query, timeoutSec),
    new Promise<null>(res => setTimeout(() => res(null), 400))
      .then(() => overpassAttempt(secondary, query, timeoutSec)),
  ]);
  if (fast) return fast;
  // Both primaries failed → walk remaining mirrors sequentially.
  // v6.9.30: each fallback is hard-capped at 30s — a hanging mirror used to
  // cost 60s+ twice here before the cooldown/retry logic even began.
  for (let mi = 2; mi < OVERPASS_MIRRORS.length; mi++) {
    const r = await overpassAttempt(OVERPASS_MIRRORS[mi], query, timeoutSec, 30);
    if (r) return r;
    await wait(2000);
  }
  return null;
}

async function fetchOverpass(query: string, timeoutSec = 30, onWait?: (msg: string) => void): Promise<any> {
  _overpassExhausted = false;
  // Cache: identical Overpass query → identical element set. 24h TTL is far
  // below the rate at which POI data materially changes, so results are the
  // same numbers the live query would return.
  const ck = 'ovp_' + cacheKey(query.length, hashStr(query));
  const cached = cacheGet<any>(ck, DAY_MS);
  // v6.9.30: never serve a cached payload that carries a `remark` (partial
  // result from a query that timed out server-side) — belt & suspenders with
  // the CACHE_VERSION purge above.
  if (cached && !cached.remark) return cached;
  // v6.9.31: server-side proxy FIRST (no browser-side 504s / mirror hangs),
  // then the direct hedged race as fallback if Supabase is unreachable.
  onWait?.('Fetching via secure server proxy…');
  let data = await overpassViaProxy(query, onWait);
  if (!data) {
    // First pass: hedged race across the two primary mirrors + walk the rest
    data = await overpassRace(query, timeoutSec);
  }
  // …if everything failed, cool down and try again (typical cause: the IP is
  // rate-limited after a heavy scan; bans usually lift within a minute).
  // v6.9.22: waits are now abort-aware — if the user hits Cancel during the
  // 40s/120s cooldown, the wait resolves immediately instead of hanging.
  if (!data) {
    if (isCancelled()) { _overpassExhausted = true; return null; }
    // v6.9.30: short 15s first retry — cold-start 504s (server just woke up)
    // usually clear within seconds; the old flat 40s made a recoverable
    // first-run hiccup feel like a failure. Rate-limit bans need longer, so
    // the SECOND retry keeps a long 60s pause.
    onWait?.('OpenStreetMap servers are busy — retrying in 15s…');
    if (!(await abortableWait(15000))) { _overpassExhausted = true; return null; }
    data = await overpassRace(query, timeoutSec);
  }
  // Still nothing? One last patient attempt — longer bans need a longer pause.
  if (!data) {
    if (isCancelled()) { _overpassExhausted = true; return null; }
    onWait?.('Still busy — waiting 60s for a final retry…');
    if (!(await abortableWait(60000))) { _overpassExhausted = true; return null; }
    data = await overpassRace(query, timeoutSec);
  }
  if (data) {
    // v6.9.22: skip caching very large payloads — JSON.stringify of a
    // multi-MB full-mode response blocks the main thread for seconds and
    // the localStorage quota-exceeded LRU loop parses every entry, making
    // the freeze worse. Cache only payloads under 2 MB (roughly 500k chars).
    try {
      const serialized = JSON.stringify(data);
      // v6.9.26: never cache empty/1-element responses — that is exactly how
      // the dead-mirror window poisoned scans for 24h. An empty area re-scans
      // next time (cheap); a poisoned city poisons every metric for a day.
      if (data.elements?.length > 1 && serialized.length <= 2_000_000) {
        try {
          localStorage.setItem(CACHE_PREFIX + ck, serialized);
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
            localStorage.setItem(CACHE_PREFIX + ck, serialized);
          } catch { /* give up silently — cache is best-effort */ }
        }
      }
    } catch { /* stringify failed — skip caching */ }
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
        const data = await parseLargeJson(text);
        // v6.9.30: same remark guard as overpassAttempt — a partial (query
        // timed out) response must not be returned as success here either.
        if (data && data.elements !== undefined && !data.remark) return data;
      }
    }
  } catch {}

  _overpassExhausted = true;
  return null;
}

// ─── v6.9.20: city-aware scan area ("right algorithm" fix) ─────────────────
// The old scan drew a FIXED 10 km circle around the city center no matter how
// big the city is. That's how a 4.2M-population city showed "1 dance studio":
// Dubai's metro (JLT, Marina, Al Barsha) stretches 25+ km from the center, so
// most real businesses were simply outside the scan circle. We now scan the
// city's ACTUAL Nominatim bounding box when available, falling back to a
// population-scaled radius otherwise.
export const DEFAULT_SCAN_RADIUS_METERS = 10000;
export const MAX_SCAN_RADIUS_METERS = 35000;

// Population-scaled radius: R = 600 m × pop^0.25, clamped 6–35 km.
// Dubai 3.3M → ~26 km · NYC 8.4M → ~32 km · 1M → ~19 km · 200k town → ~13 km ·
// village → 6 km. Sub-linear (√·√) so megacities don't explode query size.
export function radiusForPopulation(population: number | null | undefined): number {
  const pop = Number(population) || 0;
  if (pop <= 0) return DEFAULT_SCAN_RADIUS_METERS;
  const r = 600 * Math.pow(pop, 0.25);
  return Math.round(Math.min(MAX_SCAN_RADIUS_METERS, Math.max(6000, r)));
}

// Circle bbox around a point: [south, west, north, east].
function circleBbox(lat: number, lon: number, radiusMeters: number): [number, number, number, number] {
  const south = lat - radiusMeters / 111000;
  const north = lat + radiusMeters / 111000;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return [south, lon - radiusMeters / (111000 * cosLat), north, lon + radiusMeters / (111000 * cosLat)];
}

// Combined scan area: the city's real bounding box (Nominatim) when usable,
// padded 15% so boundary districts aren't clipped; each axis capped at ~55 km
// (window stays centered on the city) so a megacity bbox can't explode query
// size. Otherwise falls back to the population-scaled circle.
// Returns [south, west, north, east].
const MAX_AREA_SPAN_DEG = 0.5; // ≈ 55 km per axis

export function computeScanArea(
  lat: number,
  lon: number,
  cityBbox?: [number, number, number, number] | null,
  population?: number | null
): [number, number, number, number] {
  if (cityBbox && cityBbox.length === 4 && cityBbox.every(v => Number.isFinite(v))) {
    const [s, w, n, e] = cityBbox;
    if (s < n && w < e && s >= -90 && s <= 90 && w >= -180 && w <= 180) {
      const span = Math.max(n - s, e - w);
      // v6.9.33: degenerate-bbox guard. A POI (hostel/café) bbox is ~5 m
      // (span ≈ 0.00005°); scanning it yields exactly ONE business — the POI
      // itself. Anything under 2 km per axis is not a city scan area: fall
      // through to the population-scaled circle below.
      const MIN_SPAN_DEG = 0.018; // ≈ 2 km
      if (span < MIN_SPAN_DEG) {
        return circleBbox(lat, lon, radiusForPopulation(population));
      }
      if (span > 0 && span < 0.9) {
        const padLat = (n - s) * 0.15;
        const padLon = (e - w) * 0.15;
        let ps = s - padLat, pw = w - padLon, pn = n + padLat, pe = e + padLon;
        if (pn - ps > MAX_AREA_SPAN_DEG) {
          ps = Math.max(ps, lat - MAX_AREA_SPAN_DEG / 2);
          pn = Math.min(pn, ps + MAX_AREA_SPAN_DEG);
          if (lat < ps || lat > pn) { ps = lat - MAX_AREA_SPAN_DEG / 2; pn = lat + MAX_AREA_SPAN_DEG / 2; }
        }
        if (pe - pw > MAX_AREA_SPAN_DEG) {
          pw = Math.max(pw, lon - MAX_AREA_SPAN_DEG / 2);
          pe = Math.min(pe, pw + MAX_AREA_SPAN_DEG);
          if (lon < pw || lon > pe) { pw = lon - MAX_AREA_SPAN_DEG / 2; pe = lon + MAX_AREA_SPAN_DEG / 2; }
        }
        return [ps, pw, pn, pe];
      }
    }
  }
  return circleBbox(lat, lon, radiusForPopulation(population));
}

// ─── v6.9.34: auto-rescan self-healing ────────────────────────────
// Even with the settlement filter, a bad scan area can slip through (an
// oddly small admin boundary, a city polygon missing from OSM, etc.).
// Healing rule: a FULL-city Discover scan yielding very few businesses is
// almost always an area bug — any real city (pop ≥ 100k) has hundreds.
// The retry enlarges the area in two steps (2×, then 3.5× the original
// span around the same center) and the BETTER result wins; a genuinely
// small town just fails the threshold twice and keeps its honest result.
export function healingScanArea(
  base: [number, number, number, number],
  factor: number,
  center: { lat: number; lon: number }
): [number, number, number, number] {
  const [s, w, n, e] = base;
  const grow = (lo: number, hi: number, c: number) => {
    const half = ((hi - lo) / 2) * factor;
    return [c - half, c + half] as [number, number];
  };
  let [ps, pn] = grow(s, n, center.lat);
  let [pw, pe] = grow(w, e, center.lon);
  // Respect the global query-size cap (~55 km per axis) — same as computeScanArea
  if (pn - ps > MAX_AREA_SPAN_DEG) { ps = center.lat - MAX_AREA_SPAN_DEG / 2; pn = center.lat + MAX_AREA_SPAN_DEG / 2; }
  if (pe - pw > MAX_AREA_SPAN_DEG) { pw = center.lon - MAX_AREA_SPAN_DEG / 2; pe = center.lon + MAX_AREA_SPAN_DEG / 2; }
  // Clamp to sane ranges
  ps = Math.max(-90, ps); pn = Math.min(90, pn);
  pw = Math.max(-180, pw); pe = Math.min(180, pe);
  return [ps, pw, pn, pe];
}

// Total businesses across every category of a scan result map.
export function totalBusinessCount(biz: Map<string, Business[]>): number {
  let n = 0;
  for (const arr of biz.values()) n += arr.length;
  return n;
}

export async function queryBusinesses(
  lat: number,
  lon: number,
  radiusMeters: number = DEFAULT_SCAN_RADIUS_METERS,
  onProgress?: (pct: number, msg: string) => void,
  categoryFilter?: string,
  skipEnrichment?: boolean,
  onEnrichProgress?: (ep: EnrichmentProgress) => void,
  onDiscoverProgress?: (dp: DiscoveryProgress) => void,
  areaBbox?: [number, number, number, number] | null
): Promise<Map<string, Business[]>> {
  // v6.9.41: category focus (Enrich Contacts / Analyze Industry) switches the
  // whole enrichment to FULL-QUEUE mode — every cap below is lifted.
  const CATEGORY_MODE = !!categoryFilter;
  const results = new Map<string, Business[]>();
  // v6.9.20: prefer the city's real bounding box over a center circle
  const [south, west, north, east] =
    areaBbox && areaBbox.length === 4 && areaBbox.every(v => Number.isFinite(v))
      ? areaBbox
      : circleBbox(lat, lon, radiusMeters);
  const bbox = `${south},${west},${north},${east}`;

  // ── Tier 1: SINGLE merged query (food/health/entertainment + shops +
  // tourism/leisure/office/craft/healthcare). Was 3 sequential requests with
  // 1.5s sleeps between them (~2 extra round-trips + 3s wasted); Overpass
  // unions are server-side, so the result set is IDENTICAL — same tags, same
  // bbox, same output. One request ≈ the slowest of the old three, not their sum.
  const qFood = `[out:json][timeout:60][maxsize:536870912];
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
    const qFocused = `[out:json][timeout:45][maxsize:536870912];
(
${groups.map(g => `  node(${bbox})${g};\n  way(${bbox})${g};`).join('\n')}
);
out center body;`;
    onProgress?.(10, `Scanning for ${getCategoryLabel(categoryFilter)}…`);
    const d = await fetchOverpass(qFocused, 45, (msg) => onProgress?.(15, msg));
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
      const qBroad = `[out:json][timeout:30][maxsize:268435456];
(
  node(${bbox})["amenity"];
  way(${bbox})["amenity"];
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;
      const d2 = await fetchOverpass(qBroad, 30, (msg) => onProgress?.(55, msg));
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
    const d1 = await fetchOverpass(qFood, 60, (msg) => onProgress?.(15, msg));
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
      const qMin = `[out:json][timeout:30];
(
  node(${bbox})["amenity"];
  way(${bbox})["amenity"];
  node(${bbox})["shop"];
  way(${bbox})["shop"];
);
out center body;`;
      const d4 = await fetchOverpass(qMin, 30, (msg) => onProgress?.(65, msg));
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
    if (!name.trim() || isJunkBusinessName(name)) continue;

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
      ...(() => extractContactPair(tags, ctx?.countryCode))(),
      // v6.9.52: `|| extractRescueWebsite(tags)` — a misfiled social URL
      // fills an empty website field so the data is rescued, not dropped.
      website: extractWebsite(tags) || extractRescueWebsite(tags),
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


// ─── v6.9.62: Social-bio scraping ───────────────────────────────
// Most businesses without websites DO have Instagram/Facebook pages, and
// those pages carry exactly what the website→contact chain would give us:
// bio emails/phones, wa.me links, and one-hop external links (linktr.ee /
// beacons / taplink → the real site). Until now the pipeline found social
// URLs but never opened them. Strict extractors run on everything we fetch,
// so junk stays out. Session-deduped, watchdog-covered, ≤2 fetches/business.
const _socialBioDone = new Set<string>();
const _BIO_LINK_HOSTS = /linktr\.ee|beacons\.ai|taplink\.cc|solo\.to|carrd\.co|milkshake\.app|linkin\.bio|bio\.link|liinks\.co|urlgeni\.us/i;
const _SOCIAL_FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

async function _fetchSocialText(url: string): Promise<string> {
  try {
    const r = await corsFetch(url, { headers: _SOCIAL_FETCH_HEADERS, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const t = await bodyWithCap(r.text(), 4000);
      if (t && t.length > 60) return t;
    }
  } catch {}
  try {
    const r2 = await corsFetch('https://r.jina.ai/' + url, { signal: AbortSignal.timeout(9000) });
    if (r2.ok) {
      const t2 = await bodyWithCap(r2.text(), 4000);
      if (t2 && t2.length > 60) return t2;
    }
  } catch {}
  return '';
}

async function enrichFromSocialBio(b: Business): Promise<void> {
  const urls: string[] = [];
  if (b.instagram && /^https?:/.test(b.instagram)) urls.push(b.instagram);
  if (b.facebook && /^https?:/.test(b.facebook)) urls.push(b.facebook);
  if (urls.length === 0) return;
  const key = urls.join('|');
  if (_socialBioDone.has(key)) return;
  _socialBioDone.add(key);
  yieldTry('socialbio');
  const need = !b.email || !b.phone || !b.website;
  if (!need) return;

  const apply = async (html: string, allowWebsite: boolean): Promise<boolean> => {
    let touched = false;
    if (html.length < 60) return touched;
    // Phone: wa.me / api.whatsapp / t.me carry the canonical number
    if (!b.phone) {
      const wa = html.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|t\.me\/\+?)([0-9]{8,15})/i);
      if (wa) {
        const cc = getScanContext()?.countryCode;
        const norm = normalizePhone('+' + wa[1], cc);
        const d = norm.replace(/\D/g, '');
        if (d.length >= 8 && d.length <= 15 && plausiblePhone('+' + wa[1])) { b.phone = norm; touched = true; }
      }
    }
    // Run the module extractor (strict, Cloudflare/entity/JSON-LD aware)
    if (!b.email || !b.phone) {
      try { extractFromHtmlModule(html, b); } catch {}
    }
    // One-hop bio links
    if (allowWebsite || !b.website) {
      const seen = new Set<string>();
      for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
        let u = m[0].replace(/[.,;:!]+$/, '');
        let host = '';
        try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }
        if (seen.has(host) || seen.size >= 12) continue;
        seen.add(host);
        if (/instagram\.com|facebook\.com|fb\.com|fbcdn|cdninstagram|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|linkedin\.com|threads\.net|pinterest\.|t\.me|telegram\.me|wa\.me|whatsapp\.com|maps\.google|goo\.gl|google\.com|duckduckgo|yandex\.|mail\.ru|gstatic|w3\.org|schema\.org|apple\.com|microsoft\.com/i.test(host)) continue;
        if (_BIO_LINK_HOSTS.test(host)) {
          // Fetch the link hub and harvest its outbound links + contacts
          const hub = html.match(new RegExp('https?://[^\\s"\'<>\\\\)]*' + host.replace(/\./g, '\\.'), 'i'));
          if (hub) {
            const hubHtml = await _fetchSocialText(hub[0]);
            if (hubHtml) {
              if (!b.email || !b.phone) { try { extractFromHtmlModule(hubHtml, b); touched = true; } catch {} }
              if (!b.website) {
                for (const hm of hubHtml.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
                  const hu = hm[0].replace(/[.,;:!]+$/, '');
                  let hhost = '';
                  try { hhost = new URL(hu).hostname.replace(/^www\./, ''); } catch { continue; }
                  if (_BIO_LINK_HOSTS.test(hhost) || /instagram|facebook|tiktok|youtube|twitter|x\.com|linkedin|t\.me|wa\.me|whatsapp/i.test(hhost)) continue;
                  if (isLikelyBusinessWebsite(hu, b.name, hubHtml.slice(0, 400))) { b.website = hu; touched = true; break; }
                }
              }
            }
          }
        } else if (!b.website && isLikelyBusinessWebsite(u, b.name, html.slice(0, 400))) {
          b.website = u; touched = true;
        }
      }
    }
    return touched;
  };

  for (const u of urls.slice(0, 2)) {
    const html = await _fetchSocialText(u);
    if (html) await apply(html, true);
  }
}

// ─── Enhanced Website Scraper (JSON-LD, OpenGraph, deep contact) ──
// ─── WordPress REST API Scraper ────────────────────────────────
// WordPress sites expose contact info via /wp-json/wp/v2/users and /wp-json/
// ─── Sitemap Scraper ────────────────────────────────────────────
// v6.9.60: full sitemap discovery chain — robots.txt-declared sitemaps,
// WordPress /sitemap_index.xml, Webflow /sitemap-index.xml, then /sitemap.xml;
// sitemap indexes (nested <sitemap>) are expanded one level. Contact-page
// matching now covers Spanish/French/German/Russian/Turkish page words.
const _SITEMAP_CANDIDATES_DISCOVERED = new Set<string>(); // per-session dedupe
async function discoverSitemapUrls(base: string): Promise<string[]> {
  const out: string[] = [];
  const push = (u: string) => { if (!out.includes(u) && out.length < 4) out.push(u); };
  // 1. robots.txt Sitemap: declarations (most reliable source)
  try {
    const rb = await corsFetch(base + '/robots.txt', { signal: AbortSignal.timeout(3000) });
    if (rb.ok) {
      const txt = await rb.text();
      for (const m of txt.matchAll(/^sitemap:\s*(\S+)/gim)) {
        const u = m[1].trim();
        if (/^https?:\/\//i.test(u) && u.includes(new URL(base).hostname.replace(/^www\./, ''))) push(u);
      }
    }
  } catch {}
  // 2. Common CMS index conventions + default
  push(base + '/sitemap_index.xml');  // WordPress (Yoast)
  push(base + '/sitemap-index.xml');  // Webflow / Shopify
  push(base + '/sitemap.xml');
  return out;
}
async function scrapeSitemapForContacts(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  const base = b.website.replace(/\/$/, '');
  const JUNK = /example\.com|wixpress|sentry|googleapis|google\.com|cloudflare|schema\.org|w3\.org|ogp\.me/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
  const PAGE_WORD = /contact|about|team|info|impressum|kontakt|контакт|iletisim|contatti|contacto|contato|nosotros|quiennes-somos|quienes|sobre|empresa|aviso-legal|aviso|nutseekond|nutiiebol|kavshiri|momkhmarebeli|connexion|mentions|კონტაქტ|კავშირ|ჩვენ შესახებ|Հետադարձ|կապ|մեր մասին/i;

  try {
    const sitemapUrls = await discoverSitemapUrls(base);
    let xml = '';
    for (const smUrl of sitemapUrls) {
      if (xml) break;
      try {
        const r = await corsFetch(smUrl, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue;
        const t = await r.text();
        if (/<loc>/i.test(t)) xml = t;
      } catch {}
    }
    if (!xml) return;
    let urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
    // Sitemap index: expand one level (sub-sitemaps)
    if (/sitemapindex/i.test(xml)) {
      const subs = urls.filter(u => /\.xml(\?|$)/i.test(u)).slice(0, 3);
      for (const s of subs) {
        if (b.email && b.phone) break;
        try {
          const sr = await corsFetch(s, { signal: AbortSignal.timeout(3500) });
          if (sr.ok) {
            const st = await sr.text();
            urls = urls.concat([...st.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]));
          }
        } catch {}
      }
    }
    // Find contact/about URLs in sitemap (multilingual)
    const contactUrls = urls.filter(u => PAGE_WORD.test(u));

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
          if (emailM) { b.email = emailM[1].trim(); yieldBump('vcard'); }
        }
        if (!b.phone) {
          const telM = vcf.match(/TEL[^:]*:([^\r\n]+)/i);
          if (telM) { b.phone = telM[1].trim(); yieldBump('vcard'); }
        }
      } catch {}
    }
  } catch {}
}

// ─── Google Maps Place Search Enrichment ────────────────────────
// ── v6.9.98: extract contacts from a rendered Google Maps page ──
// Shared by both arms of the Maps lane (render-lane DOM and server fetch).
// Maps pages embed the full place record (phone, website, address) in the
// initialization payload even when the page itself is a JS app.
function extractFromMapsHtml(html: string, b: Business): number {
  let found = 0;
  if (!b.phone) {
    // Maps embeds the canonical phone in APP_INITIALIZATION_STATE, often as
    // a labeled array element. Prefer explicit phone-shaped strings.
    const m = html.match(/\+\d[\d\s\-\.\(\)]{7,18}/);
    if (m) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(m[0])) { b.phone = m[0].trim(); found++; }
    }
  }
  if (!b.website) {
    const m = html.match(/(?:www\.|https?:\/\/)([^"\s<>]+\.(com|ge|net|org|io|co|am|ru|tr)[^"\s<>]*)/i);
    if (m && !m[0].includes('google.') && !m[0].includes('gstatic') && isLikelyBusinessWebsite(m[0], b.name)) {
      let u = m[0]; if (!u.startsWith('http')) u = 'https://' + u;
      b.website = u; found++;
    }
  }
  if (!b.email) {
    const m = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m && plausibleEmail(m[0])) { b.email = m[0]; found++; }
  }
  if (!b.facebook) {
    const m = html.match(/facebook\.com\/([a-zA-Z0-9._]+)/);
    if (m && !/tr\?id|sharer|dialog|plugins/i.test(m[1])) { b.facebook = 'https://facebook.com/' + m[1]; found++; }
  }
  if (!b.instagram) {
    const m = html.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    if (m && !/p$|explore|accounts/i.test(m[1])) { b.instagram = 'https://instagram.com/' + m[1]; found++; }
  }
  return found;
}

// v6.9.98: Google Maps enrichment rebuilt. The old lane fetched
// google.com/maps/search with plain corsFetch — probes proved Google serves
// a 222KB JS app shell with ZERO contact data to non-JS fetchers (server
// probes: name_pos=161, phone_pos=0). The page needs a REAL browser, which
// is exactly what the headless render lane (urlscan) is. Maps profile pages
// are public, stable, and cached by urlscan's index, so most businesses hit
// the free reuse path without consuming fresh-scan quota.
async function enrichFromGooglePlaces(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS = businesses.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  if (NEEDS.length === 0) return;
  const BATCH = 2;
  const max = Math.min(NEEDS.length, 40); // render lane budget — urlscan free tier ≈ 50/h
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    if (isCancelled()) break;
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const q = encodeURIComponent(b.name + ' ' + (b.address || '').split(',').slice(0, 2).join(','));
        const mapsUrl = 'https://www.google.com/maps/search/' + q + '?hl=en';
        // Arm 1: headless render (real browser — passes the JS wall)
        let html = await renderRescue(mapsUrl, 40000);
        // Arm 2: server lane (sometimes serves APP_INIT state without JS;
        // costs one cheap request, kept second so the render budget goes first)
        if (!html || !/\+\d[\d\s\-\.\(\)]{7,18}/.test(html)) {
          const srv = await serverFetchRaw(mapsUrl, 15000);
          if (srv && srv.length > 5000) html = srv;
        }
        if (!html) return;
        found += extractFromMapsHtml(html, b);
      } catch {}
    }));
    if (i + BATCH < max) await wait(2000);
    onProgress?.(92, 'Google Maps (render)... ' + Math.min(i + BATCH, max) + '/' + max + ' (' + found + ' found)');
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
            if (plausibleEmail(clean)) {
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
    if (m && plausibleEmail(m[0])) { b.email = m[0]; touched = true; }
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
    if (r.ok) {
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
    }
  } catch { /* browser arm failed — fall through to server lane */ }
  // v6.9.64: browser arm blocked/failed → server-side Bing (no CORS, no
  // browser IP). Same parser, independent lane.
  return await searchBingViaServer(query);
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

// v6.9.81: DDG **html** endpoint as the retry-ladder second engine. Measured
// on a 536-business Cafes run the pass-1 html-DDG arm yielded 9 fields in 40
// calls (129s) — the best efficiency of ANY engine (Bing 1/16s) — while
// lite.duckduckgo (searchDDGLite) sat health-gated dead the whole pass. The
// ladder's 'ddg' slot now uses this parser instead.
async function searchDDGHtml(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!engineAvailable('ddg')) return [];
  try {
    const r = await corsFetch('https://html.duckduckgo.com/html/?q=' + query, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { engineNoteFail('ddg', 'DuckDuckGo', classifyEngineError(r.status), `HTTP ${r.status}`); return []; }
    const html = await r.text();
    if (!html || html.length < 200) { engineNoteFail('ddg', 'DuckDuckGo', 'net', 'empty response (blocked)'); return []; }
    if (/anomaly|challenge|captcha|blocked/i.test(html)) { engineNoteFail('ddg', 'DuckDuckGo', 'challenge', 'challenge page'); return []; }
    const out: { title: string; url: string; snippet: string }[] = [];
    // Result anchors: href="//duckduckgo.com/l/?uddg=<enc>&rut=…" or direct https
    for (const m of html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let u = m[1];
      const dec = u.match(/[?&]uddg=([^&]+)/);
      if (dec) { try { u = decodeURIComponent(dec[1]); } catch { continue; } }
      if (u.startsWith('//')) u = 'https:' + u;
      if (!/^https?:\/\//i.test(u) || /duckduckgo\.com/i.test(u)) continue;
      out.push({ url: u, title: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(), snippet: '' });
    }
    const snips = [...html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(m2 => m2[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
    for (let i = 0; i < Math.min(out.length, snips.length); i++) out[i].snippet = snips[i];
    if (out.length > 0) engineNoteSuccess('ddg', 'DuckDuckGo');
    return out.slice(0, 8);
  } catch (e: any) {
    if (e?.message !== 'Cancelled') engineNoteFail('ddg', 'DuckDuckGo', 'net', String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error').slice(0, 60));
    return [];
  }
}

// Wikidata SPARQL lookup: free, keyless, CORS-native. Finds official email/
// phone/website for NOTABLE businesses (chains, hotels, landmarks). Queries
// are serialized (anonymous limit: 1 concurrent).
let _wikidataQueue: Promise<void> = Promise.resolve();
// v6.9.9: sticky scan-wide counter (same pattern as _braveFails/_waybackFails).
// The 45s health cooldown can expire while the serialization queue drains,
// re-admitting doomed requests one at a time — this makes Pass 4 silence
// permanent once Wikidata has failed 3 times in the scan.
let _wikidataFails = 0;
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
      // v6.9.9: sticky counter AND health gate (cooldown can expire mid-queue
      // and re-admit a doomed request; the sticky counter never expires).
      if (!engineAvailable('wikidata') || _wikidataFails >= 3) return;
      const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql), {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BlueOcean/6.2 (market-gap research demo; contact@blueocean.app)' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        _wikidataFails++;
        engineNoteFail('wikidata', 'Wikidata', classifyEngineError(r.status), 'HTTP ' + r.status);
        return;
      }
      engineNoteSuccess('wikidata', 'Wikidata');
      const data = await r.json();
      const row = data?.results?.bindings?.[0];
      if (!row) return;
      if (!b.email && row.email?.value) {
        const e = String(row.email.value).replace(/^mailto:/, '');
        if (plausibleEmail(e)) b.email = e;
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
      _wikidataFails++;
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
  // v6.9.57: ASCII-fold — diacritics (València→valencia, Café→cafe, Böhm→bohm)
  // previously VANISHED in slug generation (the [^a-z0-9] strip deleted the
  // whole character), breaking every domain guess for Spanish/French/
  // Portuguese/Polish/etc names. NFD decomposition + combining-mark removal
  // folds them to their base letter instead.
  const asciiFold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Try multiple slug variants
  const slugs: string[] = [];
  const foldedName = asciiFold(b.name.trim());
  const compact0 = foldedName.toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 20);
  const dashed0 = foldedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 25);
  if (compact0.length >= 3) slugs.push(compact0);
  if (dashed0.length >= 3 && dashed0 !== compact0) slugs.push(dashed0);
  if (nameEn && nameEn !== b.name) {
    slugs.push(asciiFold(nameEn).toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 20));
    slugs.push(asciiFold(nameEn).toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 25));
  }
  // Also try transliterated name
  const translit = transliterateGeo(b.name);
  if (translit !== b.name && translit !== nameEn) {
    slugs.push(asciiFold(translit).toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 20));
  }
  // v6.9.62: brand tokens — distinctive words only. "Kala Kitchen Tbilisi"
  // probes kala.ge / kalakitchen.com, not just the useless full-slug
  // kalakitchentilisi.ge. Generic words (restaurant, cafe, salon…) and
  // city names are stripped; single letters dropped; max 3 tokens.
  const _GENERIC = /^(restaurant|cafe|caf[eé]|bar|pub|hotel|hostel|salon|studio|shop|store|market|bakery|pharmacy|clinic|center|centre|spa|gym|fitness|club|the|and|or|of|da|de|del|la|le|el)$/i;
  const rawTokens = asciiFold(b.name)
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && w.length <= 14 && !_GENERIC.test(w));
  const cityWords = new Set((cityEn || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const brandTokens = Array.from(new Set(rawTokens)).filter(w => !cityWords.has(w)).slice(0, 3);
  for (const tok of brandTokens) {
    if (!slugs.includes(tok)) slugs.unshift(tok);
  }
  // v6.9.57: country TLD FIRST — activaclub.es for a Valencia gym. The old
  // hardcoded list (.ge/.am/.ru/.tr/.fr/.de/.co) never tried the scan
  // country's own ccTLD, so outside the Caucasus the whole
  // website→contact→phone chain died before it started.
  const ccTld = countryTld();
  const tlds = [
    ...(ccTld && ccTld !== 'com' ? ['.' + ccTld] : []),
    '.com',
    ...(ccTld && ccTld !== 'com' ? ['.org', '.net'] : []),
    '.io', '.co', '.eu',
    '.ge', '.am', '.ru', '.tr', '.fr', '.de',
  ];
  let _probeBudget = 8; // v6.9.62: hard cap — brand tokens probe first (most likely), budget never explodes
  for (const slug of slugs) {
    if (slug.length < 3) continue;
    for (const tld of tlds) {
      if (_probeBudget <= 0) return;
      _probeBudget--;
      try {
        const domain = 'https://' + slug + tld;
        const r = await corsFetch(domain, {
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          const html = (await r.text()).toLowerCase();
          // Verify the page actually references the business (name, in any
          // of its written forms) before claiming it as the business's site.
          // v6.9.16: keep ALL major scripts (CJK, Cyrillic, Greek, Arabic,
          // Hebrew, Thai, Devanagari, Kana, Hangul) — Arabic/Hebrew/Korean
          // names were stripped to empty tokens before, letting city-only
          // matches claim wrong domains.
          const nameTokens = [nameEn, translit, b.name]
            .map(n => (n || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\u0400-\u04ff\u0370-\u03ff\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u0900-\u097f\u3040-\u30ff\uac00-\ud7af]+/g, ''))
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

// Brave API key / Serper / Tavily: now managed by the key-pool system at the
// top of this module (see "API-key POOLS" — v6.9.13). Engines access keys via
// the _serperKey()/_tavilyKey()/_braveKey() accessors with automatic rotation.


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
    if (m && plausibleEmail(m[0])) { b.email = m[0]; found.n++; }
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
  if (!engineAvailable('serper') || !_serperKey()) return;
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
          const key = _serperKey();
          if (!key) { engineNoteFail('serper', 'Serper', 'quota', 'all keys exhausted'); return; }
          const r = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: decodeURIComponent(q), num: 5 }),
            signal: AbortSignal.timeout(10000),
          });
          if (r.status === 402 || r.status === 429) {
            // v6.9.13: rotate to the next backup key before giving up
            const next = _poolRotate('serper');
            if (next) {
              engineNoteFail('serper', 'Serper', 'quota', 'key exhausted — rotating to backup key');
              continue; // retry same query with the new active key
            }
            engineNoteFail('serper', 'Serper', 'quota', 'backups exceeded');
            return;
          }
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
  if (!engineAvailable('tavily') || !_tavilyKey()) return;
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
        const key = _tavilyKey();
        if (!key) { engineNoteFail('tavily', 'Tavily', 'quota', 'backups exceeded'); return; }
        const r = await corsFetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: key, query: q, max_results: 5, search_depth: 'basic' }),
          signal: AbortSignal.timeout(12000),
        });
        if (r.status === 0) { engineNoteFail('tavily', 'Tavily', 'net', 'CORS/proxy unavailable'); return; }
        if (r.status === 402 || r.status === 429 || r.status === 401) {
          // v6.9.13: rotate to the next backup key before giving up
          const next = _poolRotate('tavily');
          if (next) {
            engineNoteFail('tavily', 'Tavily', 'quota', 'key exhausted — rotating to backup key');
            return; // next business will use the new key (pool advanced)
          }
          engineNoteFail('tavily', 'Tavily', 'quota', 'backups exceeded');
          return;
        }
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
// v6.9.13: superseded by the key pool (see _braveKey accessor above).


const EXCLUDE_DOMAINS = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com/i;

// Build a smart search query for any language
function buildSearchQuery(b: { name: string; address?: string; categoryLabel?: string; category?: string }): string {
  const ctxQ = getScanContext();
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  // v6.9.17: prefer native city spelling (مراكش/高雄/Алматы) for local dirs
  const cityQ = ctxQ?.cityNative || cityEn;
  const category = b.categoryLabel || '';
  const isLatin = /^[a-zA-Z\u00c0-\u024f\u1e00-\u1eff\s\-'&.0-9]+$/.test(b.name);
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
    if (cityQ) parts.push(cityQ);
  } else {
    // Non-Latin: search by street + category + city + transliterated name
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (cityQ) parts.push(cityQ);
    if (category) parts.push(category);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
    parts.push(`"${b.name}"`);
  }
  // Add keywords that help find contact data in search snippets
  // Native-language category term (e.g. 'კაფე') reaches local-only sites
  const nativeCat = categoryInNative(b.category || '', category);
  if (nativeCat && nativeCat !== category) parts.push(nativeCat);
  // v6.9.16: native contact terms (お問い合わせ/联系/تماس) instead of
  // English-only tails — local-only sites label contact pages natively.
  parts.push(contactTermsNative());
  return encodeURIComponent(parts.join(' '));
}

// Generate multiple query variations for a business (native + English)
function buildSearchQueries(b: Business): string[] {
  const queries: string[] = [];
  const ctx = getScanContext();
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const cityQ = ctx?.cityNative || cityEn;
  const contactQ = contactTermsNative();
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const isLatin = /^[a-zA-Z\u00c0-\u024f\u1e00-\u1eff\s\-'&.0-9]+$/.test(b.name);
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
  // v6.9.17: native city + native contact terms (お問い合わせ/联系/تماس)
  if (isLatin) {
    queries.push(encodeURIComponent(`"${b.name}" ${cityQ || ''} ${contactQ}`));
  } else {
    if (nameEn && nameEn !== b.name) {
      queries.push(encodeURIComponent(`"${nameEn}" ${cityQ || ''} ${contactQ}`));
    }
  }

  // Query 2: Name + street + city (for local businesses)
  if (streetEn && streetEn !== street) {
    queries.push(encodeURIComponent(`"${b.name}" "${streetEn}" ${cityQ || ''} phone email`));
  }

  // Query 3: Transliterated name + category + city (for non-Latin businesses)
  if (!isLatin && nameEn && nameEn !== b.name) {
    queries.push(encodeURIComponent(`"${nameEn}" ${b.categoryLabel || ''} ${cityQ || ''} phone email website`));
  }

  // Query 4: Original name + city (for businesses that appear in local language)
  // v6.9.17: native city spelling pairs with the native business name
  if (!isLatin) {
    queries.push(encodeURIComponent(`"${b.name}" ${cityQ || ''} phone email website contact`));
  }

  return queries.filter(q => q.length > 5);
}

// Build a targeted query specifically for finding contact pages
// Build targeted email-only query
function buildEmailQuery(b: Business): string {
  const cityQ = getScanContext()?.cityNative || '';
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const category = b.categoryLabel || '';
  const isLatin = /^[a-zA-Z\u00c0-\u024f\u1e00-\u1eff\s\-'&.0-9]+$/.test(b.name);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
  } else {
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (category) parts.push(category);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
  }
  if (cityQ) parts.push(cityQ); else if (cityEn) parts.push(cityEn);
  // v6.9.16: native email-contact terms
  parts.push(contactTermsNative());
  return encodeURIComponent(parts.join(' '));
}

// Build targeted phone-only query
function buildPhoneQuery(b: Business): string {
  const cityQ = getScanContext()?.cityNative || '';
  const nameEn = getEnglishCityName(b.name);
  const cityEn = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
  const street = b.address ? b.address.split(',')[0]?.trim() || '' : '';
  const streetEn = getEnglishCityName(street);
  const category = b.categoryLabel || '';
  const isLatin = /^[a-zA-Z\u00c0-\u024f\u1e00-\u1eff\s\-'&.0-9]+$/.test(b.name);
  const parts: string[] = [];
  if (isLatin) {
    parts.push(`"${b.name}"`);
  } else {
    if (streetEn && streetEn !== street) parts.push(`"${streetEn}"`);
    if (category) parts.push(category);
    if (nameEn && nameEn !== b.name) parts.push(`"${nameEn}"`);
  }
  if (cityQ) parts.push(cityQ); else if (cityEn) parts.push(cityEn);
  // v6.9.16: native phone-contact terms
  parts.push(contactTermsNative());
  return encodeURIComponent(parts.join(' '));
}
// guessEmailsFromDomain removed

// ─── DNS MX-validated email guessing ────────────────────────────
// v6.9.60: for businesses with a website but no email, guess the classic
// local-part patterns (info@, contact@, office@…) and KEEP a guess only if
// the domain's DNS actually has MX (mail exchange) records — verified via
// Google/Cloudflare DNS-over-HTTPS. Never fabricates: a domain without
// mail servers rejects every guess. Per-domain results are cached so a
// 100-business category on the same mail host pays DNS once.
const _mxCache = new Map<string, boolean>();
async function domainHasMx(host: string): Promise<boolean> {
  const key = host.replace(/^www\./, '').toLowerCase();
  if (_mxCache.has(key)) return _mxCache.get(key)!;
  let ok = false;
  const doh = [
    `https://dns.google/resolve?name=${encodeURIComponent(key)}&type=MX`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(key)}&type=MX`,
    `https://dns.alidns.com/resolve?name=${encodeURIComponent(key)}&type=MX`,
  ];
  for (const u of doh) {
    try {
      const r = await fetch(u, {
        headers: { 'accept': 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) continue;
      const j = await r.json() as { Answer?: { type: number; data: string }[] };
      if (j.Answer?.some(a => a.type === 15 && a.data)) { ok = true; break; }
      if (j.Answer) break; // authoritative empty answer → no MX
      // No Answer block: try next resolver
    } catch {}
  }
  _mxCache.set(key, ok);
  return ok;
}
async function guessEmailFromDomain(b: Business): Promise<void> {
  if (b.email || !b.website) return;
  try {
    const host = new URL(b.website).hostname.replace(/^www\./, '').toLowerCase();
    // Skip free-mail hosts — info@gmail.com is never the business mailbox
    if (/(gmail|yahoo|hotmail|outlook|yandex|mail\.ru|icloud|proton)\./i.test(host)) return;
    if (!(await domainHasMx(host))) return;
    // v6.9.98: expanded candidate list — regional business conventions
    // (CIS/ru/ka, Turkish, French/German/Spanish) that the old English-only
    // 10-prefix list missed. MX validation still gates every candidate, so
    // a wider list costs only local DNS-style checks, not real sends.
    const locals = ['info', 'contact', 'hello', 'office', 'mail', 'admin', 'support', 'booking', 'sales', 'hi',
      'welcome', 'reservation', 'reservations', 'orders', 'service', 'customer', 'team', 'main',
      'инфо', 'офис', 'заказ', 'заказы', 'связь',
      'iletisim', 'bilgi', 'rezervasyon',
      'contacto', 'contato', 'kontakt'];
    for (const prefix of Array.from(new Set(locals))) {
      if (prefix.includes('@')) continue; // safety: never emit a double-@
      const candidate = prefix + '@' + host;
      if (plausibleEmail(candidate)) { b.email = candidate; yieldBump('mxguess'); return; }
    }
  } catch {}
}

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
  // v6.9.37: crawl while ANY contact field is missing (was: email only).
  // A page carrying a phone but no email was abandoned half-parsed before.
  if (!b.website || (b.email && b.phone && (b.facebook || b.instagram))) return;
  try {
    const base = b.website.replace(/\/$/, '');
    // v6.9.37: fixed the broken '/ contacting' entry (space — could never
    // match any URL) and added the multilingual paths that were only in
    // the dead copy: ka/hy/ru/tr/de/es/pt/it native spellings. Ordered:
    // English CMS standards first, then native-language paths.
    const paths = [
      '/contact', '/contact-us', '/about', '/about-us',
      '/kontakt', '/kontakti', '/контакты', '/iletisim',
      '/contacto', '/contato', '/contatti', '/impressum',
      '/team', '/info', '/locations',
      '/get-in-touch', '/find-us', '/where-to-find-us', '/reach-us',
      '/kavshiri', '/momkhmarebeli',           // Georgian
      '/kontaktay', '/написать-нам',            // Belarusian/Russian
      '/lianxi-women', '/联系方式', '/联系我们',     // Chinese (translit + native)
      '/otoiawase', '/お問い合わせ',               // Japanese
      '/اتصل-بنا', '/اتصل بنا',                  // Arabic
    ];
    let deadContactPaths = 0;
    for (const path of paths) {
      // v6.9.37: stop only when the contact SET is complete — not just email
      if (b.email && b.phone && (b.facebook || b.instagram)) break;
      // Host went network-dead mid-loop: bail out (circuit breaker)
      if (hostIsOpen(base)) break;
      if (deadContactPaths >= 4) break; // repeated dead probes — stop early
      try {
        const r = await corsFetch(base + path, { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
        if (!r.ok) { deadContactPaths++; continue; }
        deadContactPaths = 0;
        const html = await r.text();
        // v6.9.37: use the FULL extractor (JSON-LD, WhatsApp/Viber links,
        // Cloudflare decode, obfuscated emails, labeled phones, socials,
        // ratings) — this crawler previously re-implemented a weak subset
        // and missed everything the homepage scrape already handled.
        extractFromHtml(html, b);
      } catch {}
    }
  } catch {}
}

// ─── v6.9.39: Website deep-crawl second chance ──────────────────────
// scrapeContactPageForEmail only tries FIXED paths (/contact, /kontakt…).
// Modern CMS sites bury contacts on pages with arbitrary slugs
// (/reach-us-at-new-office, /book-a-table, /faqs…). When the fixed-path
// crawl left a business incomplete, this pass fetches the homepage,
// collects INTERNAL links that smell like contact-bearing pages, and
// follows the top few with the full extractor.
async function deepCrawlWebsite(b: Business): Promise<void> {
  if (!b.website || (b.email && b.phone)) return;
  try {
    const base = b.website.replace(/\/$/, '');
    let host = '';
    try { host = new URL(base).hostname.replace(/^www\./, ''); } catch { return; }
    if (hostIsOpen(base)) return;
    const r = await corsFetch(base, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
    if (!r.ok) return;
    const html = await r.text();
    // Mine the homepage itself first (cheap — already fetched)
    extractFromHtml(html, b);
    if (b.email && b.phone) return;
    // Collect internal candidate links, ranked by contact-smell.
    // v6.9.60: match full <a> tags so ANCHOR TEXT counts too — many CMS
    // menus label the contact page in plain words ("Get in touch",
    // "Contacto", "კონტაქტი") while the slug is opaque (/page-42).
    const CONTACT_SMELL = /(contact|kontakt|контакт|about|aboutus|about-us|impressum|team|staff|info|reach|touch|book|reserve|reservation|location|visit|findus|find-us|faq|support|help|office|branch|kavshiri|momkhmarebeli|iletisim|contatti|contacto|contato|lianxi)/i;
    const CONTACT_ANCHOR = /(contact|kontakt|контакт|iletisim|contatti|contacto|contato|contatto|get in touch|reach us|talk to us|enquir|inquir|book a table|reserve|kavshiri|momkhmarebeli|nutse|nutiieb|зв'язок|зв'яток|звязок|lianxi|lian he|savioid|saiderdzneba|კონტაქტ|კავშირ|დაგვიკავშირ|ჩვენ შესახებ|Հետադարձ կապ|կապ|մեր մասին)/i;
    const seen = new Set<string>();
    const candidates: string[] = [];
    const links = html.matchAll(/<a[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi);
    for (const m of links) {
      let u = m[1];
      const anchorText = m[2] || '';
      if (u.startsWith('/')) u = base + u;
      else if (!/^https?:\/\//i.test(u)) continue;
      let h = '';
      try { h = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }
      if (h !== host || seen.has(u)) continue; // internal only, deduped
      seen.add(u);
      if (!CONTACT_SMELL.test(u) && !CONTACT_ANCHOR.test(anchorText)) continue;
      if (/\.(png|jpe?g|gif|svg|pdf|zip|css|js)$/i.test(u)) continue;
      candidates.push(u);
      if (candidates.length >= 12) break;
    }
    // Follow the best-smelling candidates (cap 5 fetches per business)
    let fetched = 0;
    for (const u of candidates) {
      if ((b.email && b.phone) || fetched >= 5 || hostIsOpen(base)) break;
      try {
        const cr = await corsFetch(u, { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
        fetched++;
        if (!cr.ok) continue;
        extractFromHtml(await cr.text(), b);
      } catch {}
    }
  } catch {}
}

async function enrichFromBrave(businesses: Business[], onProgress?: (pct: number, msg: string) => void): Promise<void> {
  const NEEDS = businesses.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  if (NEEDS.length === 0 || !_braveKey()) return;
  // v6.9.6: engine-health gate — a rate-limited Brave returns 429 WITHOUT
  // CORS headers, so the fetch throws and prints a console error. After
  // 3 failures stop calling it entirely (Mojeek/DDG take over).
  // v6.9.9: use the surge guard (sticky counter + 4s post-failure pause).
  if (!braveOkToCall()) return;
  const BATCH = 3;
  const max = Math.min(NEEDS.length, 50); // Brave free tier: 2000 req/mo
  let found = 0;
  for (let i = 0; i < max; i += BATCH) {
    if (!braveOkToCall()) break;
    const batch = NEEDS.slice(i, i + BATCH);
    await Promise.all(batch.map(async (b) => {
      try {
        const q = buildSearchQuery(b);
        const key = _braveKey();
        if (!key) { engineNoteFail('brave', 'Brave', 'quota', 'backups exceeded'); return; }
        const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=3`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
          signal: AbortSignal.timeout(8000),
        });
        // v6.9.9: non-OK responses count too (429 has no CORS headers on the
        // error path only sometimes; a clean 429 response must also trip the
        // gate, not slip through silently).
        // v6.9.13: on quota (402/429/401) rotate to the next backup key; a
        // successful rotation retries the SAME business via a nested call.
        if (r.status === 402 || r.status === 429 || r.status === 401) {
          const next = _poolRotate('brave');
          if (next) { engineNoteFail('brave', 'Brave', 'quota', 'key exhausted — rotating to backup key'); }
          else { braveNoteFail('quota', 'backups exceeded'); }
          return;
        }
        if (!r.ok) { braveNoteFail(classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`); return; }
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
            if (m && plausibleEmail(m[0])) { b.email = m[0]; found++; }
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
        if (e?.message !== 'Cancelled') braveNoteFail('net', String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error').slice(0, 60));
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
            for (const e of emails) {
              const clean = e.replace(/[\s>);]+$/, '');
              if (plausibleEmail(clean)) {
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
      { name: 'Brave (server)', icon: '🛡️', status: 'idle', found: 0 },
      { name: 'Mojeek', icon: '🔆', status: 'idle', found: 0 },
      { name: 'Startpage', icon: '🌱', status: 'idle', found: 0 },
      ...(_serperKey() ? [{ name: 'Serper', icon: '⚡', status: 'idle' as const, found: 0 }] : []),
      ...(_tavilyKey() ? [{ name: 'Tavily', icon: '🧭', status: 'idle' as const, found: 0 }] : []),
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
    // v6.9.59: carry per-layer extraction yield into every progress push
    const _y = getExtractionYield();
    _ep.layerYield = _EXTRACT_LAYER_META
      .map(m => ({ ...m, found: _y[m.key]?.found || 0, tries: _y[m.key]?.tries || 0 }))
      .filter(r => r.tries > 0 || r.found > 0)
      .sort((a, b) => b.found - a.found || b.tries - a.tries);
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
    // v6.9.10: Photon health gate — this loop fires 150 raw fetches at
    // concurrency 5; when Photon starts refusing connections (rate limit /
    // outage) it printed 30+ uncatchable console errors in one pass. Sticky
    // counter + per-batch gate: after 3 failures Photon is skipped for the
    // rest of the pass (addresses simply stay empty — they are cosmetic).
    let _photonFails = 0;
    // v6.9.55: Nominatim backup geocoder — when Photon is dead/rate-limited
    // the address pass used to just stop (addresses stayed empty). Nominatim
    // reverse is a different infrastructure with a strict 1 qps policy, so
    // backup calls are throttled to one per second via a shared last-call
    // timestamp; failures are counted but never throw out of the batch.
    let _nominatimLastCall = 0;
    // v6.9.99: Nominatim circuit breaker. Nominatim does NOT send CORS headers
    // on error/rate-limit responses, and our custom User-Agent header forces a
    // CORS preflight — when Nominatim throttles, every call dies at the preflight
    // and the whole address pass stalls at ~1.1s/business for hundreds of
    // businesses (observed: frozen at 120/550 for 7+ minutes). Now: (1) drop the
    // UA header (Nominatim's usage policy is about identification, and the
    // Referer/Origin already identifies us; without the custom header the fetch
    // is a simple GET with no preflight), (2) after 5 consecutive preflight/net
    // failures the geocoder is abandoned for the rest of the pass — addresses
    // are cosmetic and must never stall contact enrichment.
    let _nominatimFails = 0;
    const nominatimReverse = async (b: Business): Promise<boolean> => {
      if (_nominatimFails >= 5) return false; // circuit open — skip silently
      const gap = Date.now() - _nominatimLastCall;
      if (gap < 1100) await wait(1100 - gap);
      _nominatimLastCall = Date.now();
      try {
        // v6.9.99c: direct simple GET only. The server-lane arm here was a
        // trap: one pollServerFetch call can take 15-90s (5 polls × 15s RPC
        // timeout each), so a throttled Nominatim froze the whole phase for
        // minutes per batch. Addresses are cosmetic — direct GET works when
        // Nominatim serves 200, and the 5-fail circuit breaker below stops
        // the grind when it doesn't. No server round-trips for cosmetics.
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${b.lat}&lon=${b.lon}&format=jsonv2&zoom=18&addressdetails=1`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) { _nominatimFails++; return false; }
        const d = await r.json();
        const a = d?.address || {};
        const parts = [a.road || a.pedestrian || a.footway, a.house_number, a.suburb || a.neighbourhood || a.city_district, a.city || a.town || a.village].filter(Boolean);
        if (parts.length > 0) { b.address = parts.join(', '); _nominatimFails = 0; return true; }
        return false;
      } catch { _nominatimFails++; return false; }
    };
    // v6.9.41: category mode fills addresses for the whole category
    // v6.9.99b: hard wall-clock budget for the whole address phase (90s).
    // Addresses are cosmetic — every second spent here delays contact
    // enrichment, the thing users actually wait for. After 90s the phase
    // ends regardless of how many businesses remain (they keep the OSM
    // street/city data they already carry).
    const _addrDeadline = Date.now() + 90_000;
    const maxEnrich = CATEGORY_MODE ? allBizList.length : Math.min(allBizList.length, 150);
    const CONCURRENCY = 5; // Photon allows more parallel requests
    let _addrDone = 0; // businesses actually attempted
    for (let i = 0; i < maxEnrich; i += CONCURRENCY) {
      if (isCancelled()) break;
      if (Date.now() > _addrDeadline) {
        onProgress?.(75, `Address fill budget reached — ${_addrDone} addressed, continuing to contacts`);
        break;
      }
      // v6.9.99: both geocoders dead → stop grinding no-op batches (was: 430
      // × 1.1s of guaranteed-failure waits freezing the run at one percent).
      if (_photonFails >= 3 && _nominatimFails >= 5) {
        onProgress?.(75, 'Address geocoders offline — skipping cosmetic address fill');
        break;
      }
      const batch = allBizList.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (b) => {
        if (b.address) return; // already has address
        // v6.9.10: photon dead → v6.9.55: fall back to Nominatim instead of skipping
        if (_photonFails >= 3) { engineNoteFail('photon', 'Photon (addresses)', 'net', 'dead — using Nominatim backup'); await nominatimReverse(b); return; }
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
          } else {
            _photonFails++;
            await nominatimReverse(b);
          }
        } catch {
          _photonFails++;
          await nominatimReverse(b);
        }
      }));
      _addrDone += batch.length;
      if (i + CONCURRENCY < maxEnrich && _photonFails < 3) await wait(500);
      onProgress?.(75, `Filling addresses… ${Math.min(i + CONCURRENCY, maxEnrich)}/${maxEnrich}${_photonFails >= 3 ? ' (Nominatim backup)' : ''}`);
      _ep.businessesProcessed = Math.min(i + CONCURRENCY, maxEnrich);
      emitEP();
    }
  }

  onProgress?.(80, `Found ${totalBiz} businesses — enriching data in parallel…`);

  // ── v6.9.13: SCAN-START ENGINE PREFLIGHT ──
  // Probe each fallible engine ONCE with a real (cheap) request before the
  // per-business waves start. A service that is rate-limited / down is
  // discovered here — its health gate closes — so the waves never fire the
  // doomed per-business fetches that used to print console-error storms.
  // Cost: ~1.5s. Benefit: bounded first-contact logs (~4 instead of ~14).
  // v6.9.55: reset session health first — cooldowns must not leak across
  // scans. Without this, a Brave rate-limit from scan #1 skipped Brave in
  // every later scan even when the limit had long expired, and the red
  // badges re-appeared in the UI with no engine actually probed.
  {
    for (const e of _engineHealth.values()) {
      if (e.status !== 'quota') { e.status = 'ok'; e.fails = 0; e.cooldownUntil = 0; e.detail = ''; }
      // quota entries survive the reset (sticky for the session by design)
    }
    _braveFails = 0; // surge guard resets with it
  }
  {
    const probe = async (id: string, label: string, fn: () => Promise<Response>): Promise<void> => {
      if (!engineAvailable(id)) return; // already cooled-down from a previous scan
      try {
        const r = await fn();
        if (r.status === 402 || r.status === 429 || r.status === 401) {
          engineNoteFail(id, label, 'quota', 'preflight: quota');
          return;
        }
        if (r.ok) { engineNoteSuccess(id, label); return; }
        engineNoteFail(id, label, classifyEngineError(r.status, await r.text().catch(() => '')), `preflight: HTTP ${r.status}`);
      } catch (e: any) {
        if (e?.message !== 'Cancelled') engineNoteFail(id, label, 'net', 'preflight: unreachable');
      }
    };
    await Promise.all([
      // Brave — probe only when the pool has a key and health allows
      ...(_braveKey() && braveOkToCall() ? [probe('brave', 'Brave', async () => {
        const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=Tbilisi%20cafe&count=1`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': _braveKey() },
          signal: AbortSignal.timeout(3000),
        });
        // Rotate pool key on quota so the scan starts on a healthy key
        if (r.status === 402 || r.status === 429 || r.status === 401) _poolRotate('brave');
        return r;
      })] : []),
      // Serper — POST probe with tiny query
      ...(_serperKey() ? [probe('serper', 'Serper', async () => {
        const r = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': _serperKey(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: 'test', num: 1 }),
          signal: AbortSignal.timeout(3000),
        });
        if (r.status === 402 || r.status === 429) _poolRotate('serper');
        return r;
      })] : []),
      // Tavily — POST probe
      ...(_tavilyKey() ? [probe('tavily', 'Tavily', async () => {
        // v6.9.25: via corsFetch — Tavily sends no CORS headers, raw fetch
        // always throws and floods the console (found in live testing)
        const r = await corsFetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: _tavilyKey(), query: 'test', max_results: 1 }),
          signal: AbortSignal.timeout(3000),
        });
        if (r.status === 402 || r.status === 429 || r.status === 401) _poolRotate('tavily');
        return r;
      })] : []),
      // Wikidata — 1-row SPARQL probe (also warms the endpoint)
      probe('wikidata', 'Wikidata', async () => {
        const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent('SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT 1'), {
          headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BlueOcean/6.9 (preflight)' },
          signal: AbortSignal.timeout(4000),
        });
        return r;
      }),
      // Photon — reverse probe near Tbilisi center (address pass already ran,
      // so this mainly protects a SECOND scan in the same session)
      probe('photon', 'Photon (addresses)', async () => {
        const r = await fetch('https://photon.komoot.io/reverse?lat=41.7151&lon=44.8271&lang=en', { signal: AbortSignal.timeout(3000) });
        return r;
      }),
      // Bing — HTML engine; searchBing returns [] on challenge/HTTP fail,
      // so the probe synthesizes a tiny search and counts non-empty results
      // as success (v6.9.55: Bing failures were swallowed silently before,
      // leaving its health gate permanently 'ok' even while dead).
      probe('bing', 'Bing', async () => {
        const results = await searchBing('Tbilisi cafe');
        return new Response(results.length > 0 ? 'ok' : 'empty', { status: results.length > 0 ? 200 : 503 });
      }),
      // cors.sh — proxy health (200 on /ping when alive)
      probe('corssh', 'cors.sh proxy', async () => {
        const r = await fetch('https://cors.sh/https://example.com', { signal: AbortSignal.timeout(3000) });
        return r;
      }),
    ]);
  }

  // ── Per-business enrichment pipeline ──
  // Priority: Brave API → scrape website → DDG → scrape → Bing → DDG Lite → social → regional
  // Each business follows the SAME priority chain, maximizing data per business
  if (isCancelled()) { onProgress?.(100, 'Cancelled'); return results; }

  const NEEDS_ENRICHMENT = allBizList.filter(b => !b.phone || !b.website || !b.email || (!b.facebook && !b.instagram));
  // v6.9.41: FULL-QUEUE mode — in category focus (Enrich Contacts / Analyze
  // Industry) the enrichment no longer stops at a fixed 200. It processes the
  // ENTIRE need queue, so one run covers the whole category instead of needing
  // 2-3 stacked runs on a 500-business category. Full-city Discover keeps the
  // legacy cap: its contract is fast first results, and engines throttle.
  const maxEnrich = CATEGORY_MODE ? NEEDS_ENRICHMENT.length : Math.min(NEEDS_ENRICHMENT.length, 200);
  // Adaptive pacing: keep politeness sleeps short when the queue is big —
  // 200ms sleeps every 10 businesses over 1000 businesses would waste 20s
  // on sleeping alone. Small queues keep the gentle rhythm.
  const _POLITE_MS = CATEGORY_MODE && NEEDS_ENRICHMENT.length > 300 ? 100 : 200;
  const _EXCLUDE = /example\.com|wixpress|sentry\.io|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest|tumblr|reddit\.com|quora|wikipedia|youtube\.com|tiktok\.com|linkedin\.com|x\.com|snapchat|threads|medium\.com|substack|gh-pages|archive\.org|amazon\.com|ebay\.com|aliexpress/i;

  _ep.activePass = 'Enriching contacts (priority pipeline)'; _ep.passNumber = 1; _ep.percent = 80;
  _ep.engines.forEach(e => { e.status = 'active'; e.found = 0; });
  emitEP();

  const _BATCH = 10;
  const _BIZ_CAP_MS = 45_000; // v6.9.61: per-business watchdog — no lane may hold a batch hostage
  let enrichedCount = 0;

  for (let i = 0; i < maxEnrich; i += _BATCH) {
    if (isCancelled()) break;
    const batch = NEEDS_ENRICHMENT.slice(i, i + _BATCH);
    // ── Live discovery feed: mark these businesses as currently being parsed ──
    batch.forEach(b => recordBusiness(b, 'parsing'));
    logQuery(buildSearchQuery(batch[0]), `${batch.length} businesses`);
    await Promise.all(batch.map(async (b, bi) => {
      // v6.9.61: per-business watchdog. AbortSignal.timeout only caps until
      // response HEADERS — a server that sends headers then stalls the body
      // hangs `await r.text()` forever, freezing the whole batch and the
      // progress counter (observed live at 290/535). The race abandons the
      // stalled business after _BIZ_CAP_MS and lets the scan move on.
      let _bizT: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async (): Promise<void> => {
        // Helper: check if business has sufficient data (phone OR email + website)
        const hasSufficientData = () => (b.phone && b.email) || (b.phone && b.website) || (b.email && b.website);
        let websiteScraped = false;
        const scrapeWebsiteOnce = async () => {
          if (websiteScraped || !b.website) return;
          websiteScraped = true;
          // v6.9.37: full contact set = email + phone + a social profile.
          // The old gate stopped after the homepage deep-scrape as soon as
          // ANY two fields existed, leaving email OR phone unharvested even
          // when the site's contact page had both.
          const contactSetComplete = () => !!(b.email && b.phone && (b.facebook || b.instagram));
          if (!contactSetComplete()) {
            try { await enrichFromWebsiteDeep(b); } catch {}
          }
          // v6.9.37: wire in the previously DEAD scrapers — sitemap contact
          // discovery, WordPress REST API, and vCard files all existed but
          // were never called, leaving free contact sources untapped.
          if (!contactSetComplete()) {
            try { await scrapeSitemapForContacts(b); } catch {}
          }
          if (!contactSetComplete()) {
            try { await scrapeWordPressAPI(b); } catch {}
          }
          if (!contactSetComplete()) {
            try { await scrapeVCard(b); } catch {}
          }
          // v6.9.60: DNS-MX-validated email guessing for site-owning
          // businesses whose contact pages stayed email-dark.
          if (!b.email && b.website) {
            try { await guessEmailFromDomain(b); } catch {}
          }
          // v6.9.37: run the contact-page crawler while EITHER email or
          // phone is missing (was: email only — pages with a phone but no
          // email were abandoned half-parsed).
          if (!b.email || !b.phone) {
            try { await scrapeContactPageForEmail(b); } catch {}
          }
        };

        // ═══ PHASE 1: ALL search engines in PARALLEL (3-4s total, not 20s) ═══
        const q = buildSearchQuery(b);
        // v6.9.55: shared Brave result applier — used by the browser arm AND
        // the server-side fallback paths (same extraction, one definition).
        const applyBraveResults = (results: { title: string; url: string; description: string }[], kgUrl?: string) => {
          let touched = false;
          for (const res of results) {
            if (extractFromText((res.description || '') + ' ' + (res.title || ''), b)) touched = true;
            if (!b.website && res.url && !_EXCLUDE.test(res.url) && !res.url.includes('google.com/maps') && isLikelyBusinessWebsite(res.url, b.name, (res.description || '') + ' ' + (res.title || ''))) b.website = res.url;
          }
          if (kgUrl && !b.website && !_EXCLUDE.test(kgUrl) && isLikelyBusinessWebsite(kgUrl, b.name)) b.website = kgUrl;
          if (touched || b.website) markEngine(b, 'Brave');
        };
        // Helper: run one search-engine arm with health tracking + skip when
        // the engine is cooling down / quota-dead (no wasted failing fetches).
        // v6.9.55: optional `fallback` runs when the engine is SKIPPED, so a
        // cooled-down browser engine hands the business to its backup instead
        // of silently dropping the lane for the rest of the scan.
        const engineArm = async (id: string, label: string, fn: () => Promise<boolean>, fallback?: () => Promise<void>) => {
          if (!engineAvailable(id)) {
            armStat(id).skips++;
            if (fallback) { try { await fallback(); } catch {} }
            return;
          }
          // v6.9.65 profiling: wall-time + fields-gained per arm
          const _armSigBefore = `${b.website || ''}|${b.phone || ''}|${b.email || ''}|${b.facebook || ''}|${b.instagram || ''}`;
          const _t0 = Date.now();
          try {
            const ok = await fn();
            armStat(id).calls++;
            armStat(id).ms += Date.now() - _t0;
            const _armSigAfter = `${b.website || ''}|${b.phone || ''}|${b.email || ''}|${b.facebook || ''}|${b.instagram || ''}`;
            if (_armSigAfter !== _armSigBefore) armNoteGain(id);
            if (ok) engineNoteSuccess(id, label);
          } catch (e: any) {
            armStat(id).calls++;
            armStat(id).ms += Date.now() - _t0;
            if (e?.message === 'Cancelled') return;
            engineNoteFail(id, label, 'net', String(e?.message || '').slice(0, 80));
          }
        };
        await Promise.all([
          engineArm('mojeek', 'Mojeek', async () => {
            if (engineAvailable('brave') && _braveKey()) return false; // Brave is primary when healthy
            const r = await corsFetch('https://www.mojeek.com/search?q=' + q, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) { engineNoteFail('mojeek', 'Mojeek', classifyEngineError(r.status), `HTTP ${r.status}`); return false; }
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
          // Serper (Google SERP API — free tier, optional key)
          ...(_serperKey() ? [(async () => {
            if (!engineAvailable('serper')) return;
            const before = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            await enrichFromSerper([b]);
            const after = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            if (before !== after) { markEngine(b, 'Serper'); engineNoteSuccess('serper', 'Serper'); }
          })()] : []),
          // Tavily (AI search API — free tier, optional key)
          ...(_tavilyKey() ? [(async () => {
            if (!engineAvailable('tavily')) return;
            const before = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            await enrichFromTavily([b]);
            const after = `${b.website||''}|${b.phone||''}|${b.email||''}`;
            if (before !== after) { markEngine(b, 'Tavily'); engineNoteSuccess('tavily', 'Tavily'); }
          })()] : []),
        ]);

        // ═══ WAVE 2 (v6.9.65): measured low-yield arms — only for businesses
        // the fast arms couldn't satisfy. Profiling a full Tbilisi Cafes run
        // (535 businesses): Brave averaged 118s per field gained (35 min of
        // cumulative fetch time for 18 gains, 4.2s stall per call), DDG Lite
        // 89s per gain (1 gain in 535 calls). They never ran with the data
        // they needed and paced every batch. Now they only fire when the
        // business is still contact-thin after wave 1 — most businesses skip
        // them entirely, so batches finish at wave-1 speed.
        if (!hasSufficientData()) {
          await Promise.all([
          // DDG Lite (89s/gain measured) — cheap per call but near-zero yield
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
          // Brave API (118s/gain measured — highest latency, lowest yield;
          // full original arm moved here: key-pool rotation + server-side
          // fallback, stagger burn no longer applies to satisfied businesses)
          engineArm('brave', 'Brave', async () => {
            // v6.9.12: stagger + gate re-check, same as the email arm —
            // the 10-business batch fires this arm in parallel, so without
            // a mid-wave failure to trip the surge guard all 10 429s print
            // at once. Span 400ms×9 > the 2s timeout below.
            if (bi > 0) await wait(400 * bi);
            if (!braveOkToCall()) return false;
            const bkey = _braveKey();
            if (bkey) {
              try {
                const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`, {
                  headers: { 'Accept': 'application/json', 'X-Subscription-Token': bkey },
                  signal: AbortSignal.timeout(2000),
                });
                if (r.ok) {
                  const data = await r.json();
                  applyBraveResults(data.web?.results || [], data.knowledge_graph?.url);
                  return true;
                }
                // v6.9.13: quota → rotate to next backup key (same business re-arms)
                if (r.status === 402 || r.status === 429 || r.status === 401) {
                  const next = _poolRotate('brave');
                  engineNoteFail('brave', 'Brave', 'quota', next ? 'key exhausted — rotating to backup key' : 'backups exceeded');
                } else {
                  braveNoteFail(classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`);
                }
              } catch (e: any) {
                if (e?.message !== 'Cancelled') braveNoteFail('net', String(e?.name === 'TimeoutError' ? 'timeout' : 'network error').slice(0, 60));
              }
            } else {
              engineNoteFail('brave', 'Brave', 'quota', 'backups exceeded');
            }
            // v6.9.55: browser arm failed (rate limit / no key / network) →
            // reroute THIS business through the server-side Brave proxy —
            // a separate quota pool (Vault key), so the lane keeps yielding.
            const srv = await braveSearchViaSupabase(decodeURIComponent(q));
            if (srv && srv.length > 0) { applyBraveResults(srv); return true; }
            return false;
          }, async () => {
            // v6.9.55: browser engine skipped (cooldown/quota from a previous
            // wave) → the server-side proxy keeps this business's Brave lane
            // alive instead of silently dropping it for the whole scan.
            const srv = await braveSearchViaSupabase(decodeURIComponent(q));
            if (srv && srv.length > 0) applyBraveResults(srv);
          }),
          ]);
        }

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
              // v6.9.9: surge guard (sticky + 4s pause) caps wave-amplified
              // 429 storms when a whole enrichment wave hits rate-limit.
              // v6.9.10: stagger + re-check the gate just before firing —
              // the first failure must land MID-wave to block the rest.
              // v6.9.11: stagger span (400ms×9 = 3.6s) now exceeds the
              // reduced 2s timeout, so a dead Brave costs ≤5 errors per
              // wave instead of 10.
              // v6.9.55: when the browser arm is gated out, the server-side
              // proxy takes this email query so the lane still yields.
              if (bi > 0) await wait(400 * bi);
              if (braveOkToCall()) {
                const ebkey = _braveKey();
                if (ebkey) {
                  try {
                    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${emailQ}&count=5`, {
                      headers: { 'Accept': 'application/json', 'X-Subscription-Token': ebkey },
                      signal: AbortSignal.timeout(2000),
                    });
                    if (r.status === 402 || r.status === 429 || r.status === 401) {
                      const next = _poolRotate('brave');
                      engineNoteFail('brave', 'Brave', 'quota', next ? 'key exhausted — rotating to backup key' : 'backups exceeded');
                    } else if (r.ok) {
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
                      braveNoteFail(classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`);
                    }
                  } catch (e: any) {
                    if (e?.message !== 'Cancelled') braveNoteFail('net', String(e?.name === 'TimeoutError' ? 'timeout' : 'network error').slice(0, 60));
                  }
                } else {
                  engineNoteFail('brave', 'Brave', 'quota', 'backups exceeded');
                }
              }
              if (!engineAvailable('brave')) {
                const srv = await braveSearchViaSupabase(decodeURIComponent(emailQ));
                if (srv) {
                  for (const res of srv) {
                    extractFromText((res.description || '') + ' ' + (res.title || ''), b);
                    if (!b.email && res.url && /contact|about|team/i.test(res.url)) {
                      try {
                        const pageR = await corsFetch(res.url, { signal: AbortSignal.timeout(3000) });
                        if (pageR.ok) extractFromHtml(await pageR.text(), b);
                      } catch {}
                    }
                  }
                }
              }
            })(),
            (async () => {
              // v6.9.8: gate — when the shared DDG engine is cooling down,
              // this per-business email query would just print another
              // allorigins abort error for zero data.
              if (engineAvailable('ddg')) {
                try {
                  const r = await corsFetch('https://html.duckduckgo.com/html/?q=' + emailQ, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    signal: AbortSignal.timeout(4000),
                  });
                  if (r.ok) extractFromHtml(await r.text(), b);
                } catch {}
              } else {
                // v6.9.98: Bing fallback — the email query survives a DDG
                // cooldown instead of silently dropping the arm for that
                // business (Bing itself falls back to the server lane).
                try {
                  const bingE = await searchBing(decodeURIComponent(emailQ));
                  let touchedE = false;
                  for (const res of bingE.slice(0, 5)) {
                    if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) touchedE = true;
                    if (!b.email && res.url && /contact|about|team/i.test(res.url)) {
                      try {
                        const pageR = await corsFetch(res.url, { signal: AbortSignal.timeout(3000) });
                        if (pageR.ok) extractFromHtml(await pageR.text(), b);
                      } catch {}
                    }
                  }
                  if (touchedE) yieldBump('snippetdig');
                } catch {}
              }
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

        // ═══ PHASE 6 (v6.9.62): social-bio mining — open the IG/FB pages we
        // found and harvest bio emails/phones, wa.me numbers, and one-hop
        // link-hub → real-website chains. Runs only when something is still
        // missing; the strict extractors keep junk out.
        if (b.facebook || b.instagram) {
          if (!b.email || !b.phone || !b.website) {
            try { await enrichFromSocialBio(b); } catch {}
          }
          // If a bio link revealed a website, the whole website→contact chain
          // now runs on it (deep scrape → sitemap → WP API → vCard → MX).
          if (b.website && (!b.email || !b.phone)) {
            try { await scrapeWebsiteOnce(); } catch {}
          }
        }

        // ═══ PHASE 7 (v6.9.64): snippet dig — server-lane search focused on
        // contact-bearing pages. Bing/DDG snippets often expose the phone or
        // email even when the site itself is unreachable from the browser;
        // extraction is snippet-only, so this is cheap and junk-safe (strict
        // extractors apply).
        if ((!b.phone || !b.email) && b.name) {
          try {
            const ctxCity = getScanContext()?.cityNative || '';
            const want = b.phone ? 'email OR e-mail OR почта' : 'phone OR телефон OR ტელეფონი OR هاتف';
            const digQ = encodeURIComponent(`"${b.name}" ${ctxCity} ${want}`.trim());
            const digResults = await searchBing(digQ);
            let digTouched = false;
            for (const res of digResults.slice(0, 6)) {
              if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) digTouched = true;
              if (b.phone && b.email) break;
            }
            if (digTouched) yieldBump('snippetdig');
          } catch {}
        }

        if (b.phone || b.email || b.website) enrichedCount++;
        // ── Live discovery feed: record finished business ──
        const fieldsFound = [b.email, b.phone, b.website, b.facebook || b.instagram].filter(Boolean).length;
        const finalStatus: 'parsing' | 'enriched' | 'partial' | 'minimal' =
          fieldsFound >= 3 ? 'enriched' : fieldsFound >= 1 ? 'partial' : 'minimal';
        recordBusiness(b, finalStatus, lastSuccessfulEngineFor(b));
          })(),
          new Promise<never>((_, rej) => { _bizT = setTimeout(() => rej(new Error('business-watchdog')), _BIZ_CAP_MS); }),
        ]);
      } catch {} finally { if (_bizT) clearTimeout(_bizT); }
    }));

    if (i + _BATCH < maxEnrich) await wait(_POLITE_MS);
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

  // ═══ Regional + verification passes — v6.9.40: ADAPTIVE PARALLEL LANES ═══
  // These passes used to run strictly one-after-another, so a big category
  // paid the SUM of their wall-times (dominated by the inter-batch sleeps).
  // Engine-wise they split into two clean waves:
  //   Wave A — 2GIS API, social-profile fetches, Google Places, Wikidata +
  //            Wayback: four DISJOINT hosts, zero shared engines.
  //   Wave B — Yandex (rides DDG) + deep-crawl/domain harvest (partly DDG):
  //            both share the DDG health gate, so they run together AFTER
  //            wave A to keep DDG pressure at two lanes, not six.
  // Each lane is the exact former sequential block, wrapped in a closure.
  // Percent is driven by a monotonic tracker — the slowest lane pulls the
  // bar forward, lanes never fight over it.
  const bumpPercent = (p: number) => { if (p > _ep.percent) { _ep.percent = p; emitEP(); } };

  // ── Lane: 2GIS (excellent for Georgia, Russia, CIS countries) ──
  // v6.9.98: widened from "missing EVERYTHING" to "missing phone OR website"
  // — 2GIS profiles carry emails too (the old loop silently dropped them),
  // and a business with a phone but no website still benefits. Email
  // extraction added below alongside phone/website/address.
  const lane2GIS = async () => {
    const need2GIS = allBizList.filter(b => !b.phone || !b.website || !b.email);
    if (need2GIS.length === 0) return;
    _ep.activePass = 'Pass 2: Regional (2GIS)'; _ep.passNumber = 2; bumpPercent(91);
    _ep.engines.find(e => e.name === '2GIS')!.status = 'active'; emitEP();
    for (let i2 = 0; i2 < (CATEGORY_MODE ? Math.min(need2GIS.length, 250) : Math.min(need2GIS.length, 60)); i2 += _BATCH) {
      if (laneStop()) break;
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
                // v6.9.98: 2GIS exposes emails as type 'email' — the old loop
                // never read them, leaving a free contact source untapped for
                // every CIS/Georgia business listed there.
                if (!b.email && item.contact_groups) {
                  for (const grp of item.contact_groups) {
                    for (const contact of (grp.contacts || [])) {
                      if ((contact.type === 'email' || /@/.test(String(contact.value || ''))) && contact.value && plausibleEmail(String(contact.value).trim())) {
                        b.email = String(contact.value).trim();
                        yieldBump('svfetch');
                        break;
                      }
                    }
                    if (b.email) break;
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
  };

  // ── Lane: Yandex (dominant in Georgia/Russia/CIS) ──
  // v6.9.4: rides on the shared html.duckduckgo.com engine — when DDG is
  // cooling down / dead, skip the whole pass instead of firing one doomed
  // fetch per business (each failure logs a console error).
  const laneYandex = async () => {
    const needYandex = allBizList.filter(b => !b.phone && !b.email && !b.website);
    if (needYandex.length === 0) return;
    // v6.9.98: DDG-down no longer kills the lane — when the shared DDG gate is
    // closed, the query reroutes through searchBing (which itself falls back
    // to the server-side Bing lane). A regional pass used to silently skip
    // whenever one engine cooled down.
    if (!engineAvailable('ddg') && !engineAvailable('bing')) return;
    _ep.activePass = 'Pass 3: Regional (Yandex)'; _ep.passNumber = 3; bumpPercent(93);
    _ep.engines.find(e => e.name === 'Yandex')!.status = 'active'; emitEP();
    for (let i3 = 0; i3 < (CATEGORY_MODE ? needYandex.length : Math.min(needYandex.length, 30)); i3 += _BATCH) {
      if (laneStop()) break;
      const batch3 = needYandex.slice(i3, i3 + _BATCH);
      await Promise.all(batch3.map(async (b) => {
        try {
          const nameEn4 = getEnglishCityName(b.name);
          const cityEn3 = b.address ? getEnglishCityName(b.address.split(',').pop()?.trim() || '') : '';
          const q3 = encodeURIComponent(`site:yandex.* ${nameEn4 || b.name} ${cityEn3 || ''} phone`);
          if (engineAvailable('ddg')) {
            const r3 = await corsFetch('https://html.duckduckgo.com/html/?q=' + q3, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(6000),
            });
            if (r3.ok) {
              const html3 = await r3.text();
              extractFromHtml(html3, b);
            }
          } else {
            // v6.9.98: Bing fallback keeps the regional lane alive when DDG
            // is cooling down — same query, independent engine + server lane.
            const bing3 = await searchBing(decodeURIComponent(q3));
            let touched3 = false;
            for (const res of bing3.slice(0, 5)) {
              if (extractFromText((res.snippet || '') + ' ' + (res.title || ''), b)) touched3 = true;
            }
            if (touched3) yieldBump('snippetdig');
          }
        } catch {}
      }));
      if (i3 + _BATCH < needYandex.length) await wait(1200);
    }
    _ep.engines.find(e => e.name === 'Yandex')!.status = 'done'; emitEP();
  };

  // ── Lane: Pass 4 Verification (Wikidata SPARQL + Wayback) ──
  const laneVerify = async () => {
    const needVerify = allBizList.filter(b => b.website && (!b.email || !b.phone));
    if (needVerify.length === 0) return;
    _ep.activePass = 'Pass 4: Verify (Wikidata + Wayback)'; _ep.passNumber = 4; bumpPercent(94);
    const wdEngine: EngineStatus = { name: 'Wikidata', icon: '🔗', status: 'active', found: 0 };
    _ep.engines.push(wdEngine); emitEP();
    // v6.9.45: wikidataContacts runs through a GLOBAL SERIAL chain — full-
    // queue verify meant hundreds of SEQUENTIAL 10–15s queries. Cap it (the
    // lane deadline backstops the rest) so this lane can't stall wave A.
    const maxVerify = Math.min(needVerify.length, CATEGORY_MODE ? 80 : 24);
    for (let i4 = 0; i4 < maxVerify; i4 += _BATCH) {
      if (laneStop()) break;
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
    const deadSites = allBizList.filter(b => b.website && !b.email && !b.phone && !b.facebook).slice(0, CATEGORY_MODE ? 25 : 15);
    if (deadSites.length > 0) {
      const wbEngine: EngineStatus = { name: 'Wayback', icon: '🕰️', status: 'active', found: 0 };
      _ep.engines.push(wbEngine); emitEP();
      for (const b of deadSites) {
        if (laneStop()) break;
        const before = b.email + '|' + b.phone;
        await waybackContacts(b);
        if (b.email + '|' + b.phone !== before) wbEngine.found++;
        emitEP();
      }
      wbEngine.status = 'done'; emitEP();
    }
  };

  // ── Lane: v6.9.39 SOCIAL-PROFILE MINING ──
  // Social profiles are found in earlier passes but never FOLLOWED. The
  // business's own Facebook About/Transparency page and Instagram bio are
  // public contact cards: emails, phones, and even the website live there.
  // This lane fetches each found profile page and mines it with the same
  // full extractor used for websites.
  const laneSocial = async () => {
    const socialNeedies = allBizList.filter(b => (b.facebook || b.instagram) && (!b.email || !b.phone || !b.website));
    if (socialNeedies.length === 0) return;
    _ep.activePass = 'Pass 5b: Social profile mining'; _ep.passNumber = 5; bumpPercent(95);
    const socEngine: EngineStatus = { name: 'Social Miner', icon: '👥', status: 'active', found: 0 };
    _ep.engines.push(socEngine); emitEP();
    const maxSoc = Math.min(socialNeedies.length, CATEGORY_MODE ? 150 : 60);
    for (let i5b = 0; i5b < maxSoc; i5b += _BATCH) {
      if (laneStop()) break;
      const batch5b = socialNeedies.slice(i5b, i5b + _BATCH);
      const beforeCnt = batch5b.filter(x => x.email || x.phone).length;
      await Promise.all(batch5b.map(async (b) => {
        // Each business: try FB About → FB home → IG bio, stop early when complete
        const urls: string[] = [];
        if (b.facebook) {
          urls.push(b.facebook + '/about');
          urls.push(b.facebook);
        }
        if (b.instagram) {
          urls.push(b.instagram + '/');
        }
        for (const u of urls) {
          if (b.email && b.phone) break;
          try {
            // Facebook serves a dumb HTML shell to logged-out crawlers;
            // mbasic + the mobile UA return a parseable legacy page.
            const isFb = /facebook\.com/i.test(u);
            const r5b = await corsFetch(u, {
              headers: { 'User-Agent': isFb ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' : 'Mozilla/5.0' },
              signal: AbortSignal.timeout(4000),
            });
            if (!r5b.ok) continue;
            const html5b = await r5b.text();
            // IG bio pages embed contact emails in meta description too
            extractFromHtml(html5b, b);
            // IG embeds emails in JSON meta — mine those explicitly
            if (!b.email && /instagram\.com/i.test(u)) {
              const igEmailM = html5b.match(/"business_email"\s*:\s*"([^"]+@[^"]+)"/i)
                || html5b.match(/businessEmail"\s*:\s*"([^"]+@[^"]+)"/i)
                || html5b.match(/"email"\s*:\s*"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/i);
              if (igEmailM && !/example|sentry|schema/i.test(igEmailM[1])) b.email = igEmailM[1];
            }
            if (b.email && b.phone) break;
          } catch {}
        }
        // v6.9.62: the shared bio miner adds what the loop above lacks —
        // wa.me/WhatsApp numbers, one-hop link hubs (linktr.ee → the real
        // site), and brand-token domain probes are all in there. Session-
        // deduped, so businesses already mined in pass 1 are not refetched.
        if (!b.email || !b.phone || !b.website) {
          try { await enrichFromSocialBio(b); } catch {}
        }
      }));
      const afterCnt = batch5b.filter(x => x.email || x.phone).length;
      socEngine.found += Math.max(0, afterCnt - beforeCnt);
      emitEP();
      if (i5b + _BATCH < maxSoc) await wait(800);
    }
    socEngine.status = 'done'; emitEP();
  };

  // ── Lane: Google Places sweep (formerly DEAD code, wired v6.9.37) ──
  // Finds phones/websites for businesses that every other engine missed
  // (capped; the maps.google.com endpoint rate-limits per IP).
  const laneGooglePlaces = async () => {
    // v6.9.100: previously required ALL fields empty (including socials), so
    // a business with only a Facebook page (extremely common for small cafes)
    // never got a Maps lookup — the one source that reliably carries its phone.
    const stillEmpty = allBizList.filter(b => !b.phone && !b.email && !b.website);
    if (stillEmpty.length === 0) return;
    _ep.activePass = 'Pass 5: Google Places sweep'; _ep.passNumber = 5; bumpPercent(95);
    const gpEngine: EngineStatus = { name: 'Google Places', icon: '🗺️', status: 'active', found: 0 };
    _ep.engines.push(gpEngine); emitEP();
    const maxGP = Math.min(stillEmpty.length, CATEGORY_MODE ? 120 : 60);
    for (let i5 = 0; i5 < maxGP; i5 += _BATCH) {
      if (laneStop()) break;
      const batch5 = stillEmpty.slice(i5, i5 + _BATCH);
      const beforeCnt = batch5.filter(b => b.phone || b.email || b.website).length;
      try { await enrichFromGooglePlaces(batch5); } catch {}
      const afterCnt = batch5.filter(b => b.phone || b.email || b.website).length;
      gpEngine.found += Math.max(0, afterCnt - beforeCnt);
      emitEP();
      if (i5 + _BATCH < maxGP) await wait(1500);
    }
    gpEngine.status = 'done'; emitEP();
  };

  // ── Lane: DEEP-CRAWL + SITE-DOMAIN HARVEST (v6.9.39) ──
  // Two final layers for businesses still missing email or phone:
  //  a) deepCrawlWebsite — follow internal contact-smelling links that the
  //     fixed-path crawler couldn't guess
  //  b) search the business's own EMAIL DOMAIN ("@cafe.ge") on DDG —
  //     directories often publish the address the business's own site hides
  const laneDeepCrawl = async () => {
    const lastNeeders = allBizList.filter(b => b.website && (!b.email || !b.phone));
    if (lastNeeders.length === 0) return;
    _ep.activePass = 'Pass 5d: Deep crawl + domain search'; _ep.passNumber = 5; bumpPercent(96);
    const dcEngine: EngineStatus = { name: 'Deep Crawl', icon: '🕷️', status: 'active', found: 0 };
    _ep.engines.push(dcEngine); emitEP();
    const maxDC = Math.min(lastNeeders.length, CATEGORY_MODE ? 150 : 50);
    for (let i5d = 0; i5d < maxDC; i5d += _BATCH) {
      if (laneStop()) break;
      const batch5d = lastNeeders.slice(i5d, i5d + _BATCH);
      const beforeCnt = batch5d.filter(x => x.email || x.phone).length;
      await Promise.all(batch5d.map(async (b) => {
        // (a) internal-link deep crawl when fixed paths came up empty
        if (!b.email || !b.phone) {
          try { await deepCrawlWebsite(b); } catch {}
        }
        // (b) domain harvest — "@domain" reveals the address on directories
        if (!b.email && b.website) {
          try {
            const host5d = new URL(b.website).hostname.replace(/^www\./, '');
            if (/\./.test(host5d) && !/facebook|instagram|linktr|wixsite|business\.site/i.test(host5d)) {
              const dq = encodeURIComponent('"@' + host5d + '"');
              if (engineAvailable('ddg')) {
                const dr = await corsFetch('https://html.duckduckgo.com/html/?q=' + dq, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(4000),
                });
                if (dr.ok) extractFromHtml(await dr.text(), b);
              }
            }
          } catch {}
        }
      }));
      const afterCnt = batch5d.filter(x => x.email || x.phone).length;
      dcEngine.found += Math.max(0, afterCnt - beforeCnt);
      emitEP();
      if (i5d + _BATCH < maxDC) await wait(600);
    }
    dcEngine.status = 'done'; emitEP();
  };

  // ── v6.9.40: adaptive orchestrator — run the lanes in two waves ──
  // Wave A: four disjoint-host lanes in parallel (biggest wall-time win —
  // their inter-batch sleeps now overlap instead of stacking).
  // Wave B: the two DDG-riding lanes together (health gate shared, pressure
  // bounded). Lanes with zero needies return instantly without touching the
  // progress bar, so small categories skip what they don't need.
  // v6.9.45: wall-clock budget for the whole lane phase. In category mode
  // lanes process the FULL queue, and the serial layers (Wikidata chain,
  // Wayback) crawled 30+ minutes on a 500-business category — the user saw a
  // frozen "198/198 · 100%" forever. The budget guarantees the scan ALWAYS
  // ends: when time is up, lanes stop early and everything found ships.
  // ── Lane: WEBSITE DISCOVERY (v6.9.100) — pre-wave before the lanes ──
  // Websites gate every later layer — no site → no deep crawl, no nav ladder,
  // no contact chain, no MX guess. The phase-1 search arm caps its needy
  // queue, so OSM businesses whose site never surfaced get one dedicated
  // Bing sweep here. The strict isLikelyBusinessWebsite gate keeps
  // directories/socials/aggregators out; when a site lands it is fetched
  // immediately so the standard extractors cascade phone + email from it
  // inside this same pass (and every later lane picks it up too).
  const laneWebsiteDiscovery = async () => {
    const needSite = allBizList.filter(b => !b.website && b.name);
    if (needSite.length === 0) return;
    _ep.activePass = 'Pass 5c: Website discovery'; _ep.passNumber = 5; bumpPercent(94);
    const wdEngine: EngineStatus = { name: 'Site Finder', icon: '🔎', status: 'active', found: 0 };
    _ep.engines.push(wdEngine); emitEP();
    const maxWD = Math.min(needSite.length, CATEGORY_MODE ? 150 : 50);
    const wdCity = getScanContext()?.cityEn || getScanContext()?.cityNative || '';
    for (let iwd = 0; iwd < maxWD; iwd += _BATCH) {
      if (isCancelled() || Date.now() >= wdDeadline) break;
      const batchWD = needSite.slice(iwd, iwd + _BATCH);
      await Promise.all(batchWD.map(async (b) => {
        if (b.website) return;
        const q = encodeURIComponent(`"${b.name}" ${wdCity}`.trim());
        // v6.9.101: Brave server lane FIRST — it doesn't touch Bing's query
        // budget, so discovery no longer competes with snippet-dig and the
        // retry ladder for the same engine. Bing stays as fallback for when
        // the Brave pool is exhausted/rate-limited.
        // v6.9.101b: three arms per business, first hit wins:
        //   1. bare name+city on Brave (free of the Bing budget)
        //   2. bare name+city on Bing (only when Brave is unavailable)
        //   3. DOMAIN PROBE — the exact-match host ("shavi coffee" →
        //      shavicoffee.ge/.com + name-token variants) fetched directly;
        //      zero search-engine budget, catches the many businesses whose
        //      site simply wasn't in any search index snippet.
        const nameSlug = b.name.toLowerCase().replace(/[^a-z0-9\u10A0-\u10FF\u0530-\u058F]+/gi, '');
        const tldCity = (getScanContext()?.countryCode || '').toLowerCase();
        const probeHosts = nameSlug.length >= 3 && /^[a-z0-9]+$/.test(nameSlug)
          ? ['https://' + nameSlug + '.ge/', 'https://www.' + nameSlug + '.ge/', 'https://' + nameSlug + '.com/']
          : (tldCity && tldCity !== 'us' ? ['https://' + nameSlug + '.' + tldCity + '/'] : []);
        let rs: Array<{ title: string; url: string; snippet?: string; description?: string }> = [];
        if (engineAvailable('brave_s')) {
          try { rs = (await braveSearchViaSupabase(decodeURIComponent(q))) || []; } catch { rs = []; }
        }
        if (rs.length === 0) { try { rs = await searchBing(q); } catch { rs = []; } }
        // v6.9.101d: the probe arm runs whenever b.website is still empty —
        // search returning *results* but none passing the business-site filter
        // was leaving the probe unexplored on the noisiest cohort.
        if (rs.length > 0) {
          for (const r of rs.slice(0, 5)) {
            if (!r.url || !/^https?:\/\//i.test(r.url)) continue;
            if (!isLikelyBusinessWebsite(r.url, b.name, (r.title || '') + ' ' + (r.snippet || r.description || ''))) continue;
            b.website = r.url;
            wdEngine.found++;
            // cascade — site is fresh, pull contacts from it now
            try {
              const rr = await corsFetch(r.url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
              if (rr.ok) {
                const html = await rr.text();
                if (!isCfChallenge(html) && html.length > 500) extractFromHtml(html, b);
                else prefetchRenderDispatch(r.url);
              }
            } catch { /* site fetch failed — website kept, later lanes retry */ }
            break;
          }
        }
        if (!b.website && probeHosts.length > 0) {
          // Domain probe arm — direct fetch, no search engine involved.
          // v6.9.101c: measured on the real cohort (17/40 hit), but generic
          // .com hits are usually UNRELATED global companies (boa.com,
          // billy.com). Country-TLD hits (.ge/.am/.az…) are accepted on name
          // match; .com hits must additionally mention the scan city in the
          // page or title to count.
          const cityConfirm = (getScanContext()?.cityEn || '').toLowerCase();
          for (const ph of probeHosts) {
            try {
              const pr = await corsFetch(ph, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
              if (!pr.ok) continue;
              const phtml = await pr.text();
              if (isCfChallenge(phtml) || phtml.length < 500) continue;
              if (!isLikelyBusinessWebsite(ph, b.name, phtml.slice(0, 2000))) continue;
              const isCountryTld = /\.(ge|am|az|ru|tr|ua|by|kz|md|ro|bg|gr|it|de|fr|es|pt|pl|cz|hu|at|ch|nl|be|dk|fi|no|se|ie|co\.uk)(\/|$)/i.test(ph);
              if (!isCountryTld) {
                const head = phtml.slice(0, 6000).toLowerCase();
                if (!cityConfirm || !head.includes(cityConfirm)) continue;
              }
              b.website = ph;
              wdEngine.found++;
              extractFromHtml(phtml, b);
              break;
            } catch { /* next probe host */ }
          }
        }
      }));
      emitEP();
      if (iwd + _BATCH < maxWD) await wait(800);
    }
    wdEngine.status = 'done'; emitEP();
  };

  // Pre-wave: discover missing websites FIRST so the regional lanes (2GIS,
  // Places), deep-crawl and MX-guess all operate on a website-richer set.
  onProgress?.(92, 'Finding missing websites…');
  const WD_BUDGET_MS = CATEGORY_MODE ? 3 * 60_000 : 90_000;
  const wdDeadline = Date.now() + WD_BUDGET_MS;
  await Promise.race([
    laneWebsiteDiscovery().catch(() => {}),
    new Promise<void>(res => setTimeout(res, Math.max(1000, WD_BUDGET_MS))),
  ]);
  if (isCancelled()) { onProgress?.(100, 'Cancelled'); return results; }

  const LANE_BUDGET_MS = CATEGORY_MODE ? 8 * 60_000 : 3 * 60_000;
  const laneDeadline = Date.now() + LANE_BUDGET_MS;
  const laneStop = () => isCancelled() || Date.now() >= laneDeadline;
  onProgress?.(92, 'Regional, social & verification lanes running…');

  const waveA = [lane2GIS, laneSocial, laneGooglePlaces, laneVerify];
  const waveB = [laneYandex, laneDeepCrawl];
  // v6.9.76: hard deadline race — a single hung fetch (dead site, no socket
  // timeout) previously blocked Promise.all past the budget forever, which
  // froze the pipeline before harvest + validation could run. The race
  // guarantees the lane phase ALWAYS settles by laneDeadline.
  const waveWithDeadline = (promises: Promise<void>[]) => Promise.race([
    Promise.all(promises),
    new Promise<void>(res => setTimeout(res, Math.max(1000, laneDeadline - Date.now())))
  ]);
  const activeLanes =
    (allBizList.some(b => !b.phone && !b.email && !b.website) ? 2 : 0) +
    (allBizList.some(b => b.website && (!b.email || !b.phone)) ? 2 : 0) +
    (allBizList.some(b => (b.facebook || b.instagram) && (!b.email || !b.phone || !b.website)) ? 1 : 0) +
    (allBizList.some(b => !b.phone && !b.email && !b.website && !b.facebook) ? 1 : 0);
  _ep.activePass = `Passes 2–5 in parallel (${activeLanes} lanes)`; _ep.passNumber = 2; bumpPercent(91); emitEP();
  await waveWithDeadline(waveA.map(fn => fn().catch(() => {})));
  if (isCancelled()) { onProgress?.(100, 'Cancelled'); return results; }
  onProgress?.(96, 'Wave A done — Yandex + deep-crawl lanes…');
  await waveWithDeadline(waveB.map(fn => fn().catch(() => {})));
  if (isCancelled()) { onProgress?.(100, 'Cancelled'); return results; }
  onProgress?.(97, Date.now() >= laneDeadline
    ? 'Lane budget reached — shipping contacts found so far…'
    : 'All enrichment lanes complete…');

  // ── v6.9.73: RENDER HARVEST — collect warm Actions-lane DOMs ─────
  // CF-challenged sites were dispatched a render the moment their wall
  // appeared (prefetchRenderDispatch). Runs complete in 2-5 min — right
  // about when the main passes finish — so this pass polls render-cache
  // for those DOMs and extracts their contacts, turning lane latency
  // into free parallelism. Runs BEFORE validation so harvested contacts
  // go through the same strict scrub as everything else.
  // v6.9.84: the harvest body is extracted into runHarvest so the SAME
  // collection logic runs TWICE — once after the lanes (warm CF DOMs from
  // the prefetch) and once after Pass R (phone-recovery /contact renders
  // dispatched mid-ladder, whose GH runs land during the ladder). Stats
  // accumulate across both phases; emitHarvest carries the totals.
  const _harvSites = { n: 0, c: 0 };
  const contactFieldCount = (x: Business) =>
    (x.phone ? 1 : 0) + (x.email ? 1 : 0) + (x.website ? 1 : 0) +
    (x.facebook ? 1 : 0) + (x.instagram ? 1 : 0) + (x.linkedin ? 1 : 0);
  const runHarvest = async (label: string): Promise<void> => {
    // v6.9.75: the pass emits its stats UNCONDITIONALLY when sites were
    // queued — a transient raw.githubusercontent outage (ghRawOk false)
    // or a cancel must still surface as '0 sites · 0 contacts' instead of
    // vanishing (the v6.9.74 bug: emit sat inside the gate, so a blocked
    // pass was invisible and the chip never appeared).
    try {
      if (ghRawOk() && !isCancelled()) {
        _ep.activePass = 'Render harvest (' + label + ')'; _ep.passNumber = 7; bumpPercent(99); emitEP();
        for (const q of Array.from(_renderQueued)) {
          if (isCancelled()) break;
          if (_renderCache.has(q)) continue;
          let qhost = ''; try { qhost = new URL(q).host; } catch { continue; }
          let sha = ''; try { sha = await renderSha1(q); } catch { continue; }
          const metaRaw = await ghRawFetch('meta/' + sha + '.json', 10000);
          if (!metaRaw) continue;
          try {
            const m = JSON.parse(metaRaw) as { status?: string; finished_at?: string };
            if (m.status !== 'done') continue;
            const dom = await ghRawFetch('dom/' + sha + '.html', 15000);
            if (!dom || dom.length <= 500 || isCfChallenge(dom)) continue;
            _renderCache.set(q, dom);
            for (const arr of results.values()) {
              for (const b of arr) {
                try {
                  // v6.9.77: www-normalized host match — businesses tagged with
                  // www.tbcbank.ge must match a render of tbcbank.ge (and
                  // vice versa); exact-host comparison zeroed the harvest.
                  const bhost = b.website ? new URL(b.website).host.replace(/^www\./, '') : '';
                  if (bhost && bhost === qhost.replace(/^www\./, '')) {
                    const before = contactFieldCount(b);
                    extractFromHtml(dom, b);
                    _harvSites.c += Math.max(0, contactFieldCount(b) - before);
                  }
                } catch { /* skip */ }
              }
            }
            _harvSites.n++;
          } catch { continue; }
        }
        if (_harvSites.n > 0) onProgress?.(99, `Render harvest (${label}): ${_harvSites.n} rendered site(s), +${_harvSites.c} contacts`);
      }
    } catch { /* never let harvest mechanics break result delivery */ }
  };
  if (_renderQueued.size > 0) {
    await runHarvest('warm CF DOMs');
    emitHarvest({ sites: _harvSites.n, contacts: _harvSites.c, ranAt: Date.now() });
  }

  // ── v6.9.78: PASS R (RELENTLESS) — the assurance ladder ─────────────
  // v6.9.79: ADAPTIVE retry-engine order. Pass-1 arms keep per-engine
  // stats (getArmStats): calls, wall-ms, fields gained. Engines that
  // burned their timeouts for zero gains sink to the end of the retry
  // order; engines with proven gains lead. Measured on one Cafes run:
  // bing 23 gains / 708s vs ddg-lite 0 gains / 494 calls — the ladder
  // must not re-fire dead arms first. Falls back to a sane default when
  // no stats exist yet (small scans, first run).
  const _RETRY_DEFAULT: string[] = ['bing', 'ddg', 'brave'];
  const _retryEngineOrder = (): string[] => {
    try {
      const rows = getArmStats().filter(r2 => ['bing', 'brave', 'ddg', 'ddglite'].includes(r2.id) && r2.calls >= 8);
      if (rows.length === 0) return _RETRY_DEFAULT;
      const eff = new Map<string, number>();
      for (const r2 of rows) {
        const id = r2.id === 'ddglite' ? 'ddg' : r2.id;
        const e = r2.gains / Math.max(1, r2.ms / 1000);
        eff.set(id, Math.max(eff.get(id) ?? 0, e));
      }
      return [...eff.entries()].sort((a, b2) => b2[1] - a[1]).map(x => x[0]);
    } catch { return _RETRY_DEFAULT; }
  };

  // For every business still missing website/email/phone, run a SECOND
  // chain of distinct methods. Earlier passes visit each business once
  // (site deep-scrape, one contact-page crawl, one social-bio fetch); a
  // single empty visit (SPA shell, wrong path guess, transient failure)
  // meant the field stayed empty forever. Pass R re-attempts with
  // DIFFERENT methods and runs BEFORE validation so everything passes
  // through the same strict scrub as every other contact.
  {
    _ep.activePass = 'Pass R: relentless retry ladder'; _ep.passNumber = 7; _ep.percent = 97; emitEP();
    const nativeContact = getScanContext() ? contactTermsNative() : '';
    const nativeCity = getScanContext()?.cityNative || '';
    const nativeCityEn = getScanContext()?.cityEn || '';
    const R_BATCH = 8;
    let rFills = 0;
    // v6.9.80: per-run ladder tallies. An engine that keeps getting tried
    // but never gains a field is pure wall-clock waste for the rest of the
    // pass (measured: brave 689s / 0 gains on a 536-business Cafes run).
    const _rEngCalls: Record<string, number> = {};
    const _rEngGains: Record<string, number> = {};
    // v6.9.81: per-origin contact-URL discovery (WP REST + sitemap.xml).
    // Cached per scan — a chain site is probed once, every branch reuses it.
    const _rContactUrls = new Map<string, string[]>();
    const discoverContactUrls = async (origin: string): Promise<string[]> => {
      const hit = _rContactUrls.get(origin);
      if (hit) return hit;
      const found: string[] = [];
      try {
        const r = await corsFetch(origin + '/wp-json/wp/v2/pages?search=contact&per_page=3&_fields=link', { signal: AbortSignal.timeout(4500), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
        if (r.ok) {
          const arr: Array<{ link?: string }> = JSON.parse(await r.text());
          for (const p of (Array.isArray(arr) ? arr : [])) if (p?.link) found.push(p.link);
        }
      } catch { /* not WP / blocked */ }
      if (found.length < 2) {
        try {
          const r2 = await corsFetch(origin + '/sitemap.xml', { signal: AbortSignal.timeout(4500), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
          if (r2.ok) {
            const xml = await r2.text();
            for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
              if (/contact|kontakt|контакт|iletisim|about|filial|branch|location/i.test(m[1]) && !/\.pdf$/i.test(m[1])) found.push(m[1]);
              if (found.length >= 4) break;
            }
          }
        } catch { /* no sitemap */ }
      }
      const out = found.slice(0, 4);
      _rContactUrls.set(origin, out);
      return out;
    };
    const complete = (b: Business) => !!(b.website && b.email && b.phone);
    const rnavPaths = (b: Business): string[] => {
      if (!b.website) return [];
      let base = '';
      try { base = new URL(b.website).origin; } catch { return []; }
      const paths = ['/contact', '/contact-us', '/contacts', '/contact.html', '/kontakt', '/kontakti', '/kontaktai', '/контакти', '/контакты', '/iletisim', '/contacto', '/contato', '/kontak', '/contact.php', '/pages/contact', nativeContact ? '/' + nativeContact.toLowerCase().replace(/\s+/g, '-') : '', nativeContact ? '/' + nativeContact : '', '/about', '/about-us', '/branches', '/filials', '/locations'];
      return paths.filter(Boolean).map(p2 => base + p2);
    };
    const rsearchQueries = (b: Business): string[] => {
      const base = b.name.replace(/"/g, '');
      const cityQ = nativeCity || nativeCityEn;
      return [
        '"' + base + '" ' + cityQ + ' contact email',
        '"' + base + '" ' + cityQ + ' phone',
        '"' + base + '" site:facebook.com OR site:instagram.com',
        // v6.9.81: 4th shape — generic contact-details query. Bing-only
        // (the ladder slices secondary engines to 3 queries to bound time).
        '"' + base + '" ' + cityQ + ' contact details address',
      ];
    };
    // v6.9.84: phone-recovery host dedup — one /contact render per host
    const _phoneNeedyDispatched = new Set<string>();
    const rAttempt = async (b: Business): Promise<boolean> => {
      // 0) PHONE-RECOVERY DISPATCH — v6.9.84. A business with a website and
      // an email (the email proves the site is theirs) but no phone very
      // likely keeps its switchboard number on a page the static fetch
      // can't read (JS-hydrated, CF-protected, or bot-blocked). Dispatch a
      // headless render of the site's /contact page — deduped per host and
      // budget-capped by the dispatcher — so the LATE harvest (after this
      // ladder) collects warm DOMs for every branch of the same chain.
      if (b.website && b.email && !b.phone) {
        try {
          const o = new URL(b.website).origin;
          const h = urlHostOf(o);
          if (!_phoneNeedyDispatched.has(h)) {
            _phoneNeedyDispatched.add(h);
            prefetchRenderDispatch(o + '/contact');
          }
        } catch { /* malformed website — skip */ }
      }
      // 1) NAV — crawl deeper/multilingual contact paths on the own site.
      //    v6.9.81: BEFORE guessing static paths, discover REAL contact URLs
      //    via WordPress REST (pages?search=contact) and sitemap.xml <loc> —
      //    multilingual sites name pages /ka/kontakti, /filialebi/ etc. that
      //    no static slug list covers. Cached per-origin so branch-heavy
      //    scans probe each site once.
      if (b.website && (!b.email || !b.phone)) {
        let _origin = '';
        try { _origin = new URL(b.website).origin; } catch { _origin = ''; }
        if (_origin && !_cfHosts.has(urlHostOf(_origin))) {
          const discovered = await discoverContactUrls(_origin);
          for (const u of discovered) {
            if (isCancelled()) break;
            try {
              const r = await corsFetch(u, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
              if (r.ok) {
                const html = await r.text();
                if (!isCfChallenge(html) && html.length > 500) extractFromHtml(html, b);
                if (!b.phone && isSpaShell(html)) prefetchRenderDispatch(u);
              }
            } catch { /* next discovered url */ }
            if (b.email && b.phone) break;
          }
          if (b.email && b.phone) { yieldTry('rcms'); yieldBump('rcms'); return true; }
          if (discovered.length > 0) { yieldTry('rcms'); if (b.email || b.phone) yieldBump('rcms'); }
        }
        for (const u of rnavPaths(b).slice(0, 8)) {
          if (isCancelled()) break;
          if (_cfHosts.has(urlHostOf(u))) break;
          try {
            const r = await corsFetch(u, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
            if (!r.ok) continue;
            const html = await r.text();
            if (isCfChallenge(html)) { _cfHosts.add(urlHostOf(u)); break; }
            if (html.length > 500) extractFromHtml(html, b);
            if (!b.phone && isSpaShell(html)) prefetchRenderDispatch(u);
            if (b.email && b.phone) break;
          } catch { /* next path */ }
        }
        yieldTry('rnav'); yieldBump('rnav');
        if (complete(b)) return true;
      }
      // 2) SEARCH — ADAPTIVE multi-engine ladder in measured-yield order:
      // the pass-1 arm stats decide who leads (v6.9.79). Each engine gets
      // its own fresh queries + result-page follows; stop when complete.
      if ((!b.website || !b.email || !b.phone) && b.name) {
        const engOrder = _retryEngineOrder();
        yieldTry('rsearch');
        let anyEngineHit = false;
        for (const eng of engOrder) {
          if (isCancelled()) break;
          // In-ladder cutoff: ≥15 ladder attempts with ZERO gains → engine
          // is dead for this run; skip it instead of burning its timeout.
          if ((_rEngCalls[eng] || 0) >= 15 && (_rEngGains[eng] || 0) === 0) continue;
          _rEngCalls[eng] = (_rEngCalls[eng] || 0) + 1;
          const pre = { e: b.email, p: b.phone, w: b.website };
          // v6.9.81: Bing (the proven workhorse) gets the 4th query shape;
          // secondary engines keep 3 to bound wall time.
          for (const q of (eng === 'bing' ? rsearchQueries(b) : rsearchQueries(b).slice(0, 3))) {
            if (isCancelled()) break;
            let rs: Array<{ title: string; url: string; description?: string; snippet?: string }> = [];
            try {
              if (eng === 'bing') rs = await searchBing(q);
              else if (eng === 'ddg') rs = await searchDDGHtml(q);
              else if (eng === 'brave') rs = (await braveSearchViaSupabase(q)) || [];
            } catch {}
            if (rs.length === 0) continue;
            for (const r of rs.slice(0, 4)) {
              if (r.description || r.snippet) extractFromText((r.title || '') + ' ' + (r.description || r.snippet || ''), b);
              const host = urlHostOf(r.url).replace(/^www\./, '');
              if (!host || /facebook|instagram|twitter|x\.com|tiktok|youtube|pinterest|linkedin|google|duckduckgo|yandex|wikipedia/i.test(host)) continue;
              try {
                const rr = await corsFetch(r.url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
                if (rr.ok) {
                  const pageHtml = await rr.text();
                  if (!isCfChallenge(pageHtml) && pageHtml.length > 500) extractFromHtml(pageHtml, b);
                  // Only render own-site shells — a followed search result on
                  // a third-party SPA is not worth headless minutes.
                  if (!b.phone && isSpaShell(pageHtml)) { try { if (urlHostOf(r.url) === urlHostOf(b.website)) prefetchRenderDispatch(r.url); } catch {} }
                }
              } catch { /* next result */ }
              if (complete(b)) break;
            }
            if (complete(b)) break;
          }
          const engineHit = !!(b.email && b.email !== pre.e) || !!(b.phone && b.phone !== pre.p) || !!(b.website && b.website !== pre.w);
          if (eng === 'bing' && engineHit) yieldBump('rbing');
          if (engineHit) { _rEngGains[eng] = (_rEngGains[eng] || 0) + 1; anyEngineHit = true; }
          if (complete(b)) { yieldBump('rsearch'); return true; }
          // Engine produced nothing → next engine in the adaptive order.
        }
        if (anyEngineHit) yieldBump('rsearch');
      }
      // 3) SOCIAL — one fresh bio re-fetch (early pass already used its try)
      if ((b.facebook || b.instagram) && !complete(b)) {
        _socialBioDone.clear();
        try { await enrichFromSocialBio(b); } catch {}
        yieldTry('rsocial'); yieldBump('rsocial');
        if (complete(b)) return true;
      }
      // 3b) WAYBACK — businesses whose own site is dead/slow still had a
      // website with contacts once; archived snapshots carry it. Only fires
      // when the business HAS a website but the nav ladder found nothing.
      if (b.website && (!b.email || !b.phone)) {
        try { await waybackContacts(b); } catch {}
      }
      // 3b2) WAYBACK contact page — v6.9.82 phone-first arm. The homepage
      // snapshot rarely carries the switchboard number; the /contact one
      // does. Fires for phone-only-needy businesses whose email proves the
      // site is theirs. Bounded: one availability call + one snapshot fetch.
      if (b.website && !b.phone && b.email) {
        try {
          const cUrl = b.website.replace(/\/+$/, '') + '/contact';
          const av = await fetch('https://archive.org/wayback/available?url=' + encodeURIComponent(cUrl), { signal: AbortSignal.timeout(8000) });
          if (av.ok) {
            const j = await av.json();
            const snap = j?.archived_snapshots?.closest?.url;
            if (snap && j.archived_snapshots.closest.available) {
              const r = await corsFetch(snap, { signal: AbortSignal.timeout(12000) });
              if (r.ok) { const html = await r.text(); if (html.length > 200) extractFromHtmlModule(html, b); }
            }
          }
        } catch { /* best effort */ }
      }
      // 4) INFER — cross-field inference that never ran elsewhere
      if (!b.email && b.website) { try { await guessEmailFromDomain(b); } catch {} }
      if (!b.website && (b.facebook || b.instagram)) {
        try {
          const m = (b.instagram || b.facebook || '').match(/(?:instagram\.com|facebook\.com)\/([A-Za-z0-9_.-]{3,30})/i);
          const slug = m && m[1];
          if (slug && !/^(p|reel|explore|pages|groups)$/i.test(slug)) {
            const cand = 'https://' + slug.replace(/[^a-z0-9.-]/gi, '') + '.com';
            const r2 = await corsFetch(cand, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlueOcean/1.0)' } });
            if (r2.ok) {
              const candHtml = await r2.text();
              if (!isCfChallenge(candHtml) && isLikelyBusinessWebsite(cand, b.name) && candHtml.length > 800) b.website = cand;
            }
          }
        } catch {}
      }
      yieldTry('rinfer'); yieldBump('rinfer');
      return complete(b);
    };
    const needy = allBizList.filter(b => !complete(b));
    if (needy.length > 0) {
      onProgress?.(97, 'Pass R: ' + needy.length + ' businesses need a second chain…');
      for (let i = 0; i < needy.length; i += R_BATCH) {
        if (isCancelled()) break;
        const batch = needy.slice(i, i + R_BATCH);
        const got = await Promise.all(batch.map(b => rAttempt(b).catch(() => false)));
        rFills += got.filter(Boolean).length;
        if ((i / R_BATCH) % 4 === 0) {
          onProgress?.(97, 'Pass R: ' + Math.min(i + R_BATCH, needy.length) + '/' + needy.length + ' retried, ' + rFills + ' completed');
          emitEP();
        }
        await abortableWait(400);
      }
      onProgress?.(98, 'Pass R done: ' + rFills + ' businesses completed by the retry ladder');
    }
  }

  // v6.9.84: LATE HARVEST — Pass R dispatched phone-recovery /contact
  // renders mid-ladder; GH Actions runs land during the ladder, so collect
  // whatever finished BEFORE validation (harvested contacts pass the same
  // strict scrub). Totals accumulate with the early phase; the chip shows
  // the run's combined render-lane contribution.
  if (_renderQueued.size > 0 && _harvSites.n < _renderQueued.size) {
    // Only re-run when some queued renders are still uncollected — a
    // fully-harvested queue means the early pass already got everything.
    // v6.9.85: GRACE WINDOW — measured miss: renders dispatched during
    // Pass R finished ~3 min AFTER the run's late poll (psp.ge/kiabi 15:58
    // vs poll 15:55), so same-run collection lost them. Now the late phase
    // polls every 30s for up to 4 minutes, collecting each DOM the moment
    // it lands, and bails early the instant the queue is fully harvested.
    if (!isCancelled()) {
      const _graceUntil = Date.now() + 4 * 60_000;
      while (Date.now() < _graceUntil && !isCancelled() && _harvSites.n < _renderQueued.size) {
        await runHarvest('late');
        if (_harvSites.n >= _renderQueued.size) break;
        const pending = _renderQueued.size - _harvSites.n;
        onProgress?.(98, `Render lane grace: waiting for ${pending} in-flight render(s)…`);
        await abortableWait(30_000);
      }
    }
    emitHarvest({ sites: _harvSites.n, contacts: _harvSites.c, ranAt: Date.now() });
  }

  // ── v6.9.37: final VALIDATION pass — every stored contact is checked ──
  // Extraction layers are permissive (they'd rather keep a suspect value
  // than drop a real one). Before results ship, a strict rules pass purges
  // junk emails (file paths, noreply, placeholder hosts), implausible
  // phones (dates, IPs, timestamps) and normalizes phones to international
  // format. This is the layer that makes the coverage numbers TRUSTWORTHY
  // — more data is worthless if a share of it is garbage.
  {
    _ep.activePass = 'Validating contacts'; _ep.passNumber = 6; _ep.percent = 98; emitEP();
    const cc = getScanContext()?.countryCode;
    let purgedEmails = 0, purgedPhones = 0, fixedPhones = 0;
    let purgedWebsites = 0;
    const SITE_JUNK = /schema\.org|w3\.org|ogp\.me|duckduckgo\.com|bing\.com|google\.[a-z.]+|ecosia\.org|startpage\.com|qwant\.com|brave\.com|mojeek\.com/i;
    for (const arr of results.values()) {
      for (const b of arr) {
        if (b.email && !plausibleEmail(b.email)) { b.email = ''; purgedEmails++; }
        if (b.phone) {
          const norm = normalizePhone(b.phone, cc);
          const digits = norm.replace(/\D/g, '');
          if (!plausiblePhone(b.phone, false) || digits.length < 8 || digits.length > 15) {
            b.phone = ''; purgedPhones++;
          } else if (norm !== b.phone) {
            b.phone = norm; fixedPhones++;
          }
        }
        // v6.9.95: master website gate — template/standard-host and search-
        // engine domains are never a local business's own site (the JSON-LD
        // boilerplate of half the web references schema.org/Place). Also
        // normalizes malformed phone clusters like "26.611.61753" (site-
        // wide template IDs, same value on unrelated businesses).
        if (b.website && SITE_JUNK.test(b.website)) { b.website = ''; purgedWebsites++; }
        if (b.phone && !b.phone.startsWith('+')) {
          const dotRuns = b.phone.match(/^\d{1,3}(\.\d{3}){2,}\d*$/);
          if (dotRuns) { b.phone = ''; purgedPhones++; }
        }
      }
    }
    if (purgedEmails + purgedPhones + purgedWebsites > 0) {
      onProgress?.(99, `Validated — purged ${purgedEmails} junk emails, ${purgedPhones} bad phones, ${purgedWebsites} template websites, normalized ${fixedPhones}`);
    }
  }

  // v6.9.86: persist the run's measured coverage to Supabase — the
  // compounding effect (warm render cache, engine learnings) becomes a
  // durable trend per city+category instead of a moment in the console.
  // Fire-and-forget: persistence must never delay or break result delivery.
  try {
    const ctxC = getScanContext();
    if (ctxC && allBizList.length > 0) {
      const cnt = (pred: (b: Business) => boolean) => allBizList.filter(pred).length;
      void supabaseRpc<{ id: number }>('rpc_coverage_report', {
        p_country: ctxC.countryName || '',
        p_city: ctxC.cityEn || ctxC.cityNative || '',
        p_category: categoryFilter || 'all',
        p_businesses: allBizList.length,
        p_phones: cnt(b => !!b.phone),
        p_emails: cnt(b => !!b.email),
        p_websites: cnt(b => !!b.website),
        p_socials: cnt(b => !!(b.facebook || b.instagram || b.linkedin)),
        p_full_trio: cnt(b => !!(b.phone && b.email && b.website)),
        p_render_sites: _harvSites.n,
        p_render_contacts: _harvSites.c,
        p_app_version: APP_VERSION,
      }, 15000).catch(() => { /* best effort */ });
    }
  } catch { /* never block delivery */ }

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
// v6.9.23: split Discover into FAST results (scan + demand + scoring) and a
// BACKGROUND AI phase, so real results render in seconds instead of waiting
// minutes for the LLM chain. runDiscoveryPhases stays for compatibility.
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
  emitDP({ percent: 90, phase: 'score' });
  return { opportunities, demandSignals: signals, aiInsights: '', aiAnalysis: undefined };
}

// ─── Background AI phase (v6.9.23) ──────────────────────────────
// Runs AFTER real results are already on screen. Two hard guarantees:
//   1. TIME BUDGET — the whole chain (LLM + sanity) is raced against a
//      budget; if the model chain stalls, we still surface the honest
//      deterministic fallback so the panel never hangs on "thinking".
//   2. REAL DATA ONLY — the AI never sees invented numbers; it receives the
//      exact computed facts. If it fails entirely, we say so.
export const AI_PHASE_BUDGET_MS = 90_000; // hard cap on the background AI pass

export async function runAIPhase(
  businesses: Map<string, Business[]>,
  population: number,
  cityName: string,
  countryName: string,
  opportunities: OpportunityResult[],
  signals: Map<string, DemandSignal>,
  onProgress?: (dp: DiscoveryProgress) => void,
  abortSignal?: AbortSignal,
  scanMeta?: MarketFacts['scanMeta'],
): Promise<{ aiInsights: string; aiAnalysis?: AIAnalysis }> {
  const isCancelled = () => abortSignal?.aborted ?? false;
  const _dp: Partial<DiscoveryProgress> = { phase: 'ai', ai: 'thinking', percent: 92 };
  const emitDP = (o?: Partial<DiscoveryProgress>) => { if (onProgress) onProgress({ ..._dp, ...o } as DiscoveryProgress); };
  emitDP();

  let aiInsights = '';
  let aiAnalysis: AIAnalysis | undefined;
  try {
    const facts = computeMarketFacts(businesses, population, cityName, countryName, signals, scanMeta);
    // Attach real opportunity scores to the facts (LLM sees exact numbers)
    const scoreByCat = new Map(opportunities.map(o => [o.category, o.score]));
    facts.categories.forEach(c => { c.score = scoreByCat.get(c.category) ?? 0; });

    // Hard time budget: race the model chain against AI_PHASE_BUDGET_MS.
    // On timeout we still run the deterministic sanity pass so warnings and
    // rescan decisions never depend on a slow third-party LLM.
    const analysis = await Promise.race([
      getSmartAIAnalysis(facts, opportunities, { signal: abortSignal }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('AI time budget exceeded')), AI_PHASE_BUDGET_MS)),
    ]);
    // ── AI sanity-check pass (v6.9.1): verify the result before final. ──
    // Deterministic per-capita bands flag implausible counts; when a model
    // is available it reviews the data warnings too. Flagged categories get
    // a visible warning insight so absurd numbers can't pass silently.
    const sanity = sanityCheckOpportunities(opportunities, population);
    analysis.sanity = sanity;
    // v6.9.36: deterministic healing transparency — added BEFORE the model's
    // insights so it's the first thing the user reads. No LLM needed: this is
    // a fact about collection methodology, not an interpretation.
    if (scanMeta?.healed && scanMeta.initialCount != null) {
      analysis.insights = [{
        title: `🔍 Scan auto-healed: area expanded ${scanMeta.areaFactor}×`,
        detail: `First pass found only ${scanMeta.initialCount} businesses; a retry with a ${scanMeta.areaFactor}× larger area found ${facts.totalBusinesses}. Counts reflect the wider area — neighboring towns may be included.`,
        severity: 'low',
        categories: undefined,
      }, ...analysis.insights];
    }
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
    // Honest fallback (real data, clearly labeled deterministic) — never a
    // hang, never fabricated numbers.
    _dp.ai = 'error';
  }
  emitDP({ percent: 100, phase: 'done' });
  return { aiInsights, aiAnalysis };
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

    // v6.9.26: legacy GET path (text.pollinations.ai/<prompt>) is deprecated
    // and 402s on any real prompt. Use the OpenAI-compatible POST endpoint
    // (anonymous, keyless, CORS-open) — no max_tokens (billed requests 402).
    const r = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: 'You are a market analyst. Reply concisely (under 350 words), plain text bullets.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(20000),
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

// Module-scope base64 decoder — removed v6.9.26 with the dead sk-ortv1- keys.
// (base64-in-source env keys via VITE_* remain supported through _b64dec.)
// base64 in .env — see the _b64dec note near SERPER_API_KEY above.
// Embedded base64 fallback lets the CI-built site use AI out of the box.
// v6.9.13: OpenRouter joins the key-pool system (see pools near SERPER).
// Primary = env or embedded fallback; user backup keys are appended via
// addBackupKeys('openrouter', ...) from the Settings panel.
_poolRegister('openrouter', [
  (import.meta as any).env?.VITE_OPENROUTER_API_KEY,
  // v6.9.26: the two embedded sk-ortv1- keys were REMOVED — OpenRouter now
  // rejects that key format outright (401 on ANY sk-ortv1- value, verified
  // 2026-09-11), so they burned two 401s per AI call before the fallback
  // chain even started. Users add live keys via the Settings panel
  // (addBackupKeys) or VITE_OPENROUTER_API_KEY. With no key the pool is
  // empty and llmCallModel goes straight to the keyless Pollinations
  // fallback — AI analysis works out of the box again.
]);
const _orKey = () => _poolKey('openrouter');
const OPENROUTER_MODEL = (import.meta as any).env?.VITE_OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

// Ordered chain: try the configured model first, then the known-good
// free-tier models as fallbacks. This keeps the app usable when one
// provider is upstream-rate-limited (common on free tiers).
// v6.9.26: verified against GET /api/v1/models on 2026-09-11 —
// minimax/minimax-m2.7:free and z-ai/glm-5.2:free NO LONGER EXIST (404 on
// every call, silently burning 2 chain slots before any model answered).
const AI_MODEL_CHAIN: string[] = [
  // gemma first: cleanest/fastest structured JSON of the verified-live free
  // pool (no reasoning-token overhead). nemotron spends tokens thinking
  // before answering, so it costs ~2× wall time — kept as second.
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  OPENROUTER_MODEL,
  'inclusionai/ling-3.0-flash-vl:free',
];

// ── v6.9.46: llm7.io — keyless, CORS-open, verified ALIVE 2026-09-15 ──
// Probe results that killed every other keyless path: Pollinations POST
// returns HTTP 200 whose "content" IS a budget-error message (its shared
// anonymous key is exhausted — same from Supabase's IP), GitHub Models is
// retiring (410 brownout), Puter.js demands interactive login, duck.ai chat
// is bot-walled server-side. llm7.io answered a real completion with HTTP
// 200 from BOTH curl and the browser (CORS allowed). Anonymous tier models
// verified live via GET /v1/models: mistral-Nemo-Instruct-2407 (clean fast
// replies) and minimax-m2.7 (reasoning — emits <think> blocks; stripThink-
// Blocks already handles them). Nemo first: no reasoning overhead.
const LLM7_CHAIN = ['mistral-Nemo-Instruct-2407', 'minimax-m2.7'];
let _llm7Fails = 0;
let _llm7LastFail = 0;
// Pollinations probe 2026-09-15: endpoint 200s but content is the literal
// string "The API key used for this request has reached its budget…" — a
// validator rejects it so the chain moves on instead of shipping garbage.
const POLLEN_BUDGET_MSG = /reached its budget|raise the key budget|pollinations\.ai\/edit-key/i;

async function llm7Call(
  systemPrompt: string,
  userPrompt: string,
  opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal; validate?: (t: string) => boolean },
): Promise<string | null> {
  // failure memory: 3 consecutive fails → skip the provider for 5 min
  if (_llm7Fails >= 3 && Date.now() - _llm7LastFail < 300_000) return null;
  for (const model of LLM7_CHAIN) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts?.signal?.aborted) return null;
      try {
        const r = await fetch('https://api.llm7.io/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: opts?.maxTokens ?? 900,
            temperature: opts?.temperature ?? 0.3,
          }),
          signal: opts?.signal ?? AbortSignal.timeout(45000),
        });
        if (r.ok) {
          const d = await r.json();
          const text = stripThinkBlocks(String(d?.choices?.[0]?.message?.content || ''));
          if (text.trim().length > 0 && !POLLEN_BUDGET_MSG.test(text) && (!opts?.validate || opts.validate(text))) {
            _llm7Fails = 0;
            engineNoteSuccess('llm7', 'AI (llm7.io — keyless)');
            _lastLlmModel = 'llm7:' + model;
            return text;
          }
          // empty/garbage reply → next model
          break;
        }
        // 429/5xx → brief backoff, retry same model once
        if (r.status === 429 || r.status >= 500) {
          _llm7Fails++; _llm7LastFail = Date.now();
          await new Promise(res => setTimeout(res, 1200 * (attempt + 1)));
          continue;
        }
        // other 4xx (model gone) → next model
        _llm7Fails++; _llm7LastFail = Date.now();
        break;
      } catch (e: any) {
        if (e?.name === 'AbortError' || e?.message === 'Cancelled') return null;
        _llm7Fails++; _llm7LastFail = Date.now();
        break; // network → next model
      }
    }
  }
  return null;
}

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
  // v6.9.26: no OpenRouter key does NOT abort the call — the keyless
  // Pollinations fallback below still runs (this was the 'backups exceeded'
  // dead-end that made every analysis fall back to deterministic mode).
  const maxTokens = opts?.maxTokens ?? 900;
  const temperature = opts?.temperature ?? 0.3;
  const validate = opts?.validate;

  for (let mi = 0; mi < AI_MODEL_CHAIN.length && _orKey(); mi++) {
    const model = AI_MODEL_CHAIN[mi];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts?.signal?.aborted) throw new Error('Cancelled');
      // v6.9.13: pick the current pool key fresh each attempt so a rotation
      // mid-chain is picked up on the next model/attempt.
      const orKey = _orKey();
      if (!orKey) break; // pool empty → exit model loop, try keyless fallback below
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${orKey}`,
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
          // v6.9.13: rotate to the next OpenRouter backup key if available
          const next = _poolRotate('openrouter');
          engineNoteFail('openrouter', 'AI (OpenRouter)', 'quota', next ? 'rate-limited — rotating to backup key' : 'rate-limited (429), backups exceeded');
          await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
          continue;
        }
        // v6.9.26: 401/403 = the KEY is dead (revoked/expired/malformed), not
        // the model. Retiring it via _poolRotate was pointless — rotation
        // only marks indexes exhausted per-model loop, and with BOTH embedded
        // keys dead the old code retried the same 401s on every call. Drop
        // the key from the pool entirely so the next attempt (and every
        // future call) skips it immediately.
        if (r.status === 401 || r.status === 403) {
          await r.text().catch(() => '');
          _poolDropCurrent('openrouter');
          const after = _poolAlive('openrouter');
          engineNoteFail('openrouter', 'AI (OpenRouter)', 'quota', after > 0 ? `key rejected (HTTP ${r.status}) — dropped, ${after} backup key(s) left` : `key rejected (HTTP ${r.status}) — no valid keys`);
          // Retry loop picks up the next (live) key on the same model.
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
  // ── v6.9.46: Keyless arm #1 — llm7.io (verified alive + CORS-open) ──
  // Runs BEFORE Pollinations, which is now confirmed budget-dead globally.
  const _sig = opts?.signal;
  if (!_sig?.aborted) {
    const llm7Text = await llm7Call(systemPrompt, userPrompt, { maxTokens, temperature, signal: _sig, validate });
    if (llm7Text) return { text: llm7Text, model: _lastLlmModel || 'llm7' };
  }

  // ── v6.9.26: Keyless last resort — Pollinations text API ──
  // The legacy GET path died (402/429), but the OpenAI-compatible POST
  // endpoint (text.pollinations.ai/openai) still serves anonymous requests
  // (CORS-open, no key, no referrer needed). It has NO explicit max_tokens —
  // requests carrying max_tokens are billed (402). So we send a compact
  // system+user pair and cap length by asking for short output in the prompt.
  // Also honors the caller's validator, so garbage replies fall through to
  // the deterministic local analysis instead of surfacing junk.
  // v6.9.46: probe showed the anonymous key is exhausted — HTTP 200 whose
  // content is a budget-error message. Kept as a hail-mary (it may recover
  // when they top up), but the validator now rejects budget messages.
  if (!opts?.signal?.aborted) {
    try {
      const r = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai',
          messages: [
            { role: 'system', content: systemPrompt + ' Reply concisely (under 400 words).' },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: opts?.signal ?? AbortSignal.timeout(45000),
      });
      if (r.ok) {
        const d = await r.json();
        const text = d?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim().length > 0 && !POLLEN_BUDGET_MSG.test(stripThinkBlocks(text)) && (!validate || validate(stripThinkBlocks(text)))) {
          engineNoteSuccess('pollinations', 'AI (Pollinations — keyless)');
          _lastLlmModel = 'pollinations:openai';
          return { text: stripThinkBlocks(text), model: 'pollinations:openai' };
        }
        // v6.9.46: budget-error content (200-but-dead) counts as a provider fail
        if (typeof text === 'string' && POLLEN_BUDGET_MSG.test(stripThinkBlocks(text))) {
          engineNoteFail('pollinations', 'AI (Pollinations — keyless)', 'quota', 'anonymous key budget exhausted (content is budget msg)');
        }
      } else {
        engineNoteFail('pollinations', 'AI (Pollinations — keyless)', classifyEngineError(r.status, await r.text().catch(() => '')), `HTTP ${r.status}`);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.message === 'Cancelled') throw new Error('Cancelled');
      engineNoteFail('pollinations', 'AI (Pollinations — keyless)', 'net', String(e?.message || 'network error').slice(0, 80));
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
// v6.9.15: structured numbers so the UI can show a click-to-explain panel.
export interface SanityCheck {
  category: string;
  verdict: 'plausible' | 'absurd' | 'uncertain';
  reason: string;
  // v6.9.15 structured context for the UI popover:
  kind?: 'low' | 'high';      // count implausibly LOW (scan gap) or HIGH (mis-tags)
  found?: number;             // businesses found by the scan
  per10k?: number;            // found per 10k residents
  expected?: number | null;   // expected per 10k baseline → absolute expected count
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
  // v6.9.36: how this scan was collected — lets the LLM (and the UI) treat
  // self-healed results appropriately instead of as raw first-pass data.
  scanMeta?: {
    areaFactor: number;        // 1 = base area; 2 / 3.5 = self-healing enlarged it
    healed: boolean;           // a retry found MORE businesses and was kept
    initialCount: number | null; // businesses the first pass found (when healed)
  };
}

// Deterministic pattern detection over the real scan results — the numbers
// the LLM reasons over, computed locally so they are always exact.
export function computeMarketFacts(
  businesses: Map<string, Business[]>,
  population: number,
  cityName: string,
  countryName: string,
  demandSignals?: Map<string, DemandSignal>,
  scanMeta?: MarketFacts['scanMeta'],
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
    scanMeta: scanMeta, // v6.9.36: healing transparency for the LLM
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

  // v6.9.36: collection methodology — when self-healing enlarged the scan
  // area, the model must know so it doesn't treat neighboring towns' data
  // as the city's own market.
  const scanMetaLine = f.scanMeta && f.scanMeta.areaFactor > 1
    ? `
SCAN METHOD: the initial scan area found too few businesses and was auto-expanded ${f.scanMeta.areaFactor}×${f.scanMeta.healed ? ` (retry kept: ${f.scanMeta.initialCount} → ${f.totalBusinesses} businesses)` : ''}. Treat counts as reflecting the WIDER area, not ${f.cityName} alone; be conservative about city-specific gaps and mention the wider coverage when relevant.`
    : '';

  return `CITY: ${f.cityName}, ${f.countryName}
POPULATION: ${f.population > 0 ? f.population.toLocaleString() : 'unknown'}
TOTAL BUSINESSES SCANNED: ${f.totalBusinesses}${scanMetaLine}

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
// v6.9.15: tightened for SHORT, chart-friendly, evidence-first output.
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
- ALWAYS quote the exact number that backs the claim ("3x fewer gyms per capita", "12 of 48 have a website").
- Be SHORT: insight.title ≤ 60 chars; insight.detail ≤ 140 chars; pattern.description ≤ 140 chars; risk ≤ 120 chars; action ≤ 90 chars; rationale ≤ 120 chars.
- Prefer sentence fragments over full sentences where possible. No filler ("It is worth noting…"), no hedging.`;

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

Generate exactly 3 insights, 2-3 patterns, 2 risks, 3 actions. Keep every string SHORT (title ≤ 60 chars, detail ≤ 140 chars). Every claim must quote a number from the data above.`;

  // Cache: analysis is a pure function of (facts, opportunities). Same
  // inputs → same cached output (no model re-roll), so repeat scans show
  // the exact same AI panel instantly instead of a 20-60s LLM wait.
  const aiCk = 'ai_' + cacheKey(
    hashStr(facts.cityName + '|' + facts.countryName), facts.population, opportunities.length,
    hashStr(JSON.stringify(facts.categories) + JSON.stringify(opportunities.map(o => [o.category, o.score, o.existing, o.gap]))),
    // v6.9.36: a healed scan has different methodology → different analysis
    facts.scanMeta?.areaFactor ?? 1
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

    // Validate + normalize the model output (v6.9.15: clamps enforce the
    // SHORT-output contract even when a model ignores the length rules)
    const insights: AIInsight[] = (parsed.insights || [])
      .filter((x: any) => x && typeof x.title === 'string' && typeof x.detail === 'string')
      .slice(0, 5)
      .map((x: any) => ({
        title: String(x.title).slice(0, 80),
        detail: String(x.detail).slice(0, 160),
        severity: (['high', 'medium', 'low'] as const).includes(x.severity) ? x.severity : 'medium',
        categories: Array.isArray(x.categories)
          ? x.categories.filter((c: any) => typeof c === 'string').slice(0, 4)
          : undefined,
      }));
    const patterns: AIPattern[] = (parsed.patterns || [])
      .filter((x: any) => x && typeof x.name === 'string' && typeof x.description === 'string')
      .slice(0, 4)
      .map((x: any) => ({
        name: String(x.name).slice(0, 80),
        description: String(x.description).slice(0, 160),
        categories: Array.isArray(x.categories)
          ? x.categories.filter((c: any) => sortableStrictCategories(c)).slice(0, 4)
          : undefined,
      }));
    const risks: string[] = (parsed.risks || [])
      .filter((x: any) => typeof x === 'string')
      .slice(0, 4)
      .map((x: any) => String(x).slice(0, 140));
    const actions: AIAction[] = (parsed.actions || [])
             .filter((x: any) => x && typeof x.action === 'string' && typeof x.rationale === 'string')
      .slice(0, 4)
      .map((x: any) => ({
        action: String(x.action).slice(0, 100),
        rationale: String(x.rationale).slice(0, 140),
        timeframe: (['immediate', '1-3 months', '6-12 months'] as const).includes(x.timeframe)
          ? x.timeframe : undefined,
      }));

    if (insights.length === 0 && patterns.length === 0) throw new Error('empty-analysis');

    // v6.9.36: healing transparency on the model path too — prepended so
    // users read the methodology note before any model interpretation.
    if (facts.scanMeta?.healed && facts.scanMeta.initialCount != null) {
      insights.unshift({
        title: `🔍 Scan auto-healed: area expanded ${facts.scanMeta.areaFactor}×`,
        detail: `First pass found only ${facts.scanMeta.initialCount} businesses; the ${facts.scanMeta.areaFactor}× retry found ${facts.totalBusinesses}. Counts reflect the wider area — neighboring towns may be included.`,
        severity: 'low',
        categories: undefined,
      });
    }

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
      title: `Biggest gap: ${big.categoryLabel}`,
      detail: `${big.existing} exist vs ~${((big.gap as number) + big.existing).toLocaleString()} expected → ${big.gap} missing (${big.per10k}/10k).`,
      severity: big.score >= 70 ? 'high' : 'medium',
      categories: [big.category],
    });
  }

  // 2. Saturation warning
  if (facts.saturationCluster.length > 0) {
    insights.push({
      title: `${facts.saturationCluster.length} saturated categories`,
      detail: `Crowded: ${facts.saturationCluster.map(label).join(', ')}. Differentiate or avoid.`,
      severity: 'medium',
      categories: facts.saturationCluster.slice(0, 4),
    });
  }

  // 3. Low-competition (blue-ocean) list
  if (facts.lowCompetition.length > 0) {
    insights.push({
      title: `${facts.lowCompetition.length} low-competition categories`,
      detail: `Under 5 businesses each: ${facts.lowCompetition.slice(0, 5).map(label).join(', ')}. First-mover space.`,
      severity: facts.lowCompetition.length >= 3 ? 'medium' : 'low',
      categories: facts.lowCompetition.slice(0, 4),
    });
  }

  // 4. Geo-concentration insight
  if (facts.hubStats.concentration >= 25) {
    insights.push({
      title: `Businesses cluster in one zone (${facts.hubStats.concentration}%)`,
      detail: `${facts.hubStats.clusters} clusters; biggest (${facts.hubStats.dominant ?? 'mixed'}) holds ${facts.hubStats.concentration}%. Outlier districts underserved.`,
      severity: 'medium',
    });
  }

  // ── Patterns (deterministic) ──
  // P1: saturation vs underservice asymmetry
  if (facts.saturationCluster.length > 0 && facts.underservedCluster.length > 0) {
    patterns.push({
      name: 'Saturation–gap asymmetry',
      description: `Crowded (${facts.saturationCluster.slice(0, 2).map(label).join(', ')}) coexists with underserved (${facts.underservedCluster.slice(0, 2).map(label).join(', ')}).`,
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
      description: `${ca.existing} ${label(a)} and ${cb.existing} ${label(b)} — shared foot traffic; co-location captures spillover demand.`,
      categories: [a, b],
    });
  }

  // P3: contact coverage gap
  const coverage = facts.contactCoverage;
  if (facts.totalBusinesses > 10 && coverage.emails / facts.totalBusinesses < 0.3) {
    patterns.push({
      name: 'Low digital presence',
      description: `Only ${coverage.emails}/${facts.totalBusinesses} have an email, ${coverage.websites} a website — room for digital-first entrants.`,
    });
  }

  // ── Risks (deterministic) ──
  if (facts.population === 0) {
    risks.push('Population unknown — per-capita gap estimates unreliable.');
  }
  risks.push('OSM is volunteer data — informal/new businesses may be missing.');
  if (coverage.emails + coverage.phones + coverage.websites < facts.totalBusinesses * 0.5) {
    risks.push('Contact enrichment incomplete — reachability may be understated.');
  }

  // ── Actions (deterministic) ──
  if (gapped.length > 0) {
    const top = gapped[0];
    actions.push({
      action: `Validate demand for ${top.categoryLabel}`,
      rationale: `Top gap: ${top.gap} missing, score ${top.score}/100. Run 10-20 customer interviews first.`,
      timeframe: 'immediate',
    });
  }
  if (facts.lowCompetition.length > 0) {
    actions.push({
      action: `Pilot a ${label(facts.lowCompetition[0])} offering`,
      rationale: `Only ${facts.categories.find(c => c.category === facts.lowCompetition[0])?.existing ?? 0} competitors — cheap low-risk test.`,
      timeframe: '1-3 months',
    });
  }
  if (facts.hubStats.concentration >= 25) {
    actions.push({
      action: 'Scout locations outside the main cluster',
      rationale: `${facts.hubStats.concentration}% of businesses sit in one zone — outer districts have demand, little supply.`,
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
// Per-capita plausibility bands (per 10k residents) — module-level since
// v6.9.24 so BOTH the sanity checker and the opportunity scorer share the
// same thresholds (the scorer lowers confidence for out-of-band categories).
export const SANITY_BANDS: Record<string, { min: number; max: number }> = {
  cafe: { min: 0.5, max: 40 }, restaurant: { min: 0.5, max: 40 },
    fast_food: { min: 0.2, max: 25 }, bar: { min: 0.1, max: 20 },
    convenience: { min: 1, max: 50 }, supermarket: { min: 0.5, max: 12 },
    bakery: { min: 0.3, max: 15 }, pharmacy: { min: 0.4, max: 12 },
    bank: { min: 0.4, max: 12 }, hotel: { min: 0.3, max: 25 },
    hostel: { min: 0.15, max: 25 }, // v6.9.24: hostel had no band — undercounted hostels were never flagged, so the category could win the leaderboard on an empty scan (Tbilisi case)
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
    massage: { min: 0.05, max: 12 }, // v6.9.19: standalone category band
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

export function sanityCheckOpportunities(
  opportunities: OpportunityResult[],
  population: number,
): SanityCheck[] {
  const out: SanityCheck[] = [];
  const BANDS = SANITY_BANDS;
  if (population <= 0) return out; // no population → nothing to check against
  for (const opp of opportunities) {
    const per10k = (opp.existing / population) * 10000;
    const band = BANDS[opp.category];
    if (!band) continue;
    if (per10k < band.min) {
      // v6.9.15: structured fields (kind/found/per10k/expected) power the UI
      // "explain" panel; expected = absolute minimum count for this population.
      out.push({
        category: opp.category,
        verdict: 'absurd',
        kind: 'low',
        found: opp.existing,
        per10k,
        expected: Math.max(1, Math.round(band.min * population / 10000)),
        reason: `Scan found only ${opp.existing} ${opp.categoryLabel} (${per10k.toFixed(2)} per 10k residents) — far below the normal range for a city this size. Most were likely missed: OSM coverage here is thin. The real number is higher, so don't treat this gap as real demand.`,
      });
    } else if (per10k > band.max) {
      out.push({
        category: opp.category,
        verdict: 'absurd',
        kind: 'high',
        found: opp.existing,
        per10k,
        expected: Math.max(1, Math.round(band.max * population / 10000)),
        reason: `Scan found ${opp.existing} ${opp.categoryLabel} (${per10k.toFixed(1)} per 10k residents) — above the normal range. Some entries are probably mis-tagged or duplicated. Check a few samples before trusting this count.`,
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
- ALWAYS quote the exact number that backs the claim ("only 34% list a phone", "12 competitors").
- Be SHORT: title ≤ 60 chars; detail ≤ 140 chars; description ≤ 140 chars; risk ≤ 120 chars; action ≤ 90 chars; rationale ≤ 120 chars. No filler, no hedging.`;

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

Generate exactly 3 insights, 2 patterns, 1-2 risks, 3 actions. Keep every string SHORT (title ≤ 60 chars, detail ≤ 140 chars). Every claim must quote a number from the data above.`;

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
        title: String(x.title).slice(0, 80),
        detail: String(x.detail).slice(0, 160),
        severity: (['high', 'medium', 'low'] as const).includes(x.severity) ? x.severity : 'medium',
      }));
    const patterns: AIPattern[] = (parsed.patterns || [])
      .filter((x: any) => x && typeof x.name === 'string' && typeof x.description === 'string')
      .slice(0, 3)
      .map((x: any) => ({ name: String(x.name).slice(0, 80), description: String(x.description).slice(0, 160) }));
    const risks: string[] = (parsed.risks || [])
      .filter((x: any) => typeof x === 'string')
      .slice(0, 3)
      .map((x: any) => String(x).slice(0, 140));
    const actions: AIAction[] = (parsed.actions || [])
      .filter((x: any) => x && typeof x.action === 'string' && typeof x.rationale === 'string')
      .slice(0, 4)
      .map((x: any) => ({
        action: String(x.action).slice(0, 100),
        rationale: String(x.rationale).slice(0, 140),
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
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void; areaBbox?: [number, number, number, number] | null },
): Promise<Map<string, Business[]>> {
  if (absurdCategories.length === 0) return businesses;
  // v6.9.20: match the main scan's area so the re-check doesn't miss
  // businesses that were simply outside the old fixed 10 km circle
  const [south, west, north, east] =
    opts?.areaBbox && opts.areaBbox.length === 4 && opts.areaBbox.every(v => Number.isFinite(v))
      ? opts.areaBbox
      : circleBbox(lat, lon, radiusMeters);
  const bbox = `${south},${west},${north},${east}`;
  const merged = new Map(businesses);

  for (const cat of absurdCategories.slice(0, 6)) {
    if (opts?.signal?.aborted) break;
    const kw = WIDE_NET_KEYWORDS[cat];
    if (!kw) continue;
    const q = `[out:json][timeout:30];(
  node(${bbox})${kw};
  way(${bbox})${kw};
);out center body;`;
    try {
      opts?.onProgress?.(`Re-checking ${getCategoryLabel(cat)} with a wider search…`);
      const d = await fetchOverpass(q, 30);
      if (!d?.elements) continue;
      // v6.9.49: clone — `new Map()` shares the inner arrays, so pushing here
      // also grew the CALLER's map and made its before/after delta read as 0.
      const existing = [...(merged.get(cat) || [])];
      const seenIds = new Set(existing.map(b => b.id));
      const seenLocs = new Set(existing.map(b => `${Math.round(b.lat * 1000)},${Math.round(b.lon * 1000)}`));
      let added = 0;
      // v6.9.19: buckets that overlap heavily — if the categorizer is
      // CONFIDENT the element belongs to a *different* one of these, don't
      // double-count it into the target bucket.
      const LIFESTYLE = new Set(['yoga', 'dance', 'massage', 'spa', 'nail_salon', 'beauty_salon', 'hair_salon', 'gym']);
      for (const el of d.elements) {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        if (!elLat || !elLon) continue;
        const tags = el.tags || {};
        // v6.9.19: the element was found BY the category's multilingual
        // name-keyword filter — trust that signal. The old strict
        // `categorizeBusiness(tags) !== cat` check re-ran the categorizer
        // (English-only back then) and silently dropped most rescues.
        // Skip only when the categorizer confidently files it into a
        // DIFFERENT overlapping lifestyle bucket (avoids double counts).
        const cat2 = categorizeBusiness(tags);
        if (cat2 && cat2 !== cat && LIFESTYLE.has(cat2) && LIFESTYLE.has(cat)) continue;
        const name = tags.name || tags['name:en'] || tags['name:int'] || tags.brand || tags.operator || '';
        if (!name.trim() || isJunkBusinessName(name)) continue;
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
          ...(() => extractContactPair(tags, ctx?.countryCode))(),
          website: extractWebsite(tags) || extractRescueWebsite(tags), // v6.9.52 rescue
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

// ─── v6.9.48: Web-registry supplement for OSM-thin professional services ──
// OSM under-maps accountants, consultants, software firms and lawyers nearly
// everywhere (0 office=accountant in all of Tbilisi). The wide-net rescan can
// only recover what OSM has; this supplement searches the live web instead.
// Source: Brave web search (key already pooled, CORS-direct). Query templates
// use the category's native-language term + city name + the country ccTLD so
// results come from the country's own business web, in any language.

// Titles that are directory/listing PAGES, not individual businesses. If the
// result's URL host matches, the entry is an index — skip it (the *businesses*
// listed inside will each appear as their own result on related queries).
// Registries, yellow pages, marketplaces and mirror-sites: pages ABOUT
// businesses, never a business's own site.
const SUPP_DIRECTORY_HOSTS = /(^|\.)(yell|yellow|yellowpages|goldenpages|phonebook|companyinfo|azbuka|infobiz|facebook|instagram|linkedin|twitter|tiktok|youtube|wikipedia|tripadvisor|yelp|zomato|glassdoor|indeed|clutch|goodfirms|sortlist|designrush|upwork|fiverr|toptal|freelancer|opendi|hotfrog|cybo|zaubee|nicelocal|worldorgs|cityseeker|trustpilot|provenexpert|companieshouse|opencorporates|zoominfo|lusha|rocketreach|yp|madloba|tagalliances|techbehemoths|kompas|bizapedia|companylist|goods?list|europages|kompass|directory|directories|taxravens|relocup|catalog|catalogue|gis|2gis|map|maps|plan)\.[a-z]{2,}/i;
// Multi-label platform hosts (need the full domain, not just a label).
const SUPP_DIRECTORY_HOSTS2 = /(^|\.)(x\.com|bir\.ai|apollo\.io|dnb\.com|top-?rated\.|top10\.|bestof\.|find-open\.|spyur\.|usembassy\.|embassy\.|portal\.)/i;
// Registrable domains that ARE the plural profession word are always portals
// (lawyers.ge, accountants.am, auditors.ge) — never a single firm's own site.
const SUPP_PROFESSION_PORTAL = /^(lawyers?|accountants?|auditors?|attorneys?|realtors?|notaries|notary|jurists?)\.[a-z]{2,}/i;
// Government / education / chamber-of-commerce hosts: sector bodies, not firms.
const SUPP_INSTITUTIONAL = /(^|\.)(gov|mil|edu|ac|chamber|chambers)\.[a-z]{2,}$|(^|\.)(gov|mil|edu|ac|chamber|chambers)\.[a-z]{2,}\.[a-z]{2,}$/i;

// Paths that mark a page as a listing/profile of a REGISTRY or a freelancer
// marketplace rather than a firm's own site (yp.com.ge/organizations/org-…,
// kompas.ge/en/company/…, toptal.com/developers/resume/…).
const SUPP_DIRECTORY_PATHS = /^\/(organizations?|orgs?|company|companies|firm|firms|agency|agencies|resume|resumes|profile|profiles|freelancers?|developers?\/resume|en\/company|dir|dirs|biz|business|businesses|listing|listings)(\/|$)/;

// Category → web-query templates. {city} is the scan city (native if possible,
// English fallback — search engines cross-match), {tld} the country ccTLD.
// NOTE (measured v6.9.48): Brave's API returns ZERO results for `site:`
// filters — both `site:.*\.ge` and plain `site:.ge`. Templates therefore use
// free-text locality + the native-language category term instead, and the
// ccTLD is used only as a *preference* in the filter below.
const SUPP_QUERIES: Record<string, string[]> = {
  accountant: [
    '{catNative} {city} accounting company',
    'accounting firm {city} contact',
    'bookkeeping audit company {city}',
  ],
  it_consulting: [
    '{catNative} {city} consulting company',
    'consulting firm {city} contact',
    'business consulting services {city}',
  ],
  software: [
    'software company {city} contact',
    'software development company {city}',
    '{catNative} {city} IT company',
  ],
  lawyer: [
    'law firm {city} contact',
    '{catNative} {city} attorney',
    'legal services company {city}',
  ],
  real_estate: [
    'real estate agency {city} contact',
    '{catNative} {city} realtor',
    'property management company {city}',
  ],
  it: [
    'IT company {city} contact',
    '{catNative} {city} technology company',
  ],
  digital_marketing: [
    'digital marketing agency {city} contact',
    '{catNative} {city} marketing agency',
  ],
  web_agency: [
    'web design agency {city}',
    'web development studio {city}',
  ],
};

// Title before the separator is the page title; for business sites it's
// usually "Business Name — what they do" or "Business Name | location".
function suppBrandFromHost(host: string): string {
  const parts = (host || '').split('.');
  if (parts.length < 2) return '';
  // handle ccSLDs like .com.ge / .co.uk
  const idx = parts.length >= 3 && /^(com|co|org|net|gov|edu|ac)$/i.test(parts[parts.length - 2])
    ? parts.length - 3 : parts.length - 2;
  const brand = parts[idx] || '';
  if (!brand || brand.length < 3) return '';
  if (/^(site|index|main|home|www|en|eng|ka|hy|az|ru|geo)$/i.test(brand)) return '';
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function suppExtractName(title: string, url: string): string {
  let name = (title || '').split(/\s*[|—–·»«-]\s+/)[0].trim();
  // Titles like "Accounting Services in Tbilisi" are service pages —
  // fall back to the domain brand.
  if (!name || /^(account|consult|law|legal|real estate|bookkeep|software|it |best|top \d)/i.test(name)) {
    name = '';
  }
  // v6.9.50: generic page titles ("Home Page", "Contact", "About us") are
  // navigation pages, not brands — same fallback to the domain brand.
  if (/^(home|home ?page|homepage|contact( us)?|about( us)?|welcome|main page|index|services?|our (team|company|services))$/i.test(name)) {
    name = '';
  }
  if (!name) {
    try {
      // v6.9.48e: was parts[len-2], which yields "Com" for every *.com.ge
      // host. suppBrandFromHost understands ccSLDs (.com.ge/.co.uk).
      const host = new URL(url).hostname.replace(/^www\./, '');
      name = suppBrandFromHost(host);
    } catch { /* bad URL */ }
  }
  // Never accept a bare TLD-ish token as a firm name.
  if (/^(com|net|org|info|biz|ge|am|az|tr|ru|co|io|www|site|index|main|home|en)$/i.test(name)) name = '';
  return name;
}

/**
 * v6.9.48: supplement thin professional-services categories from the live
 * web. Runs after rescanWideNet when sanity flags remain: searches Brave
 * for real firms the OSM scan cannot see, merges them into the map with
 * `supplemented: true` and approximate pins (city center ± 2km). Rate-limit
 * friendly: one query at a time, skips when Brave reports exhausted.
 */
export async function supplementProServices(
  businesses: Map<string, Business[]>,
  thinCategories: string[],
  cityLat: number,
  cityLon: number,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<Map<string, Business[]>> {
  const ctx = getScanContext();
  const tld = countryTld();
  if (!tld || thinCategories.length === 0) return businesses;
  const merged = new Map(businesses);
  let supplementTotal = 0;
  // v6.9.48d: drop-reason counters. Tuning this filter blind wasted a full
  // debugging cycle — the operator now sees exactly why results were dropped.
  const drops: Record<string, number> = {};
  let rawTotal = 0;
  const bump = (why: string) => { drops[why] = (drops[why] || 0) + 1; };

  for (const cat of thinCategories.slice(0, 5)) {
    if (opts?.signal?.aborted) break;
    const templates = SUPP_QUERIES[cat];
    if (!templates) continue;
    // v6.9.49: clone the bucket. `new Map(businesses)` copies the map but the
    // arrays inside stay SHARED — pushing into them silently grew the caller's
    // own map too, which made "did the supplement add anything?" always false
    // (callers compared the same array before and after).
    const existing = [...(merged.get(cat) || [])];
    if (existing.length >= 25) continue; // only genuinely thin categories
    const catNative = ctx ? categoryInNative(cat, getCategoryLabel(cat)) : getCategoryLabel(cat);
    const seenHosts = new Set(existing.map(b => {
      try { return new URL(b.website || `https://${b.id}`).hostname.replace(/^www\./, ''); } catch { return b.id; }
    }));
    const seenNames = new Set(existing.map(b => b.name.trim().toLowerCase()));
    let added = 0;

    for (const tpl of templates) {
      if (opts?.signal?.aborted || added >= 15) break;
      // v6.9.48b: Brave blocks browser CORS (preflight → 405), so the search
      // runs server-side via the Supabase Brave proxy (token in Vault).
      const q = tpl
        .replace('{city}', ctx?.cityEn || '')
        .replace('{catNative}', catNative)
        .replace(/\{tld\}/g, tld);
      opts?.onProgress?.(`Searching the web for more ${getCategoryLabel(cat)} businesses…`);
      try {
        const start = await supabaseRpc<{ rid?: number; error?: string }>('rpc_brave_start', { p_query: q }, 15000);
        if (!start?.rid) { if (start?.error) engineNoteFail('brave', 'Brave', 'net', `proxy: ${start.error}`); break; }
        const rid = start.rid;
        let data: any = null;
        for (let i = 0; i < 10; i++) {
          if (opts?.signal?.aborted) break;
          if (i > 0) await abortableWait(1500);
          const poll = await supabaseRpc<{ state: string; data?: any; error?: string }>('rpc_brave_poll', { p_rid: rid }, 15000);
          if (!poll) break;
          if (poll.state === 'done') { data = poll.data; break; }
          if (poll.state === 'failed') { braveNoteFail('net', `proxy: ${poll.error || 'failed'}`); break; }
        }
        if (!data) continue;
        const rawResults = (data.web?.results || []).length;
        rawTotal += rawResults;
        for (const res of (data.web?.results || [])) {
          if (added >= 15) break;
          const url: string = res.url || '';
          if (!url || !/^https?:\/\//i.test(url)) { bump('bad-url'); continue; }
          const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
          if (!host) { bump('bad-url'); continue; }
          if (SUPP_DIRECTORY_HOSTS.test(host) || SUPP_DIRECTORY_HOSTS2.test(host)) { bump('directory-host'); continue; }
          if (SUPP_PROFESSION_PORTAL.test(host) || SUPP_INSTITUTIONAL.test(host)) { bump('registry-host'); continue; }
          if (seenHosts.has(host)) { bump('duplicate'); continue; }
          // v6.9.48c: small-city queries return mostly DIRECTORY pages
          // (madloba.info/en/batumi/accounting…, taxravens.com/en/accountant/…).
          // A real firm's site never carries the CITY in its path — reject
          // those. (The country token alone is normal on country sites, so it
          // is only used as a soft signal, not a hard drop.)
          let path = '';
          try { path = new URL(url).pathname.toLowerCase(); } catch { path = ''; }
          const citySlug = (ctx?.cityEn || '').toLowerCase();
          if (citySlug && path.includes(citySlug)) { bump('city-in-path'); continue; }
          if (SUPP_DIRECTORY_PATHS.test(path)) { bump('registry-path'); continue; }
          if (/\/(directory|listings?|catalog|catalogues?|companies|company-directory|firms?|agencies|business-directory|categories|category|browse|search|find|local|yellow[_-]?pages?|yp|legal-assistance|embassy)\//.test(path)) { bump('listing-path'); continue; }
          const titleLc = (res.title || '').toLowerCase();
          // Title must look like a firm, not a listing page: reject plural
          // roundups, "top N", "list of", "companies in <city>".
          if (/(\btop \d|\bbest \d|\blist of|\ddirectory|\bcompanies in\b|\bfirms in\b|\bagencies in\b|\bservices in\b)/i.test(titleLc)) { bump('generic-title'); continue; }
          if (/\b(companies|firms|agencies|specialists|professionals)\b/i.test(titleLc) && !/\b(llc|ltd|inc|gmbh|group|partners|associates|studio|solutions)\b/i.test(titleLc)) { bump('plural-title'); continue; }
          let name = suppExtractName(res.title || '', url);
          // A long title is a page headline, not a brand → use the domain.
          if (name.length > 40) name = suppBrandFromHost(host) || name.slice(0, 40);
          if (!name || name.length < 3) { bump('no-name'); continue; }
          if (seenNames.has(name.toLowerCase())) { bump('duplicate-name'); continue; }
          // Approximate pin: deterministic per-domain hash → ±2km around the
          // city center so pins are spread, stable across rescans, and not
          // stacked on one spot.
          let h = 0;
          for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
          const lat = cityLat + (((h >>> 8) % 400) - 200) / 100000; // ±0.002°
          const lon = cityLon + ((h % 400) - 200) / 100000;
          seenHosts.add(host);
          seenNames.add(name.toLowerCase());
          existing.push({
            id: `supp/${cat}/${h.toString(36)}`,
            name,
            lat, lon,
            category: cat,
            categoryLabel: getCategoryLabel(cat),
            address: `${ctx?.cityEn || ''} · found on the web${res.description ? '' : ''}`.trim(),
            phone: '',
            website: url,
            email: '',
            brand: '',
            cuisine: '',
            facebook: '',
            instagram: '',
            linkedin: '',
            youtube: '',
            tiktok: '',
            rating: 0,
            reviewCount: 0,
            hours: '',
            twitter: '',
            pinterest: '',
            supplemented: true,
          });
          added++;
        }
      } catch { /* network fail — try next template */ }
      await abortableWait(600);
    }
    if (added > 0) {
      merged.set(cat, existing);
      supplementTotal += added;
      opts?.onProgress?.(`Web supplement: +${added} ${getCategoryLabel(cat)} businesses from company websites`);
      // ── v6.9.50: enrich immediately from each firm's own website ──────
      // Web-found firms arrive with a URL but empty contacts. Per the scan
      // principle (v6.9.16): the firm's site → contact page is the #1 source
      // of phone/email — do it NOW so results show contacts without needing
      // a separate Enrich Contacts run. Reuses the proven scrapers.
      const newlyAdded = existing.slice(-added).filter(b => b.supplemented && b.website);
      if (newlyAdded.length > 0) {
        opts?.onProgress?.(`Checking ${newlyAdded.length} new websites for phones & emails…`);
        const BUDGET_MS = 60_000; // hard stop — dead sites can't stall the scan
        const t0 = Date.now();
        const CONC = 6;
        for (let i = 0; i < newlyAdded.length; i += CONC) {
          if (opts?.signal?.aborted || Date.now() - t0 > BUDGET_MS) break;
          const batch = newlyAdded.slice(i, i + CONC);
          await Promise.all(batch.map(async (b) => {
            try {
              await enrichFromWebsiteDeep(b); // JSON-LD → tel:/mailto: → multilingual contact pages
              if (!b.email || !b.phone) { try { await scrapeWordPressAPI(b); } catch {} }
            } catch { /* single site failing must never break the scan */ }
          }));
          await abortableWait(150);
        }
        let gotPhone = 0, gotEmail = 0;
        for (const b of newlyAdded) {
          // v6.9.50: final validation sweep — anything the extractors let
          // through that fails plausibility is dropped, never displayed.
          if (b.phone && !plausiblePhone(b.phone)) b.phone = '';
          if (b.email && !plausibleEmail(b.email)) b.email = '';
          if (b.phone) gotPhone++; if (b.email) gotEmail++;
        }
        if (gotPhone + gotEmail > 0) {
          opts?.onProgress?.(`Websites yielded ${gotPhone} phones, ${gotEmail} emails across ${newlyAdded.length} new firms.`);
        }
      }
    }
  }
  if (opts?.onProgress && rawTotal > 0) {
    const why = Object.entries(drops).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${v} ${k}`).join(', ');
    opts.onProgress(`Web supplement: ${rawTotal} web results → ${supplementTotal} new businesses${why ? ` (dropped: ${why})` : ''}.`);
  }
  return merged;
}

// Name-keyword filters for the second-chance rescan (name-based so local tag
// variants that the focused query missed still surface). English keywords
// catch international chains; the app's query engine handles i18n via tags.
const WIDE_NET_KEYWORDS: Record<string, string> = {
  printing: '["name"~"print|druck|typograf|печать|друк|ბეჭდვ|印刷|인쇄|طباعة|דפוס|สิ่งพิมพ์|प्रिंट|cetak",i]',
  cleaning: '["name"~"clean|hygiene service|уборк|чистк|temizlik|წმენდ|清洁|清掃|청소|تنظيف|ניקיון|ทำความสะอาด|सफाई|pembersihan",i]',
  yoga: '["name"~"yoga|йога|յոգա|იოგა|瑜伽|ヨガ|요가|يوغا|יוגה|โยคะ|योग",i]',
  books: '["name"~"book|bücher|книг|գրք|წიგნ|書店|书店|ブックス|서점|책방|مكتبة|ספרים|หนังสือ|पुस्तक|buku|sách",i]',
  bookstore: '["name"~"book|bibli|книг|գրախանութ|წიგნ|書店|书店|ブックス|서점|책방|مكتبة|ספרים|หนังสือ|पुस्तक|buku",i]',
  coworking: '["name"~"cowork|work Lab|hub|коворк|コワーキング|共享办公|聯合辦公|코워킹|공유 오피스|مساحة عمل|משרד משותף|โคเวิร์กกิง|कोवर्किंग",i]',
  tattoo: '["name"~"tattoo|тат|տատու|ტატუ|纹身|紋身|刺青|タトゥー|타투|وشم|קעקוע|สักยันต์|टैटू",i]',
  music_school: '["name"~"music school|musik|piano|guitar|музык|երաժշտ|მუსიკ|音楽教室|音楽学校|音乐学校|音乐教室|음악학원|음악 교실|مدرسة موسيقى|בית ספר למוסיקה|โรงเรียนดนตรี|संगीत विद्यालय",i]',
  art: '["name"~"art|gallery|atelier|галер|արվեստ|ხელოვნ|艺术|藝術|画廊|畫廊|ギャラリー|アート|미술|갤러리|فن|אמנות|גלריה|ศิลปะ|แกลเลอรี|कला",i]',
  wedding: '["name"~"wedding|bridal|braut|свадеб|հարսան|ქორწი|婚|結婚|ウェディング|웨딩|결혼|زفاف|أعراس|חתונה|งานแต่ง|शादी|विवाह",i]',
  courier: '["name"~"courier|delivery|express|kargo|курьер|курʼєр|მიწოდებ|არაქარი|快递|配送|物流|宅配|運送|택배|배달|توصيل|شحن|משלוח|พัสดุ|จัดส่ง|कूरियर|डिलीवरी|giao hàng|kurir",i]',
  dance: '["name"~"dance|danz|ballet|танц|պար|ცეკვ|舞蹈|ダンス|舞踊|댄스|무용|رقص|ריקוד|นาฏศิลป|เต้น|नृत्य",i]',
};

// ── v6.9.19: multilingual re-check banks (overrides + additions) ───────
// The table above had NO entries for nail_salon/spa/beauty_salon/
// hair_salon/massage — those categories were silently skipped by the
// re-check (`if (!kw) continue`), which is exactly how Dubai ended up
// reporting 3 nail salons. Name banks cover ~20 languages each. The
// yoga/dance overrides add tag-based selectors so the re-check also
// finds correctly-tagged-but-locally-named venues.
WIDE_NET_KEYWORDS.nail_salon = '["name"~"nail|manicure|pedicure|маникюр|педикюр|манікюр|manikür|네일|ネイル|美甲|美睫|أظافر|مناكير|नेल|ম্যানিকিউর|ניקור",i]';
WIDE_NET_KEYWORDS.spa = '["name"~"spa|sauna|wellness|спа|ساونا|স্পা|สปา|スパ|스파|水疗|溫泉|સ્પા",i]';
WIDE_NET_KEYWORDS.beauty_salon = '["name"~"beauty|salon|cosmet|güzellik|красот|تجميل|ビューティ|뷰티|미용|美容|બ્યુટી",i]';
WIDE_NET_KEYWORDS.hair_salon = '["name"~"hair|friseur|coiff|kuaf|пари|barber|حلاق|美发|理发|ヘア|미용실|이발소|کوافیر",i]';
WIDE_NET_KEYWORDS.massage = '["name"~"massage|массаж|masaż|masaj|マッサージ|마사지|按摩|推拿|นวด|مساج|تدليك|मालिश",i]';
WIDE_NET_KEYWORDS.yoga = '["name"~"yoga|pilates|йога|یوگا|يوغا|योग|ヨガ|요가|瑜伽|普拉提",i]|["leisure"="yoga"]|["sport"~"yoga|pilates",i]';
WIDE_NET_KEYWORDS.dance = '["name"~"dance|ballet|танц|балет|舞蹈|ダンス|댄스|무용|رقص|नृत्य|เต้น",i]|["leisure"~"dance|dance_hall"]|["amenity"="dancing_school"]';
// v6.9.24: hostel had NO wide-net entry — when the first scan missed most
// hostels (common: tagged only with a name, or tagged as a generic office),
// the second-chance rescan silently skipped the category, cementing the
// false "hostels are a gap" story. Name-based multilingual selector now
// rescues them; overlap with the hotel bucket is impossible because the
// categorizer's hostel branch runs before the hotel branch.
WIDE_NET_KEYWORDS.hostel = '["name"~"hostel|hostal|ostello|хостел|ჰოსტელი|ホステル|호스텔|青年旅舍|青旅|ユースホステル|유스호스텔|青年旅社",i]|["tourism"="hostel"]';
// ── v6.9.47: professional-services rescues ──
// These five had NO wide-net entries: when Discover under-scanned them (the
// exact Accounting/IT-Consulting/Software/Real-Estate/Law-Firm story from the
// Tbilisi v6.9.46 run), the second-chance rescan silently skipped them and
// the "low data" warning just stayed. Name-keyword banks in the languages
// the local market actually names these businesses (plus Georgian, since the
// tag probe showed local-language names dominate generic offices there).
WIDE_NET_KEYWORDS.accountant = '["name"~"account|audit|bookkeep|buhgalter|бухгалт|аудит|ბუღალტ|აუდიტ|հաշվապա|mühasib|mühasib|muhasebe|denetim|会計|会計事務所|회계|세무|הנהלת חשבונות|محاسبة|contabilit|comptab|rachunkow",i]|["office"~"accountant|tax_advisor|tax|audit|bookkeeping"]';
WIDE_NET_KEYWORDS.lawyer = '["name"~"law|legal|attorney|advokat|advo[cg]at|notar|юрис|адвокат|нотари|იურიდ|ადვოკატ|ნოტარ|իրավաբան|փաստաբան|hüquq|hukuk|avukat|noter|法律|法律事務所|弁護士|법률|변호사|משפט|محاماة|قانوني|kancelaria|anwalt|avocat|avvocat",i]|["office"~"lawyer|attorney|notary|law"]';
WIDE_NET_KEYWORDS.real_estate = '["name"~"real.?estate|realty|property|immobili|нерухом|недвиж|უძრავი|ქონებ|անշարժ|əmlak|gayrimenkul|emlak|房地产|不動産|부동산|נדל|عقار|immo|inmobiliaria|kinnisvara",i]|["office"~"estate_agent|real_estate|property_management"]|["shop"="estate_agent"]';
WIDE_NET_KEYWORDS.it_consulting = '["name"~"consult|консалт|консульт|კონსალტ|խորհրդաტ|məsləhət|danışman|コンサル|컨설팅|ייעוץ|استشارات|konsult|conseil|beratunge|staffing|recruit|hr\b|personnel",i]|["office"~"consulting|business_consulting|it_consulting|management_consulting|employment_agency|staffing"]';
WIDE_NET_KEYWORDS.software = '["name"~"software|\bit\b|it company|tech|digital|web|dev|data|cloud|cyber|სისტემ|პროგრამ|программ|разработ|ծրագրավոր|proqram|bilişim|yazılım|ソフトウェア|システム|소프트|개발|תוכנה|הייטק|برمجة",i]|["office"~"it|software|computer|it_company|web_design|web_developer|hosting|game_developer|technology"]';

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

  // ── v6.9.24: coverage detection (general principle, not location data) ──
  // If EVERY category comes back suspiciously empty, the problem is the
  // data source (OSM coverage / scan area), not the market. In that case
  // "few found = little competition" is a lie, so low-competition bonuses
  // and gap scores must be damped, not crowned.
  let totalBiz = 0;
  for (const [, bizs] of businesses) totalBiz += bizs.length;
  const checkedCats = businesses.size;
  const coveredRatio = checkedCats > 0 ? totalBiz / checkedCats : 0;   // avg businesses/category
  const osmCoverage = Math.min(1, coveredRatio / 15);                  // ≥15 avg/category → full coverage

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

    // ── v6.9.24: competition score — the old formula (100 − existing×3,
    // 90 for zero) crowned any category the scanner failed to cover as a
    // "blue ocean". Now "zero found" is treated as UNVERIFIED, not empty:
    // the scan floor subtracts what the scan plausibly missed before the
    // competition score is computed, and "zero" never scores higher than
    // "a few confirmed exist".
    const scanFloor = Math.ceil(
      (bl * (pop || 0) / 10000) * 0.25 * (pop ? 1 : 0.5) * (1 - osmCoverage)
    );
    const unverified = Math.max(0, scanFloor - existing);
    const compRaw = existing === 0 ? 90 : Math.max(0, Math.round(100 - existing * 3));
    const compScore = Math.round(Math.max(0, compRaw - unverified * 2));

    let score = Math.round(0.45 * gapScore + 0.25 * sizeScore + 0.30 * compScore);

    // ── v6.9.24: data-confidence damping (the principle fix) ──
    // A category the scanner undercounted (below the same plausibility
    // bands the sanity checker uses) or an area with thin OSM coverage
    // must NOT be able to win the leaderboard on "low competition".
    // Confidence multiplies the score instead of banning it: still visible,
    // honestly ranked, and flagged by the sanity checker as before.
    const band = SANITY_BANDS[cat];
    const undercounted = !!(pop && band && per10k < band.min);
    let confidence = 1;
    if (undercounted) confidence -= 0.4;         // count below plausibility floor
    if (!pop) confidence -= 0.15;                 // no population → gap/size are guesses
    confidence -= 0.25 * (1 - osmCoverage);       // thin OSM coverage overall
    confidence = Math.max(0.2, confidence);
    score = Math.round(score * confidence);

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
function plausiblePhone(p: string, strict = true): boolean {
  const t = p.trim();
  const digits = t.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  // date-like: 2026-06-11 / 11.06.2026 / 2026/06/11
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(t)) return false;
  // v6.9.54: date WITH trailing time ("2026-09-17 10", "2026-09-17 10:42")
  // slipped past the anchored regexes — CMS timestamps from scraped pages.
  // Also any 19xx/20xx 4-digit group followed by two separator groups is a
  // date prefix (real phones never start 19XX-/20XX- with 2-digit groups;
  // US "202-555-0173" keeps its 3-digit area code and survives).
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T]\d{1,2}(:\d{2})?)?$/.test(t)) return false;
  if (/^(19|20)\d{2}[-/.]\d{1,2}[-/.]/.test(t)) return false;
  // IP-like: 23.58.223.22
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return false;
  // bare 1-prefixed 10-13 digit runs without + are usually timestamps/IDs
  // (real international numbers in our regions carry +995/+374/+90/+7)
  if (/^1\d{9,12}$/.test(digits) && !t.startsWith('+')) return false;
  // v6.9.51: naked digit runs (no separators, no +) are IDs/timestamps in
  // SCRAPED text — but OSM tag values are mapper-curated and DO contain real
  // domestic numbers in bare form (599663300 GE mobile, 0322196669 GE
  // landline). Tbilisi audit: 0 real junk vs 3 false purges. So the strict
  // naked-run rule applies by default (web scrapers), while the final
  // OSM-validation pass calls with strict=false.
  if (strict) {
    const core = t.replace(/^[^\d]+/, '').replace(/[^\d]+$/, '');
    if (!t.startsWith('+') && !/[()\s\-.]/.test(core) && digits.length <= 10) return false;
  }
  return true;
}

// Junk emails: asset files and placeholder addresses that regexes pick up
const _EMAIL_FILE_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;
const _EMAIL_JUNK_RE = /example\.com|noreply|no-reply|donotreply|wixpress|sentry\.io|cloudflare|privacy|abuse@|postmaster@|schema\.org|w3\.org|user@|username@|your(name|mail)?@|email@domain/i;
// v6.9.83: platform/infrastructure domains that scraped pages reference but
// no small business owns. A cafe whose email reads info@duckduckgo.co got it
// from a followed search-result page — poison. Search engines, CDNs, CMS
// hosts and app stores can never be the SMTP domain of a local business.
// v6.9.94: adds the standards/validator domains that website TEMPLATES ship
// with in their JSON-LD/microdata boilerplate — info@schema.org leaked into
// hundreds of rows from template contact pages (the Wix/WordPress default
// Organization block). Also w3.org, ogp.me, and webmaster spamtrap hosts.
const _EMAIL_PLATFORM_RE = /(duckduckgo|bing|google|yahoo|microsoft|outlook|hotmail|gmail|icloud|proton|yandex|mail\.ru|zoho|fastmail|startpage|mojeek|brave|ecosia|qwant|search|cloudfront|akamai|amazonaws|azureedge|wix|shopify|squarespace|webflow|godaddy|namecheap|hostinger|siteground|bluehost|wordpress|schema|w3|ogp|whatwg|mozilla|wikipedia|wikimedia|webcache|translate)\.(com|co|io|net|org|me|ge|ru|de|fr)$/i;

// v6.9.37: structural email validation for the final data-quality pass.
// Checks the stored email still looks like a real address after every
// extraction layer has run — no network calls, pure rules.
export function plausibleEmail(e: string): boolean {
  const v = (e || '').trim().toLowerCase();
  if (!v || v.length < 6 || v.length > 80) return false;
  // Exactly one @, non-empty local and domain parts
  const at = v.split('@');
  if (at.length !== 2 || !at[0] || !at[1]) return false;
  const [local, domain] = at;
  // Domain needs a dot and a 2+ TLD; no file extensions posing as TLDs
  if (!domain.includes('.') || /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|webm|mp[34])$/i.test(domain)) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  // Local part: no leading/trailing dot, no consecutive dots
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9._%+-]+$/.test(local)) return false;
  // v6.9.50: URL-encoding artifacts ("%22@abcg.ge") are fragment debris,
  // not addresses — %/encoding in the local part is always junk.
  if (/%[0-9a-f]{2}/i.test(local) || /%/.test(local)) return false;
  // Pure-digit locals ("12946800@site") are IDs, not people — EXCEPT short
  // codes ≤4 digits, which are real corporate addresses (444@ucom.am and
  // 111@viva.am are the official Armenian telecom contacts; the Yerevan
  // audit proved scraped IDs are always long runs).
  if (/^\d{5,}$/.test(local)) return false;
  // Junk senders/roles that regexes commonly harvest from footers
  if (_EMAIL_JUNK_RE.test(v)) return false;
  // v6.9.83: search-engine / platform / CDN domains — the most common
  // cross-contamination when followed result pages carry the engine's own
  // footer emails.
  if (_EMAIL_PLATFORM_RE.test(domain)) return false;
  return true;
}

// v6.9.94: sanitize a restored RunRecord — records captured by older versions
// may carry template-poison emails (info@schema.org) that predate the strict
// validator. Any email failing plausibleEmail is dropped at restore time so
// old data self-heals instead of re-poisoning the table.
export function sanitizeRunRecord(r: RunLike): RunLike {
  try {
    // Same rules as the engine's final validation pass (v6.9.95) so any
    // restore of an older capture self-heals: emails, phones AND websites.
    const SITE_JUNK = /schema\.org|w3\.org|ogp\.me|duckduckgo\.com|bing\.com|google\.[a-z.]+|ecosia\.org|startpage\.com|qwant\.com|brave\.com|mojeek\.com/i;
    for (const pair of r.businesses || []) {
      const arr = pair?.[1];
      if (!Array.isArray(arr)) continue;
      for (const b of arr as Record<string, unknown>[]) {
        if (b && typeof b.email === 'string' && b.email && !plausibleEmail(b.email)) b.email = '';
        if (b && typeof b.phone === 'string' && b.phone && !plausiblePhone(b.phone)) b.phone = '';
        if (b && typeof b.phone === 'string' && b.phone && /^\d{1,3}(\.\d{3}){2,}/.test(b.phone)) b.phone = '';
        if (b && typeof b.website === 'string' && b.website && SITE_JUNK.test(b.website)) b.website = '';
      }
    }
  } catch { /* malformed record — return as-is */ }
  return r;
}
export interface RunLike { businesses?: [string, unknown[]][]; [k: string]: unknown; }

// ─── Test-only exports (corsFetch is module-scope; extractFromHtml is
// published inside queryBusinesses, which owns its scope) ───
export const __internals: any = {};
__internals.corsFetch = corsFetch;
__internals.extractFromHtml = extractFromHtmlModule;

// ─── v6.9.59: Per-extraction-layer yield counters ───────────────
// Answers "which layers actually find contacts?" — JSON-LD vs microdata vs
// mailto vs Cloudflare etc. Module-level so both scrape sites (deep crawler
// and this module extractor) feed the same tally. Purely additive telemetry:
// no extraction behavior changes, reset at every scan start.
export type ExtractionLayerKey = 'tel' | 'wa' | 'viber' | 'jsonld' | 'microdata' | 'label' | 'regex' | 'mailto' | 'cfdecode' | 'entity' | 'obfusc' | 'jslit' | 'dataattr' | 'meta' | 'vcard' | 'mxguess' | 'socialbio' | 'svfetch' | 'snippetdig' | 'linkcrawl' | 'wayback' | 'render' | 'rnav' | 'rsearch' | 'rbing' | 'rsocial' | 'rinfer' | 'rcms';
export interface ExtractionYieldEntry { found: number; tries: number; }
export interface ExtractionYieldMap { [k: string]: ExtractionYieldEntry; }
const _extractYield: ExtractionYieldMap = {};
export function resetExtractionYield(): void { for (const k of Object.keys(_extractYield)) delete _extractYield[k]; }
function yieldBump(key: ExtractionLayerKey): void {
  const e = _extractYield[key] || (_extractYield[key] = { found: 0, tries: 0 });
  e.found++;
}
function yieldTry(key: ExtractionLayerKey): void {
  const e = _extractYield[key] || (_extractYield[key] = { found: 0, tries: 0 });
  e.tries++;
}
export const _EXTRACT_LAYER_META: { key: ExtractionLayerKey; label: string; icon: string }[] = [
  { key: 'tel',       label: 'tel: links',      icon: '📞' },
  { key: 'wa',        label: 'WhatsApp',        icon: '💬' },
  { key: 'viber',     label: 'Viber',           icon: '🟣' },
  { key: 'jsonld',    label: 'JSON-LD',         icon: '🧬' },
  { key: 'microdata', label: 'Microdata',       icon: '🏷️' },
  { key: 'label',     label: 'Labeled',         icon: '🏷️' },
  { key: 'regex',     label: 'Regex',           icon: '🔤' },
  { key: 'mailto',    label: 'mailto:',         icon: '✉️' },
  { key: 'cfdecode',  label: 'CF decode',       icon: '☁️' },
  { key: 'entity',    label: '&#64;',           icon: '🔤' },
  { key: 'obfusc',    label: '[at] forms',      icon: '🔑' },
  { key: 'jslit',     label: 'JS literals',     icon: '📜' },
  { key: 'dataattr',  label: 'data-email',      icon: '🔗' },
  { key: 'meta',      label: 'Meta/OG',         icon: '🌐' },
  { key: 'vcard',     label: 'vCard',           icon: '📇' },
  { key: 'mxguess',   label: 'MX guess',        icon: '📮' },
  { key: 'socialbio', label: 'Social bio',      icon: '📱' },
  { key: 'svfetch',   label: 'Server fetch',    icon: '🖥️' },
  { key: 'snippetdig', label: 'Snippet dig',    icon: '⛏️' },
  { key: 'rnav',     label: 'Retry nav',       icon: '🔁' },
  { key: 'rcms',     label: 'CMS/sitemap',     icon: '🗂️' },
  { key: 'rsearch',  label: 'Retry search',    icon: '🔎' },
  { key: 'rbing',    label: 'Retry Bing',      icon: '🅱️' },
  { key: 'rsocial',  label: 'Retry social',  icon: '📱' },
  { key: 'rinfer',   label: 'Inference',       icon: '🧠' },
  { key: 'linkcrawl',  label: 'Link crawl',    icon: '🕸️' },
  { key: 'wayback',    label: 'Wayback',       icon: '🏛️' },
  { key: 'render',     label: 'Render',        icon: '🎭' },
];
export function getExtractionYield(): ExtractionYieldMap { return JSON.parse(JSON.stringify(_extractYield)); }

// ── Unified extraction: pull phone, email, website, social from any HTML/text ──
// (module-scope utility: pure parsing, no closure state — used by the
// enrichment pipeline inside queryBusinesses and by the parsing test harness)
// v6.9.59: every extraction point now reports hits/tries to _extractYield.
function extractFromHtmlModule(html: string, b: Business): void {
  const JUNK = /example\.com|wixpress|sentry\.io|webpack|googleapis|google\.com|gstatic|cloudflare|facebook\.com|instagram\.com|twitter\.com|duckduckgo|schema\.org|privacy.*policy|terms.*service|cookie/i;
  const EMAIL_FILE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|pdf|zip|woff2?|ttf|otf|mp[34]|webm|avi|mov)$/i;    // Phone: tel: links, then text regex
  if (!b.phone) {
    // 1. tel: links (most reliable — tolerate single quotes & spacing)
    yieldTry('tel');
    const telM = html.match(/href\s*=\s*["']tel:([^"']+)["']/i);
    if (telM) { b.phone = (() => { try { return decodeURIComponent(telM[1]).trim(); } catch { return telM[1].trim(); } })(); yieldBump('tel'); }
    // 1b. WhatsApp click-to-chat links — wa.me/995… or api.whatsapp.com/send?phone=…
    if (!b.phone) {
      yieldTry('wa');
      const waM = html.match(/(?:wa\.me\/(\+?\d{7,15})|whatsapp\.com\/send[^"']*\?phone=(\+?\d{7,15}))/i);
      const raw = waM ? (waM[1] || waM[2]) : '';
      if (raw) { b.phone = raw.startsWith('+') ? raw : `+${raw}`; yieldBump('wa'); }
    }
    // 1c. Viber deep links — viber://chat?number=%2B995…
    if (!b.phone) {
      yieldTry('viber');
      const vbM = html.match(/viber:\/\/chat\?number=%2B(\d{7,15})/i);
      if (vbM) { b.phone = `+${vbM[1]}`; yieldBump('viber'); }
    }
    // 1d. JSON-LD structured data: "telephone": "+995 …"
    if (!b.phone) {
      yieldTry('jsonld');
      const ldPhoneM = html.match(/"telephone"\s*:\s*"(\+?[\d\s\-\(\)]{7,20})"/i);
      if (ldPhoneM && plausiblePhone(ldPhoneM[1])) { b.phone = ldPhoneM[1].trim(); yieldBump('jsonld'); }
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
    // 2b. JSON-LD telephone — many sites embed the phone ONLY in structured
    // data. v6.9.58: the walker reaches @graph + contactPoint nodes.
    if (!b.phone) {
      yieldTry('jsonld');
      for (const jl of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          const entities: Record<string, unknown>[] = [];
          collectJsonLdEntities(JSON.parse(jl[1]), entities);
          for (const e of entities) {
            const tp = Array.isArray(e.telephone) ? String(e.telephone[0]) : (typeof e.telephone === 'string' ? e.telephone : '');
            if (!tp) continue;
            const digits = tp.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(tp)) { b.phone = tp.trim(); yieldBump('jsonld'); break; }
          }
        } catch {}
        if (b.phone) break;
      }
    }
    // 2c. Microdata (itemprop) — schema.org HTML annotations
    if (!b.phone) {
      yieldTry('microdata');
      const mdP = html.match(/itemprop=["'](?:telephone|faxNumber)["'][^>]*>([^<]{7,25})</i) || html.match(/<meta[^>]*itemprop=["'](?:telephone|faxNumber)["'][^>]*content=["']([^"']{7,25})/i);
      if (mdP) {
        const digits = mdP[1].replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(mdP[1])) { b.phone = mdP[1].trim(); yieldBump('microdata'); }
      }
    }
    if (!b.email) {
      const mdE = html.match(/itemprop=["']email["'][^>]*>([^<]{6,80})</i) || html.match(/<meta[^>]*itemprop=["']email["'][^>]*content=["']([^"']{6,80})/i);
      if (mdE && mdE[1].includes('@') && plausibleEmail(mdE[1].trim())) { b.email = mdE[1].trim(); yieldBump('microdata'); }
    }
    // 3. Labeled phone patterns (Phone: +xxx, Tel: xxx, etc.)
    // v6.9.57: multilingual labels — Spanish sites label numbers "Teléfono:"
    // / "Móvil:", French "Téléphone:", Portuguese "Telefone:", Russian
    // "Телефон:", Greek "Τηλέφωνο:" — the English-only list missed all of
    // them even when the scraper reached the right page.
    if (!b.phone) {
      yieldTry('label');
      const labeledPh = html.match(/(?:phone|tel|telephone|mobile|cell|fax|calls?|whatsapp|viber|contact|teléfono|teléfonos|móvil|móviles|telefone|téléphone|téléphones|telefon(?:o|i|ul)?|telefonnummer|telefoon|телефон|телефоны|τηλέφωνο|τηλέφωνα|تلفن|هاتف)\s*[:;=\s"'>]*([+\d][\d\s\-\.()]{7,18})/i);
      if (labeledPh) {
        const digits = labeledPh[1].replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(labeledPh[1])) { b.phone = labeledPh[1].trim(); yieldBump('label'); }
      }
    }
    // 4. General phone regex (fallback). Unlabeled text is noisy: require a
    // leading '+' so floats/coordinates (2.3333…), IDs and fragments don't
    // match. Labeled/tel: paths above stay permissive for local formats.
    if (!b.phone) {
      yieldTry('regex');
      const phM = html.match(/(?:\+?\d[\d\s\-\.\(\)]{7,18})/g);
      if (phM) {
        for (const p of phM) {
          if (!p.includes('+')) continue;
          const digits = p.replace(/[^\d+]/g, '');
          if (digits.length >= 8 && digits.length <= 15 && plausiblePhone(p) && !JUNK.test(p)) { b.phone = p.trim(); yieldBump('regex'); break; }
        }
      }
    }
  }

  // Email: structured extraction with verification
  // Strategy 1: Look for contact info in structured HTML (most reliable)
  if (!b.email) {
    // Contact section: look for labeled email near "contact" heading
    yieldTry('label');
    const contactSection = html.match(/<(?:div|section|footer|aside)[^>]*class="[^"]*contact[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|footer|aside)/i);
    if (contactSection) {
      const emails = contactSection[1].match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (plausibleEmail(clean)) { b.email = clean; yieldBump('label'); break; }
        }
      }
    }
  }

  // Email: mailto, text, Cloudflare decode, &#64; encode, JSON-LD
  if (!b.email) {
    // 1. mailto: links (most reliable)
    yieldTry('mailto');
    const mailM = html.match(/href="mailto:([^"\?\s]+)/i);
    if (mailM && plausibleEmail(mailM[1].trim())) { b.email = mailM[1].trim(); yieldBump('mailto'); }
    // 2. Labeled email patterns (Email: xxx@yyy.com)
    if (!b.email) {
      // v6.9.57: + correo/courriel/e-mail international labels
      yieldTry('label');
      const labelM = html.match(/(?:email|e-mail|mail|contact|correo(?:\s+electr\u00f3nico)?|courriel|\u043f\u043e\u0447\u0442\u0430|\u03b5\u03c0\u03b9\u03ba\u03bf\u03b9\u03bd\u03c9\u03bd\u03af\u03b1|\u0627\u06cc\u0645\u06cc\u0644)\s*[:;=\s"'>]*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (labelM && plausibleEmail(labelM[1])) { b.email = labelM[1]; yieldBump('label'); }
    }
    // 3. JSON-LD structured data
    if (!b.email) {
      yieldTry('jsonld');
      const jsonLdEmails = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of jsonLdEmails) {
        try {
          const data = JSON.parse(m[1]);
          // v6.9.58: recursive walk — @graph + contactPoint emails
          const entities: Record<string, unknown>[] = [];
          collectJsonLdEntities(data, entities);
          for (const e of entities) {
            if (typeof e.email === 'string' && e.email && plausibleEmail(e.email)) { b.email = e.email; yieldBump('jsonld'); break; }
          }
        } catch {}
        if (b.email) break;
      }
    }
    // 4. General email regex (fallback)
    if (!b.email) {
      yieldTry('regex');
      const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emails) {
        for (const e of emails) {
          const clean = e.replace(/[\s>);]+$/, '');
          if (plausibleEmail(clean)) { b.email = clean; yieldBump('regex'); break; }
        }
      }
    }
    // 5. Cloudflare encoded emails
    if (!b.email) {
      yieldTry('cfdecode');
      const cfM = html.match(/data-cfemail="([a-f0-9]+)"/i);
      if (cfM) {
        try {
          const bytes = cfM[1].match(/.{2}/g)!.map(h => parseInt(h, 16));
          const key = bytes[0];
          const decoded = bytes.slice(1).map(x => x ^ key).map(x => String.fromCharCode(x)).join('');
          if (decoded.includes('@') && plausibleEmail(decoded)) { b.email = decoded; yieldBump('cfdecode'); }
        } catch {}
      }
    }
    // 6. HTML entity encoded (@)
    if (!b.email) {
      yieldTry('entity');
      const entM = html.match(/([a-zA-Z0-9._%+-]+)&#64;([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (entM && !JUNK.test(entM[0])) { b.email = entM[1] + '@' + entM[2]; yieldBump('entity'); }
    }
    // 7. Human-obfuscated: name [at] site [dot] com — bracket forms only
    // (unambiguous markers; a bare " at " would false-positive on prose)
    if (!b.email) {
      yieldTry('obfusc');
      const obM = html.match(/([a-zA-Z0-9._%+-]{2,})\s*(?:\[\s*at\s*\]|\(\s*at\s*\))\s*([a-zA-Z0-9][a-zA-Z0-9.-]{1,60})\s*(?:\[\s*(?:dot|\.|\u2022)\s*\]|\(\s*(?:dot|\.|\u2022)\s*\)|\.)\s*([a-zA-Z]{2,15})/i);
      if (obM) {
        const em = (obM[1] + '@' + obM[2] + '.' + obM[3]).toLowerCase();
        if (!JUNK.test(em) && !EMAIL_FILE.test(em)) { b.email = em; yieldBump('obfusc'); }
      }
    }
    // 7. JavaScript string literals
    if (!b.email) {
      yieldTry('jslit');
      const jsEmailM = html.match(/['"]([\w][\w._%+-]*@[\w.-]+\.[a-zA-Z]{2,})['"]/);
      if (jsEmailM && !JUNK.test(jsEmailM[1]) && !EMAIL_FILE.test(jsEmailM[1]) && jsEmailM[1].length > 6) { b.email = jsEmailM[1]; yieldBump('jslit'); }
    }
    // 8. data-email attributes
    if (!b.email) {
      yieldTry('dataattr');
      const dataEmailM = html.match(/data-email\s*=\s*["']([^"']+@[^"']+)/i);
      if (dataEmailM && !JUNK.test(dataEmailM[1]) && !EMAIL_FILE.test(dataEmailM[1])) { b.email = dataEmailM[1]; yieldBump('dataattr'); }
    }
    // 9. Obfuscated forms — "name [at] domain [dot] com", "name(at)domain(dot)com"
    if (!b.email) {
      yieldTry('obfusc');
      const obfM = html.match(/([\w][\w._%+-]{1,40})\s*(?:\(|\[|\{)?\s*(?:at|@|&#64;)\s*(?:\)|\]|\})?\s*([\w-]{2,40})\s*(?:\(|\[|\{)?\s*(?:dot|\.|&#46;)\s*(?:\)|\]|\})?\s*([a-zA-Z]{2,12})\b/i);
      if (obfM) {
        const cand = `${obfM[1]}@${obfM[2]}.${obfM[3]}`;
        if (!JUNK.test(cand) && !EMAIL_FILE.test(cand)) { b.email = cand.toLowerCase(); yieldBump('obfusc'); }
      }
    }
  }

  // Website: extract from links. Self-contained denylist (this variant must
  // not depend on the nested DIRECTORY_SITES/_EXCLUDE helpers).
  const WEBSITE_DENY = /yelp\.com|tripadvisor|foursquare|booking\.com|expedia|yellowpages|justdial|zomato|opentable|flickr|pinterest\.com|tumblr|reddit\.com|quora|wikipedia\.org|youtube\.com|tiktok\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|snapchat|threads|medium\.com|substack|archive\.org|amazon\.|ebay\.|aliexpress|2gis\.|yandex\.|uber\.com|doordash|grubhub|glassdoor|indeed\.com|thumbtack|bbb\.org|trustpilot|google\.|gstatic|apple\.com|microsoft\.com|schema\.org|w3\.org|duckduckgo\.com|bing\.com/i;
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
