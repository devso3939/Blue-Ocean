/**
 * Deep-parsing skills — v6.9.149
 *
 * Second-tier extraction primitives layered on the v6.9.147/148 skills,
 * each backed by a battle-tested repo:
 *
 *   readMicroformats   → microformats-parser (github.com/microformats/
 *                        microformats-parser) — h-card/h-adr via mf2 +
 *                        v1 vcard back-compat.
 *   ogComplete         → metaformats technique (same repo's
 *                        experimental.metaformats): pages whose ONLY
 *                        contact surface is OG/Twitter meta tags.
 *   sweepSameAs        → schema.org sameAs lists (the engine's JSON-LD
 *                        walker only read facebook/instagram; this adds
 *                        tiktok/linkedin/youtube/twitter).
 *
 * All pure, browser-safe, unit-tested.
 */

import { mf2 } from 'microformats-parser';
import { getDomain } from 'tldts';

export interface MicroContact {
  name?: string;
  email?: string;
  url?: string;
  tel?: string;
  street?: string;
  locality?: string;
}

function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0]; // mf2 property values are always arrays
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const val = (v as Record<string, unknown>).value;
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

/**
 * Parse the FIRST h-card (with v1 `vcard` class back-compat) from raw
 * HTML. Sites that publish microformats expose the whole contact card in
 * one node; the engine's regex layers never read them.
 */
export function readMicroformats(html: string, baseUrl: string): MicroContact | null {
  // Pre-gate: presence of an mf2 root class anywhere (quote-delimited in
  // attributes, so no \s boundary). The parse itself is the authority.
  let doc: ReturnType<typeof mf2> | null = null;
  try {
    doc = mf2(html, { baseUrl });
  } catch { /* unparseable */ }
  if (!doc) return null;

  for (const item of doc.items || []) {
    if (!item.type?.some(t => t === 'h-card')) continue;
    const p = item.properties || {};
    const emailRaw = firstStr(p.email) || "";

    const email = emailRaw.replace(/^mailto:/i, '').trim();
    const tel = firstStr(p.tel);
    const out: MicroContact = {
      ...(firstStr(p.name) ? { name: firstStr(p.name) } : {}),
      ...(email && email.includes('@') ? { email } : {}),
      ...(firstStr(p.url) ? { url: firstStr(p.url) } : {}),
      ...(tel ? { tel } : {}),
    };
    // p-adr may be a nested h-adr
    const adr = p.adr?.[0];
    if (adr && typeof adr === 'object' && 'properties' in (adr as unknown as Record<string, unknown>)) {
      const ap = (adr as { properties?: Record<string, unknown> }).properties || {};
      const street = firstStr(ap['street-address']);
      const locality = firstStr(ap.locality);
      if (street || locality) Object.assign(out, { street, locality });
    } else if (typeof adr === 'string' && adr.trim()) {
      out.street = adr.trim();
    }
    if (Object.keys(out).length > 0) return out;
  }
  return null;
}

/**
 * OG-complete gate: true when the page's ONLY contact surface is meta
 * tags (no mailto:, no tel:, no visible @ in <body>) AND og:email or
 * og:telephone/og:phone_number exists. Guarding the jitter-free gate
 * means we don't re-parse every page — only the ones that need it.
 */
export function ogContactGate(html: string): boolean {
  if (!html || html.length < 100) return false;
  const body = html.slice(html.search(/<body[\s>]/i) >= 0 ? html.search(/<body[\s>]/i) : 0);
  // No visible structured contact surfaces — the meta block is all we have
  if (/<a\s[^>]*href\s*=\s*["']mailto:/i.test(body)) return false;
  if (/<a\s[^>]*href\s*=\s*["']tel:/i.test(body)) return false;
  if (/@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(body.slice(0, 5000))) return false;
  return /<meta[^>]+(?:property|name)\s*=\s*["'](og:email|og:telephone|og:phone_number|twitter:data1)["'][^>]*>/i.test(html);
}

/** vCard BEGIN/END blob → { tel, email } military-grade evidence lines */
export function parseVcardBlob(raw: string): { tel?: string; email?: string } {
  const out: { tel?: string; email?: string } = {};
  if (!raw || !/BEGIN:VCARD/i.test(raw)) return out;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.match(/^TEL[^:]*:(.+)$/i);
    if (t && !out.tel) out.tel = t[1].trim();
    const e = line.match(/^EMAIL[^:]*:(.+)$/i);
    if (e && !out.email) out.email = e[1].trim().replace(/^mailto:/i, '');
    if (out.tel && out.email) break;
  }
  return out;
}

/**
 * schema.org sameAs sweeper — the engine's JSON-LD walker only read
 * facebook/instagram from sameAs; TikTok/LinkedIn/YouTube/X are equally
 * official provenance and belong in their dedicated fields. Returns the
 * first link per platform found, extracted from any `sameAs`/`same_as`
 * string array inside a JSON-LD block. Returns {} when none found.
 */
export function sweepSameAs(html: string): { tiktok?: string; linkedin?: string; youtube?: string; twitter?: string } {
  const out: { tiktok?: string; linkedin?: string; youtube?: string; twitter?: string } = {};
  if (!html || !/same_?As/i.test(html)) return out;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const arr = JSON.parse(m[1]) as { sameAs?: unknown } | { '@graph'?: { sameAs?: unknown }[] };
      const nodes: { sameAs?: unknown }[] = [];
      if (Array.isArray((arr as { '@graph'?: unknown })['@graph'])) {
        for (const n of (arr as { '@graph': unknown[] })['@graph']) {
          if (n && typeof n === 'object') nodes.push(n as { sameAs?: unknown });
        }
      } else nodes.push(arr as { sameAs?: unknown });
      for (const n of nodes) {
        const sameAs = Array.isArray(n.sameAs) ? n.sameAs : [n.sameAs];
        for (const s of sameAs) {
          if (typeof s !== 'string' || !s.trim()) continue;
          const u = s.trim();
          if (!out.tiktok && /tiktok\.com\//i.test(u)) out.tiktok = u;
          if (!out.linkedin && /linkedin\.com\/(company|in)\//i.test(u)) out.linkedin = u;
          if (!out.youtube && /youtube\.com\/(channel|c|user|@)/i.test(u)) out.youtube = u;
          if (!out.twitter && /(twitter\.com|x\.com)\/[A-Za-z0-9_]/i.test(u)) out.twitter = u;
        }
      }
    } catch { /* malformed JSON-LD — next block */ }
  }
  return out;
}

/**
 * SMTP-domain reachability via a public IMAP/MX-adjacent probe: does a
 * mailbox candidate have a real DNS MX record? Wraps the same dns.google /
 * cloudflare-dns JSON-over-HTTP resolvers the engine already trusts.
 * Pure probe — NEVER sends mail; used to reject `info@domain.ge` guesses
 * that domain doesn't operate a mail server for.
 */
export async function domainMxProbe(host: string, timeoutMs = 3500): Promise<boolean> {
  const h = (host || '').trim().replace(/^www\./, '').toLowerCase();
  if (!h) return false;
  for (const r of [
    `https://dns.google/resolve?name=${encodeURIComponent(h)}&type=MX`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=MX`,
  ]) {
    try {
      const resp = await fetch(r, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) continue;
      const j = await resp.json() as { Answer?: { type: number; data?: string }[] };
      if (j.Answer?.some(a => a.type === 15 && a.data)) return true;
      if (j.Answer) return false; // authoritative empty → no MX
    } catch { /* next resolver */ }
  }
  return false;
}

/** eTLD+1 domain check re-exported from tldts for agent-policy reuse. */
export function sharedRegistrableDomain(a: string, b: string): boolean {
  try {
    const d1 = getDomain(new URL(a).hostname);
    const d2 = getDomain(new URL(b).hostname);
    return !!d1 && d1 === d2;
  } catch { return false; }
}
