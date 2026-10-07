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
