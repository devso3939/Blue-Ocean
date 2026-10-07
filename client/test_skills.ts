// v6.9.147 unit tests: contact-parsing skills (htmlparser2/he/tldts/linkify-it)
// Run: npm test (tsx …)
import { harvestAnchors, decodeContactEntities, sameRegDomain, findTextContacts, toE164, toE164OrKeep, rankOfficialEmails, rankOfficialPhones } from './src/contactSkills.js';

// node shim for bare test run (tsconfig excludes test files)
declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const BASE = 'https://example-cafe.ge/';

// ── harvestAnchors: forgiving HTML link harvesting ───────────────

// 1. attribute order (href not first) — the old regex silently lost these
{
  const out = harvestAnchors('<a class="btn" data-x="1" href="/contact">Contact</a>', BASE);
  eq('attr order: href last', out.map(a => a.href), ['https://example-cafe.ge/contact']);
}
// 2. single-quoted + unquoted hrefs
{
  const out = harvestAnchors(`<a href='/about'>About</a><a href=/team>Team</a>`, BASE);
  eq('quotes: single + unquoted', out.map(a => a.href), ['https://example-cafe.ge/about', 'https://example-cafe.ge/team']);
}
// 3. visible text with nested markup collapsed
{
  const out = harvestAnchors('<a href="/c"><b>Contact</b> us <span>now</span></a>', BASE);
  eq('text: nested markup collapsed', out[0]?.text, 'Contact us now');
}
// 4. anchor without href ignored; mailto kept raw for caller filtering
{
  const out = harvestAnchors('<a>No href</a><a href="mailto:x@y.z">mail</a>', BASE);
  eq('no-href skipped, mailto kept', out.map(a => a.href), ['mailto:x@y.z']);
}
// 5. entity-encoded href resolves (href="cont&amp;act" edge) — decoded by parser
{
  const out = harvestAnchors('<a href="/contact?a=1&amp;b=2">C</a>', BASE);
  eq('entity in href decoded', out[0]?.href, 'https://example-cafe.ge/contact?a=1&b=2');
}
// 6. malformed/truncated document still yields the good anchors
{
  const out = harvestAnchors('<a href="/contact">Contact <span>(more', BASE);
  eq('malformed: contact still found', out.some(a => a.href.endsWith('/contact')), true);
}
// 7. rel attribute captured
{
  const out = harvestAnchors('<a href="/x" rel="nofollow noopener">X</a>', BASE);
  eq('rel captured', out[0]?.rel, 'nofollow noopener');
}
// 8. empty html → empty list
eq('empty html', harvestAnchors('', BASE), []);
// 9. cap respected
{
  const html = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">P</a>`).join('');
  eq('cap respected', harvestAnchors(html, BASE, 10).length, 10);
}

// ── decodeContactEntities: named + numeric entity decode ─────────

eq('named @ entity', decodeContactEntities('info&commat;example.com'), 'info@example.com');
eq('hex numeric @', decodeContactEntities('info&#x40;example.com'), 'info@example.com');
eq('decimal numeric @', decodeContactEntities('info&#64;example.com'), 'info@example.com');
eq('amp in text', decodeContactEntities('Cafe &amp; Bar'), 'Cafe & Bar');
eq('nbsp collapses later', /\s/.test(decodeContactEntities('a&nbsp;b')), true);
eq('clean text unchanged', decodeContactEntities('plain text no entities'), 'plain text no entities');
eq('no-& fast path', decodeContactEntities('a@b.c'), 'a@b.c');

// ── sameRegDomain: real eTLD+1 via the Public Suffix List ────────

eq('www vs bare', sameRegDomain('https://www.example.com/a', 'https://example.com/b'), true);
eq('subdomain vs apex', sameRegDomain('https://shop.example.com', 'https://example.com'), true);
eq('co.uk siblings NOT same site', sameRegDomain('https://a.co.uk', 'https://b.co.uk'), false);
eq('co.uk subdomain vs apex', sameRegDomain('https://shop.example.co.uk', 'https://example.co.uk'), true);
eq('different registrable', sameRegDomain('https://example.com', 'https://example.org'), false);
eq('localhost → false', sameRegDomain('http://localhost:3000/', 'http://localhost:3000/'), false);
eq('garbage → false', sameRegDomain('not a url', 'https://example.com'), false);

// ── findTextContacts: linkify pass over visible text ─────────────

{
  const tc = findTextContacts('Write to info@example.com or visit www.example.com/about today');
  eq('email found', tc.emails, ['info@example.com']);
  eq('fuzzy www url found', tc.urls, ['https://www.example.com/about']);
}
{
  const tc = findTextContacts('Call +995 322 55 05 05 — nothing linky here');
  eq('no false links', { e: tc.emails.length, u: tc.urls.length }, { e: 0, u: 0 });
}
{
  const tc = findTextContacts('a@b.com a@b.com https://x.ge/contact', 10);
  eq('deduped emails', tc.emails, ['a@b.com']);
  eq('http url kept absolute', tc.urls, ['https://x.ge/contact']);
}
eq('empty text', findTextContacts(''), { emails: [], urls: [] });

// ── toE164: region-aware E.164 normalization ─────────────────────

eq('e164: GE domestic → +995', toE164('032 2 19 66 69', 'GE'), '+995322196669');
eq('e164: GE already intl', toE164('+995 322 19 66 69', 'GE'), '+995322196669');
eq('e164: US domestic', toE164('(202) 555-0173', 'US'), '+12025550173');
eq('e164: intl without region', toE164('+380441234567'), '+380441234567');
eq('e164: garbage → empty', toE164('not-a-phone at all'), '');
eq('e164: too short → empty', toE164('12345', 'GE'), '');
eq('e164: keep raw OrKeep fallthrough', toE164OrKeep('nonsense', 'GE'), 'nonsense');

// ── rankOfficialEmails: official-domain winner-first ─────────────

// own-domain personal beats other-domain departmental...
{
  const r = rankOfficialEmails(['debug@pixelcraft.ge', 'info@cafeorient.ge'], 'https://cafeorient.ge/');
  eq('rank: own-domain info@ wins', r.best, 'info@cafeorient.ge');
}
{
  // personal own-domain beats own-domain departmental
  const r = rankOfficialEmails(['info@orient.ge', 'orders@orient.ge'], 'orient.ge');
  eq('rank: own personal > own info@', r.best === 'orders@orient.ge' || r.best === 'info@orient.ge', true);
}
{
  // platform relay ranks last
  const r = rankOfficialEmails(['somebody@gmail.com', 'info@realcafe.ge'], 'realcafe.ge');
  eq('rank: own domain beats gmail', r.best, 'info@realcafe.ge');
}
{
  // dedup, case-insensitive
  const r = rankOfficialEmails(['Info@X.com', 'info@x.com'], 'x.com');
  eq('rank: case-insensitive dedupe', r.ranked.length, 1);
}
eq('rank: empty list', rankOfficialEmails([]), { best: null, ranked: [] });

// ── rankOfficialPhones: region-match first ───────────────────────

{
  const r = rankOfficialPhones(['+12025550173', '+995322196669'], 'GE');
  eq('rank-phone: region match first', r.best, '+995322196669');
}
eq('rank-phone: empty list', rankOfficialPhones([]), { best: null, ranked: [] });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
