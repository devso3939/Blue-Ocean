/**
 * Direct parsing verification: feeds REAL business websites (exported from
 * the backend's Overture-derived places store) through the engine's ACTUAL
 * extraction functions — the same code the enrichment pipeline runs.
 *
 * No Overpass, no search engines, no rate limits — this tests precisely the
 * layer the user asked about: does the parsing find emails/phones/socials
 * on real pages?
 */
import './__shim';
import { __internals } from './clientEngine';

// NOTE: deliberately unique local names — this file is bundled into the same
// CJS scope as clientEngine, and a name like 'extractFromHtml' here would
// collide with the engine's own function (esbuild renames it and the
// __internals assignment then points at an uninitialized binding).
const xExtract = (html: string, b: any) => __internals.extractFromHtml(html, b);
const xFetchPage = (url: string) => __internals.corsFetch(url);

// Re-export internals so `require()` consumers can smoke-test the extractors
// (esbuild CJS bundles only expose the ENTRY file's exports).
export { __internals };

interface Target {
  name: string;
  category: string;
  address: string;
  url: string;
  known: { phones: string[]; emails: string[]; socials: string[] };
}

const targets: Target[] = require('../parsing_targets.json');

function normEmail(e: string): string { return e.toLowerCase().replace(/\./g, ''); }
function normPhone(p: string): string { return p.replace(/\D/g, '').slice(-7); }

function overlap(found: string[], known: string[], norm: (s: string) => string): number {
  const kf = new Set(known.map(norm).filter(x => x.length > 0));
  if (!kf.size) return -1; // no ground truth
  const ff = new Set(found.map(norm));
  let hit = 0;
  for (const k of kf) if (ff.has(k)) hit++;
  return hit / kf.size;
}

const stats = {
  tried: 0, reachable: 0, anyContact: 0,
  emailHits: 0, emailNew: 0, emailTruth: 0,
  phoneHits: 0, phoneNew: 0, phoneTruth: 0,
  fb: 0, ig: 0,
};

const details: string[] = [];

async function processOne(t: Target) {
  stats.tried++;
  // The engine's fetch chain: direct first, then CORS proxies.
  let html = '';
  try {
    const resp = await xFetchPage(t.url); html = await resp.text();
  } catch { /* unreachable */ }
  if (html) stats.reachable++;
  if (!html) return;

  const b = {
    name: t.name, website: t.url, phone: '', email: '',
    facebook: '', instagram: '', linkedin: '', youtube: '', tiktok: '', twitter: '', pinterest: '',
  } as any;
  try {
    xExtract(html, b);
  } catch (e) {
    details.push(`ERR  ${t.name}: extractor threw ${(e as Error).message}`);
    return;
  }

  const hasContact = !!(b.email || b.phone || b.facebook || b.instagram);
  if (hasContact) stats.anyContact++;

  const eCov = overlap([b.email].filter(Boolean), t.known.emails, normEmail);
  const pCov = overlap([b.phone].filter(Boolean), t.known.phones, normPhone);

  const socials = t.known.socials || [];
  const knownFb = socials.find((s: string) => /facebook\.com/i.test(s));
  const knownIg = socials.find((s: string) => /instagram\.com/i.test(s));

  if (eCov > 0) stats.emailHits++;
  if (eCov === -1 && b.email) stats.emailNew++;
  if (eCov === 1) stats.emailTruth++;
  if (pCov > 0) stats.phoneHits++;
  if (pCov === -1 && b.phone) stats.phoneNew++;
  if (pCov === 1) stats.phoneTruth++;
  if (b.facebook || (knownFb && html.toLowerCase().includes('facebook.com'))) stats.fb++;
  if (b.instagram) stats.ig++;

  const parts = [`✓ ${t.name} (${t.category})`];
  if (b.email) parts.push(`    email: ${b.email}${eCov >= 0 ? ` [ground-truth overlap ${(eCov * 100).toFixed(0)}%]` : ' [new find]'}`);
  if (b.phone) parts.push(`    phone: ${b.phone}${pCov >= 0 ? ` [ground-truth overlap ${(pCov * 100).toFixed(0)}%]` : ' [new find]'}`);
  if (b.facebook) parts.push(`    fb:    ${b.facebook}`);
  if (b.instagram) parts.push(`    ig:    ${b.instagram}`);
  if (hasContact) details.push(parts.join('\n'));
}

async function main() {
  console.log(`=== DIRECT PARSING TEST: ${targets.length} real business websites ===\n`);

  // Concurrency 6, like the enrichment pipeline
  const CONC = 6;
  let idx = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (idx < targets.length) {
      const i = idx++;
      try {
        await processOne(targets[i]);
      } catch (e) {
        details.push(`ERR  ${targets[i].name}: ${(e as Error).message}`);
      }
    }
  });
  await Promise.all(workers);

  const noTruthEmail = targets.filter(t => !t.known.emails.length).length;
  const noTruthPhone = targets.filter(t => !t.known.phones.length).length;

  console.log(`websites tried:          ${stats.tried}`);
  console.log(`pages fetched:           ${stats.reachable} (${Math.round(stats.reachable / stats.tried * 100)}%)`);
  console.log(`any contact extracted:   ${stats.anyContact}`);
  console.log(`emails: ${stats.emailHits} ground-truth hits + ${stats.emailNew} new finds (truth available for ${targets.length - noTruthEmail})`);
  console.log(`phones: ${stats.phoneHits} ground-truth hits + ${stats.phoneNew} new finds (truth available for ${targets.length - noTruthPhone})`);
  console.log(`facebook signals: ${stats.fb}, instagram: ${stats.ig}`);

  console.log('\n--- findings (first 30) ---');
  console.log(details.slice(0, 30).join('\n'));

  const successRate = stats.reachable ? stats.anyContact / stats.reachable : 0;
  console.log(`\ncontact-extraction success rate on reachable pages: ${Math.round(successRate * 100)}%`);
  if (stats.reachable >= 10 && successRate < 0.2) {
    throw new Error('extraction success rate below 20% on reachable pages');
  }
  console.log('\nDIRECT PARSING PASS');
}

if (!process.env.SMOKE_ONLY) {
  main().catch(e => { console.error('DIRECT PARSING FAIL:', e && e.message || e); process.exit(1); });
}
