/**
 * Contact-parsing skills — v6.9.147
 *
 * Small, pure, unit-tested extraction primitives that give the engine,
 * the contact swarm and the AI agent better eyes on hostile markup.
 * Each skill wraps a battle-tested library (a GitHub repo in its own
 * right) instead of hand-rolled regex:
 *
 *   harvestAnchors        → htmlparser2  (github.com/fb55/htmlparser2)
 *   decodeContactEntities → he           (github.com/mathiasbynens/he)
 *   sameRegDomain         → tldts        (github.com/remusao/tldts)
 *   findTextContacts      → linkify-it   (github.com/linkify/linkify-it)
 *
 * All four are browser-safe pure JS (no Node streams/buffers), bundled
 * by Vite like the rest of the client.
 */

import { Parser } from 'htmlparser2';
import { decode as heDecode } from 'he';
import { getDomain } from 'tldts';
import { LinkifyIt } from 'linkify-it';
import { parsePhoneNumberFromString, AsYouType } from 'libphonenumber-js';

export interface HarvestedAnchor {
  /** Absolute URL (resolved against `base`), or the raw href when unresolvable */
  href: string;
  /** Visible anchor text, whitespace-collapsed */
  text: string;
  /** rel attribute when present (nofollow, etc.) */
  rel?: string;
}

/**
 * Harvest every <a href> WITH its visible text through a real, forgiving
 * HTML parser. Regex harvesting silently loses links when attributes are
 * reordered (`<a class=x href=…>` — the old pattern required href first),
 * when hrefs are unquoted or single-quoted with entities, when markup is
 * nested inside the anchor, and on truncated/malformed documents.
 * Unresolvable hrefs are returned raw — callers filter protocols.
 */
export function harvestAnchors(html: string, base: string, cap = 500): HarvestedAnchor[] {
  const out: HarvestedAnchor[] = [];
  if (!html) return out;
  try {
    let cur: { href: string; rel?: string; text: string } | null = null;
    const flush = () => {
      const a = cur;
      cur = null;
      if (!a || out.length >= cap) return;
      const raw = a.href.trim();
      if (!raw) return;
      let abs: string;
      try { abs = new URL(raw, base).toString(); } catch { abs = raw; }
      out.push({ href: abs, text: a.text.replace(/\s+/g, ' ').trim(), ...(a.rel ? { rel: a.rel } : {}) });
    };
    const parser = new Parser({
      onopentag(name, attrs) {
        if (name.toLowerCase() !== 'a') return;
        if (cur) flush(); // malformed nested <a> — close the previous one first
        const href = attrs.href;
        if (href === undefined) return; // <a> without href — not a link
        cur = { href, ...(attrs.rel ? { rel: attrs.rel } : {}), text: '' };
      },
      ontext(text) { if (cur) cur.text += text; },
      onclosetag(name) { if (name.toLowerCase() === 'a') flush(); },
    }, { decodeEntities: true });
    parser.write(html);
    parser.end();
  } catch { /* unparseable to the end — return what was harvested */ }
  return out.slice(0, cap);
}

/**
 * Full HTML-entity decode (named + numeric): `info&commat;example.com`,
 * `&#64;`, `&#x40;`, `&nbsp;` runs — obfuscations the engine's inline
 * numeric-entity patch never sees. Fast path skips clean strings.
 * Never throws; a failed decode returns the input untouched.
 */
export function decodeContactEntities(text: string): string {
  if (!text || text.indexOf('&') === -1) return text;
  try { return heDecode(text); } catch { return text; }
}

/**
 * True when both URLs share the same registrable domain — real eTLD+1 via
 * the Public Suffix List. `shop.example.co.uk` ≡ `www.example.co.uk`, and
 * `a.co.uk` ≢ `b.co.uk`, which naive last-two-labels got wrong (it merged
 * every `*.co.uk` site into one "site", letting the agent wander off-domain).
 * Unparseable URLs, IPs and single-label hosts (localhost) → false.
 */
export function sameRegDomain(a: string, b: string): boolean {
  try {
    const d1 = getDomain(new URL(a).hostname);
    const d2 = getDomain(new URL(b).hostname);
    return !!d1 && d1 === d2;
  } catch { return false; }
}

export interface TextContacts {
  emails: string[];
  urls: string[];
}

// v6 defaults ship fuzzy links OFF — enable them so bare `www.…`/`domain.tld`
// URLs in visible text are found too (emails are on by default).
const _linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true });

/**
 * Find emails and URLs buried in visible text. linkify-it recognizes bare
 * `www.…` links, odd-but-real TLDs and emails the engine's stricter regex
 * skips — its matches are then re-validated by the caller's own gates
 * (plausibleEmail etc.) before anything is written.
 */
export function findTextContacts(text: string, cap = 12): TextContacts {
  const emails: string[] = [];
  const urls: string[] = [];
  if (!text) return { emails, urls };
  try {
    const ms = _linkify.match(text);
    if (ms) {
      for (const m of ms) {
        if (m.schema === 'mailto:') {
          const e = m.text.replace(/^mailto:/i, '').trim();
          if (e.includes('@') && !emails.includes(e)) emails.push(e);
        } else {
          let u = m.raw.trim();
          if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u; // fuzzy link: no scheme
          if (!urls.includes(u)) urls.push(u);
        }
        if (emails.length >= cap && urls.length >= cap) break;
      }
    }
  } catch { /* linkify is defensive — return what matched */ }
  return { emails: emails.slice(0, cap), urls: urls.slice(0, cap) };
}

// ── E.164 normalization (the omkarcloud technique) ───────────────

/**
 * Normalize a phone to E.164 (+995322196669) using libphonenumber-js
 * region-awareness: `032 2 19 66 69` + GE → +995322196669. Returns ''
 * when nothing plausible parses — callers keep their original value.
 */
export function toE164(raw: string, region?: string): string {
  const t = (raw || '').trim();
  if (!t) return '';
  const digits = t.replace(/\D/g, '');
  try {
    if (region) {
      const parsed = parsePhoneNumberFromString(t, region as any);
      if (parsed && parsed.isValid()) return parsed.number.toString();
    }
    const intl = parsePhoneNumberFromString(t.startsWith('+') ? t : '+' + digits);
    if (intl && intl.isValid()) return intl.number.toString();
    if (t.startsWith('+') && digits.length >= 8 && digits.length <= 15) {
      return t.replace(/[\s()\-.]/g, '');
    }
  } catch { /* fall through */ }
  return '';
}

/** Same normalization, but non-destructive: returns the input unchanged
 *  when E.164 is impossible — for display paths that must not lose data. */
export function toE164OrKeep(raw: string, region?: string): string {
  return toE164(raw, region) || raw;
}

// ── Official-contact ranking (the omkarcloud technique) ──────────

/**
 * Rank found emails; the FIRST is the one an outreach email would use.
 * Order: own-domain personal/role ≥ own-domain departmental (info@) ≥
 * generic official hint ≥ platform relay (gmail/facebook etc.).
 * Deduplicates case-insensitively.
 */
export function rankOfficialEmails(emails: string[], ownDomain?: string): { best: string | null; ranked: string[] } {
  if (emails.length === 0) return { best: null, ranked: [] };
  const seen = new Set<string>();
  const uniq = emails.filter(e => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const domainOf = (e: string) => { try { return getDomain(e.split('@')[1] || '') || ''; } catch { return ''; } };
  const own = ownDomain ? (getDomain(ownDomain) || '').toLowerCase() : '';
  const score = (e: string): number => {
    const d = domainOf(e);
    const local = (e.split('@')[0] || '').toLowerCase();
    if (own && d === own) {
      // Within own-domain: personal/role-preferred > departmental info@
      return /^(info|contact|office|hello|mail|no-?reply|donotreply|noreply|postmaster|abuse|webmaster)/.test(local) ? 2 : 3;
    }
    if (/^(info|contact|office|hello|mail)@/.test(e)) return own ? 1 : 2; // dept w/o own-domain context
    if (d && d.split('.').length >= 2) return 1; // personal-ish on a real domain
    return 0; // platform relay / junk domain
  };
  const ranked = [...uniq].sort((a, b) => score(b) - score(a));
  return { best: ranked[0] || null, ranked };
}

/**
 * Rank found phones with the same logic: own-region E.164 first, then
 * plausible-but-unnormalized, then anything else. Dedup on digits.
 */
export function rankOfficialPhones(phones: string[], region?: string): { best: string | null; ranked: string[] } {
  if (phones.length === 0) return { best: null, ranked: [] };
  const seen = new Set<string>();
  const uniq = phones.filter(p => { const k = p.replace(/\D/g, ''); if (seen.has(k)) return false; seen.add(k); return true; });
  const norm = (p: string) => toE164(p, region);
  const score = (p: string): number => {
    const e = norm(p);
    if (e && region) { try { const q = parsePhoneNumberFromString(e); if (q && q.country === region) return 3; } catch { /* fall through */ } }
    if (e) return 2; // E.164-able but region unknown
    if (p.replace(/\D/g, '').length >= 8) return 1; // plausible but unparseable
    return 0;
  };
  const ranked = [...uniq].sort((a, b) => score(b) - score(a));
  return { best: ranked[0] || null, ranked };
}
