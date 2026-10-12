// v6.9.157 OFFLINE HARNESS (v2): SERP fixture replay — dork-yield A/B
// Run: npm run replay   (standalone; NOT part of npm test)
//
// Replays saved Bing/DDG SERP fixtures through the PRODUCTION search lanes:
// globalThis.fetch is shimmed to answer `bing.com/search` and
// `html.duckduckgo.com/html` requests with saved fixture HTML, then the real
// `searchBing` / `searchDDGHtml` functions run their real parser, real
// cachedLane wrapper and real corsFetch machinery over that HTML. The yield
// metric is the production email harvester (harvestSnippetEmails) applied to
// the parsed titles+snippets. Nothing in the parse path is copied — engine
// parser edits show up in replay output immediately.
//
// Fixture layout (see fixtures/serps/README.md):
//   fixtures/serps/bing/<encodeURIComponent(query)>.html
//   fixtures/serps/ddg/<encodeURIComponent(query)>.html
// Lookup per (engine, decoded query): exact filename, else a shared-term
// heuristic (own @host, site: host, or a shared word), else a BENIGN
// resultless page — so an uncaptured query yields zero, exactly like an
// engine returning no results.
//
// A/B: for each business shape —
//   old  = buildEmailQuery (the Phase-3 single emailQ, now exported)
//   dorks= buildEmailDorkQueries (up to 3 dorks)
// both replayed through both engines; exit 1 when the dork list yields FEWER
// addresses than the old query — strictly-more-yield is the ship gate.

declare const process: { exit: (code: number) => void };

import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { setScanContext, getScanContext, contactTermsNative } from './src/lang.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname ?? '.');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'serps');
const ENGINES = ['bing', 'ddg'] as const;
type Engine = (typeof ENGINES)[number];

interface Fixture { engine: Engine; file: string; name: string; raw: string }

function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const engine of ENGINES) {
    for (const sub of ['', '_samples']) {
      const dir = path.join(FIXTURE_DIR, engine, sub);
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files.filter(e => e.endsWith('.html'))) {
        try {
          const raw = readFileSync(path.join(dir, f), 'utf8');
          const encoded = f.replace(/\.html$/, '');
          let name = encoded;
          try { name = decodeURIComponent(encoded); } catch { /* keep raw */ }
          out.push({ engine, file: `${engine}/${sub ? sub + '/' : ''}${f}`, name, raw });
        } catch { /* unreadable — skip */ }
      }
    }
  }
  return out;
}

const FIXTURES = loadFixtures();

/** Query keywords that must never count as a "shared term" — they appear
 *  in EVERY query (dept terms, booleans) and would cross-match fixtures. */
const KEYWORDS = new Set(['info@', 'contact@', 'office@', 'sales@', 'or', 'and', 'site']);

/** Scan-context words (city, native contact terms) — also in EVERY query,
 *  so they must not count as shared terms either: without this, every
 *  Tbilisi business's query matches every other Tbilisi fixture. Computed
 *  lazily because the scan context is set further down at module scope. */
let _ctxStop: Set<string> | null = null;
function contextStop(): Set<string> {
  if (!_ctxStop) {
    _ctxStop = new Set([
      ...(getScanContext()?.cityNative || '').split(/\s+/),
      ...(getScanContext()?.cityEn || '').split(/\s+/),
      ...contactTermsNative().split(/\s+/),
    ].map(w => w.toLowerCase()).filter(Boolean));
  }
  return _ctxStop;
}

/** The query's subject host: `site:host` or `@host.tld` — the only thing a
 *  host-scoped dork is about. */
function hostOf(s: string): string | undefined {
  const m = s.match(/site:([a-z0-9.-]+\.[a-z]{2,})/i) || s.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : undefined;
}

/** Shared-term match between a decoded query and a decoded fixture name.
 *  Rules, in order:
 *    1. both host-scoped → same host only (site:cafemarco.ge must never
 *       reach the aversi fixture just because both list dept terms);
 *    2. one host-scoped → the other text must mention that host;
 *    3. otherwise ≥2 shared non-keyword words (one — the city — is too weak:
 *       every Tbilisi query would match every other Tbilisi fixture). */
function sharedTerm(query: string, fixtureName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(query), b = norm(fixtureName);
  const ha = hostOf(query), hb = hostOf(fixtureName);
  if (ha && hb) return ha === hb;
  if (ha && b.includes(ha)) return true;
  if (hb && a.includes(hb)) return true;
  const clean = (s: string) => s.split(' ')
    .filter(t => t.length > 3 && !KEYWORDS.has(t) && !contextStop().has(t) && !t.startsWith('site:'));
  const ta = clean(a);
  const tb = new Set(clean(b));
  return ta.filter(t => tb.has(t)).length >= 2;
}

function fixtureFor(engine: Engine, query: string): Fixture | undefined {
  const exact = FIXTURES.find(f => f.engine === engine && f.name === query);
  if (exact) return exact;
  return FIXTURES.find(f => f.engine === engine && sharedTerm(query, f.name));
}

// ── fetch shim ────────────────────────────────────────────────────────────

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Benign resultless pages — MUST avoid the production challenge detectors:
// Bing b_algo==0 + /akchal|challenge|verify|captcha/i ⇒ []; DDG
// /anomaly|challenge|captcha|blocked/i ⇒ engine-note fail (which would
// cooldown the lane for subsequent replays). Long enough (>200) for DDG's
// "empty response" gate. Zero results either way.
const BENIGN_BING = '<!DOCTYPE html><html><head><title>Search results</title></head>'
  + '<body><p>Offline harness: no fixture matched this query, so this benign '
  + 'resultless body stands in for an engine that found nothing.</p></body></html>';
const BENIGN_DDG = '<html><head><title>DuckDuckGo</title></head><body><p>'
  + 'Offline harness: no fixture matched this query, so this benign resultless '
  + 'body stands in for an engine that found nothing on this page today.'
  + '</p></body></html>';

const unmatched: string[] = [];

function engineResponse(engine: Engine, qEnc: string): Response {
  const query = safeDecode(qEnc);
  const fx = fixtureFor(engine, query);
  const body = fx ? fx.raw : (engine === 'bing' ? BENIGN_BING : BENIGN_DDG);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Install BEFORE importing the engine — module top-level code (and every
// later corsFetch arm: direct, cors.sh, jina — all carry the original URL as
// a substring) resolves through this shim. Supabase REST answers "no cache /
// lane down" so cachedLane/pageFetchViaServer fall through without network.
globalThis.fetch = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input
    : (input && typeof input === 'object' && 'url' in (input as Request))
      ? (input as Request).url
      : String(input);
  if (url.includes('/rest/v1/')) return new Response('null', { status: 200 });
  const bing = url.match(/bing\.com\/search\?q=([^&]*)/);
  if (bing) return engineResponse('bing', bing[1]);
  const ddg = url.match(/html\.duckduckgo\.com\/html\/\?q=([^&]*)/);
  if (ddg) return engineResponse('ddg', ddg[1]);
  unmatched.push(url);
  return new Response('offline harness: unrouted URL', { status: 500 });
}) as typeof fetch;

// ── Shapes + queries ──────────────────────────────────────────────────────

interface Shape { name: string; website: string; address: string; email: string; phone: string; categoryLabel?: string }

const SHAPES: Shape[] = [
  { name: 'Cafe Marco', website: 'https://www.cafemarco.ge/', address: '12a Rustaveli Ave, Tbilisi', email: '', phone: '' },
  { name: 'Aversi Clinic', website: 'https://www.aversi.ge/', address: 'Rustaveli Ave 34, Tbilisi', email: '', phone: '' },
  { name: 'Paczima Cafe', website: 'https://paczima.ge/', address: 'Shardeni St, Tbilisi', email: '', phone: '' },
];

setScanContext({ countryCode: 'GE', countryName: 'Georgia', lang: 'ka', cityNative: 'Tbilisi', cityEn: 'Tbilisi' });

// ── A/B scoring ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`fixtures: ${FIXTURES.map(f => f.file).join(', ') || '(none)'}`);

  // Dynamic import: the fetch shim must exist before engine module code runs.
  const engine = await import('./src/clientEngine.js');
  const { buildEmailQuery, buildEmailDorkQueries, searchBing, searchDDGHtml,
    harvestSnippetEmails, resetEngineHealth } = engine;

  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (ok) { pass++; console.log(`  ok  ${name}`); }
    else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
  };

  // ── structural sanity: real generators, real bounds ──
  const dorksByShape = SHAPES.map(s => buildEmailDorkQueries(s as never));
  const oldsByShape = SHAPES.map(s => buildEmailQuery(s as never));
  for (let i = 0; i < SHAPES.length; i++) {
    const host = new URL(SHAPES[i].website).hostname.replace(/^www\./, '');
    const dorks = dorksByShape[i].map(d => safeDecode(d));
    check(`dorks bounded ≤3 for ${SHAPES[i].name}`, dorks.length <= 3 && dorks.length > 0, JSON.stringify(dorks));
    check(`@host dork present for ${SHAPES[i].name}`, dorks.some(d => d.includes(`@${host}`)), JSON.stringify(dorks));
    check(`old emailQ non-empty for ${SHAPES[i].name}`, oldsByShape[i].length > 8, oldsByShape[i]);
    console.log(`  old  ${SHAPES[i].name}: ${safeDecode(oldsByShape[i])}`);
    dorks.forEach(d => console.log(`  dork ${SHAPES[i].name}: ${d}`));
  }

  // ── empty/challenge fixture self-test: production Bing parser says 0 ──
  {
    resetEngineHealth();
    const empty = FIXTURES.find(f => f.name.includes('empty') || /akchal|challenge/i.test(f.raw));
    if (empty) {
      const rs = await searchBing(encodeURIComponent(empty.name));
      check('challenge/empty SERP yields 0 results', Array.isArray(rs) && rs.length === 0, JSON.stringify(rs));
    }
  }

  // ── the A/B ──
  let anyFixtureLane = false;
  const zeroExact: string[] = [];
  for (let i = 0; i < SHAPES.length; i++) {
    const s = SHAPES[i];
    const host = new URL(s.website).hostname.replace(/^www\./, '');
    const oldQ = oldsByShape[i];
    const dorks = dorksByShape[i];

    const runLane = async (q: string): Promise<string[]> => {
      resetEngineHealth(); // isolate lanes: no cross-query engine cooldown
      // Production passes the old emailQ DECODED to Bing (Phase 3) and
      // dorks ENCODED (Phase 3b); the shim normalizes both via safeDecode.
      const bingArg = q === oldQ ? safeDecode(q) : q;
      const [bingRs, ddgRs] = await Promise.all([
        searchBing(bingArg),
        searchDDGHtml(q),
      ]);
      const snippets = [...bingRs, ...ddgRs].flatMap(r => [String(r.title || ''), String(r.snippet || '')]);
      const emails = harvestSnippetEmails(snippets, host);
      // Soft diagnostic (never fails the run): an EXACT capture exists for
      // this query and the capture contains an '@', yet the production
      // harvester scored 0 — either the page only shows unharvestable
      // addresses (gmail/…, deliberately rejected) or a parser/harvester
      // regression. Real captures make a zero legal, so report, don't gate.
      const exact = ENGINES.map(e => FIXTURES.find(f => f.engine === e && f.name === safeDecode(q)));
      if (emails.length === 0 && exact.some(f => f && f.raw.includes('@'))) zeroExact.push(safeDecode(q));
      return emails;
    };

    const oldEmails = [...new Set(await runLane(oldQ))];
    let dorkEmails: string[] = [];
    for (const dq of dorks) dorkEmails.push(...(await runLane(dq)));
    dorkEmails = [...new Set(dorkEmails)];

    if (oldEmails.length > 0 || dorkEmails.length > 0) anyFixtureLane = true;
    const gained = dorkEmails.filter(e => !oldEmails.includes(e));
    const lost = oldEmails.filter(e => !dorkEmails.includes(e));
    console.log(`  ${s.name}: old=${oldEmails.length} dorks=${dorkEmails.length} (gain=${gained.length - lost.length >= 0 ? '+' : ''}${dorkEmails.length - oldEmails.length})`
      + (gained.length ? ` new-only=[${gained.join(', ')}]` : '')
      + (lost.length ? ` old-only=[${lost.join(', ')}]` : ''));
    check(`dorks ≥ old emailQ for ${s.name}`,
      dorkEmails.length >= oldEmails.length,
      `dorks found fewer addresses than the old emailQ — do not ship`);
  }

  check('at least one lane produced email yield (fixtures wired correctly)', anyFixtureLane,
    'no fixture matched any query — check fixture filenames against the printed queries');

  if (unmatched.length > 0) {
    console.log(`  note: ${unmatched.length} unrouted fetch(es): ${[...new Set(unmatched)].slice(0, 5).join(', ')}`);
  }
  if (zeroExact.length > 0) {
    console.log(`  note: exact fixture with '@' but 0 harvested for: ${[...new Set(zeroExact)].join(' | ')}`);
  }

  console.log(`\n${pass}/${pass + fail} checks pass`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
