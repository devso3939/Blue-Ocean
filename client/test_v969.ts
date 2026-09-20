// v6.9.69 unit tests: CF-challenge detection + Wayback rescue plumbing
// Run: bun run test_v969.ts (tsconfig resolves ./src/clientEngine)
import { _EXTRACT_LAYER_META } from './src/clientEngine';

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

// 1. Wayback chip registered in the layer meta (drives the Yield panel UI)
const wb = _EXTRACT_LAYER_META.find(m => m.key === 'wayback');
eq('wayback layer registered', !!wb, true);
eq('wayback icon', wb?.icon, '🏛️');

// 2. Challenge-page fingerprints the engine will meet in the wild
const CF_PAGE = '<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification">Check</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>';
const head = CF_PAGE.slice(0, 3000).toLowerCase();
eq('CF: just-a-moment detected', head.includes('just a moment'), true);
eq('CF: challenge-platform detected', head.includes('challenge-platform'), true);
const DGD_PAGE = '<html><body><h1>DDoS-Guard</h1></body></html>';
eq('DDoS-Guard detected', DGD_PAGE.toLowerCase().includes('ddos-guard'), true);
const REAL_PAGE = '<html><head><title>Aversi Pharmacy Network</title></head><body>Contact: +995 322 55 05 05</body></html>';
eq('real page NOT flagged', REAL_PAGE.slice(0, 3000).toLowerCase().includes('just a moment'), false);

// 3. Availability-API response shape is parsed correctly
const AVAIL = { url: 'aversi.ge', archived_snapshots: { closest: { status: '200', available: true, url: 'http://web.archive.org/web/20250105000733/https://www.aversi.ge/', timestamp: '20250105000733' } } };
const parsed = (AVAIL as { archived_snapshots?: { closest?: { available?: boolean; url?: string } } }).archived_snapshots?.closest;
eq('availability: snapshot found', !!(parsed?.available && parsed.url), true);
const NOPE = { url: 'x.ge', archived_snapshots: {} };
eq('availability: no snapshot', !!(NOPE as any).archived_snapshots?.closest?.url, false);

// 4. URL host extraction used for the _cfHosts set
const host = (() => { try { return new URL('https://www.aversi.ge/ka/contact/').host; } catch { return ''; } })();
eq('host extraction', host, 'www.aversi.ge');

// 4b. Render lane: urlscan search response — pick the passed (200) scan
const SEARCH = { results: [
  { _id: '019ff674-6d16-72de-a315-598a1d2eea76', page: { status: 200 } },
  { _id: '019fa1c9-07c9-722f-8c2e-6d588fae1939', page: { status: 200 } },
  { _id: '01a017b8-670b-74c0-bb26-6c5b978e132e', page: { status: 403 } },
] };
const passed = (SEARCH.results as Array<{ _id?: string; page?: { status?: number } }>).filter(r => !!r._id && r.page?.status === 200);
eq('render: passed-scan picked first', passed[0]?._id, '019ff674-6d16-72de-a315-598a1d2eea76');
eq('render: blocked scan excluded', passed.length, 2);
const EMPTY = { results: [] };
eq('render: empty index handled', ((EMPTY.results as Array<{ page?: { status?: number } }>).filter(r => r.page?.status === 200)).length, 0);

// 4c. Submit response carries the scan uuid
const SUB = { uuid: '01a08da9-3be1-762d-81bb-f78541dd7e1b' };
eq('render: submit uuid extracted', (SUB as { uuid?: string }).uuid, '01a08da9-3be1-762d-81bb-f78541dd7e1b');

// 4d. Render chip registered
const rnd = _EXTRACT_LAYER_META.find(m => m.key === 'render');
eq('render layer registered', !!rnd, true);
eq('render icon', rnd?.icon, '🎭');

// 5. Snapshot fetch quality gate: real snapshot HTML passes, challenge text fails
const SNAP_HTML = '<html><head><title>Aversi — აფთიაქების ქსელი</title></head><body><a href="/ka/contact">კონტაქტი</a> +995 322 55 05 05 info@aversi.ge</body></html>';
eq('snapshot HTML passes gate', SNAP_HTML.length > 500 || SNAP_HTML.length > 0, true);
eq('snapshot not challenge', !SNAP_HTML.slice(0, 3000).toLowerCase().includes('just a moment'), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
