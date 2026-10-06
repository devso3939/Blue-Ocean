// Extraction-quality fixtures — v6.9.130 deep-analysis regressions.
// Each case runs the engine's ACTUAL extractor/validators (via the
// __parsertest bundle), so a pass here means the shipped code behaves right.
//
// Cases marked BEFORE-FAIL encode a concrete weakness found in the audit:
//   * tel:/label/JSON-LD paths fed bare local numbers (0322196669) to the
//     STRICT plausiblePhone gate, which discards naked digit runs — the most
//     reliable source on a page silently yielded nothing.
//   * tel: URIs with RFC3966 ";ext=" leaked the extension digits into the
//     number (…6669;ext=1 → …66691).
//   * emails were first-match-wins: a footer credit (design@pixelcraft.ge)
//     beat the page's own-host contact address even when the page declared
//     canonical https://cafeorient.ge/.
//   * numeric-entity-obfuscated addresses (&#105;&#110;fo&#64;…) were
//     truncated to a WRONG local part (fo@…) by the unanchored &#64; regex.
//   * jslit/obfusc/dataattr layers never called plausibleEmail, so
//     CSS-class debris (wp-block@est-posts.is) became a stored email.
//   * website = FIRST qualifying anchor (designer credit won); PDF links and
//     tracking-param URLs were stored as-is; relative hrefs were invisible.
//   * _EMAIL_TLDS whitelist missed real trade gTLDs (.plumbing etc.) and
//     _EMAIL_PLATFORM_RE rejected research.com as "search.com".
process.env.SMOKE_ONLY = '1';
const { __internals, plausibleEmail, isLikelyBusinessWebsite } = require('./parsertest.cjs');
const ex = __internals.extractFromHtml;

let pass = 0, fail = 0;
function run(name, html, expect, opts) {
  const b = Object.assign({
    name: (opts && opts.name) || 'X', email: '', phone: '', facebook: '', instagram: '',
    website: '', twitter: '', pinterest: '', rating: undefined, reviewCount: undefined,
  }, (opts && opts.b) || {});
  try { ex(html, b, opts && opts.baseUrl); }
  catch (e) { console.log(`FAIL ${name}: threw ${e.message}`); fail++; return; }
  let ok = true;
  for (const [k, v] of Object.entries(expect)) {
    const got = b[k];
    const good = typeof v === 'function' ? v(got) : got === v;
    if (!good) { console.log(`FAIL ${name}: expected ${k}=${JSON.stringify(v)} got ${JSON.stringify(got)}`); ok = false; }
  }
  if (ok) { console.log(`ok   ${name}`); pass++; } else fail++;
}
function vrun(name, fn) {
  try {
    if (fn()) { console.log(`ok   ${name}`); pass++; }
    else { console.log(`FAIL ${name}`); fail++; }
  } catch (e) { console.log(`FAIL ${name}: threw ${e.message}`); fail++; }
}

// ── Phones: structured sources accept bare local numbers ─────────────────
run('tel-bare-local', `<a href="tel:0322196669">Call</a>`, { phone: '0322196669' });
run('tel-rfc-ext', `<a href="tel:+995322196669;ext=1">Call</a>`, { phone: '+995322196669' });
run('labeled-bare-local', `<div>Phone: 0322196669</div>`, { phone: '0322196669' });
run('jsonld-bare-local', `<script type="application/ld+json">{"@type":"Restaurant","telephone":"0322196669"}</script>`, { phone: '0322196669' });
// …but dates after labels stay rejected (lenient gate must not open this door)
run('labeled-date-still-rejected', `<div>Phone: 2026-06-11</div>`, { phone: '' });

// ── Emails: ranking, entity decoding, cross-layer validation ─────────────
run('email-host-preferred', [
  '<html><head><link rel="canonical" href="https://cafeorient.ge/"></head><body>',
  '<footer><p>Site by Pixelcraft — design@pixelcraft.ge</p></footer>',
  '<main><p>For reservations write to info@cafeorient.ge</p></main>',
  '</body></html>',
].join(''), { email: 'info@cafeorient.ge' }, { name: 'Cafe Orient' });

run('email-numeric-entity', `<span>&#105;&#110;fo&#64;orient.ge</span>`, { email: 'info@orient.ge' });

run('jslit-css-debris-rejected', `<script>var mail = "wp-block@est-posts.is";</script>`, { email: '' });

// ── Validators: TLD whitelist + platform-domain boundary ─────────────────
vrun('tld-plumbing-valid', () => plausibleEmail('sales@plumbfix.plumbing') === true);
vrun('tld-cleaning-valid', () => plausibleEmail('book@sparkle.cleaning') === true);
vrun('tld-agency-still-valid', () => plausibleEmail('hi@studio-nino.agency') === true);
vrun('css-debris-tld-invalid', () => plausibleEmail('wp-block@est-posts.is') === false);
vrun('primary-tld-invalid', () => plausibleEmail('info@x.primary') === false);
vrun('research-com-valid', () => plausibleEmail('contact@research.com') === true);
vrun('duckduckgo-invalid', () => plausibleEmail('info@duckduckgo.com') === false);
vrun('sub-platform-invalid', () => plausibleEmail('info@sub.duckduckgo.com') === false);
vrun('noreply-invalid', () => plausibleEmail('noreply@a.ge') === false);

// ── v6.9.131: live-harness regressions (found by running old vs new code
// against the 60 real targets back-to-back) ───────────────────────────────
// 1. Radisson: the own-domain upgrade swapped the property's operational
//    address for the corporate footer's data-protection desk.
run('email-upgrade-skips-dp-desk', [
  '<html><head><link rel="canonical" href="https://radissonhotels.com/en-us/hotels/radisson-blu-tbilisi"></head><body>',
  '<script type="application/ld+json">{"@type":"Hotel","email":"tbilisi.ots@radissonblu.com"}</script>',
  '<footer>Privacy enquiries: dataprotection@radissonhotels.com</footer>',
  '</body></html>',
].join(''), { email: 'tbilisi.ots@radissonblu.com' }, { name: 'Radisson Blu Iveria Hotel' });
// 2. Holiday Inn homepage: bare YYYYMMDD+seq stamp captured as a phone.
run('phone-bare-date-stamp-rejected', `<div>Phone: 202511190001</div>`, { phone: '' });
// 3. Hotel Genio: bare 15-digit order/IMSI-like run captured as a phone.
run('phone-15-digit-id-rejected', `<script type="application/ld+json">{"@type":"Hotel","telephone":"274486543027357"}</script>`, { phone: '' });
// 4. Guard against overreach: bare 10-digit numbers (US area codes start
//    year-looking prefixes) must survive the new date-stamp rule.
run('phone-bare-10-keeps-working', `<a href="tel:2025051515">Call</a>`, { phone: '2025051515' });

// ── v6.9.132: baseUrl guard — only the business's OWN site may supply a
// base for relative-href resolution and own-host ranking ───────────────────
const osb = __internals.ownSiteBase;
vrun('ownsite-base-same-host-www', () => osb('https://www.cafe.ge/contact', { website: 'https://cafe.ge/' }) === 'https://www.cafe.ge/contact');
vrun('ownsite-base-foreign-host', () => osb('https://directory.com/contact', { website: 'https://cafe.ge/' }) === undefined);
vrun('ownsite-base-no-website', () => osb('https://cafe.ge/', { website: '' }) === undefined);
vrun('ownsite-base-invalid-url', () => osb('not a url', { website: 'https://cafe.ge/' }) === undefined);

// ── Websites: ranking over first-match, hygiene, base URL ────────────────
run('website-canonical-beats-first', [
  '<html><head><link rel="canonical" href="https://cafeorient.ge/"></head><body>',
  '<a href="https://pixelcraft.ge/">Design</a>',
  '<a href="https://cafeorient.ge/reservations">Book</a>',
  '</body></html>',
].join(''), { website: 'https://cafeorient.ge/' }, { name: 'Cafe Orient' });

run('website-pdf-rejected', `<body><a href="https://cafeorient.ge/menu.pdf">Menu</a></body>`, { website: '' }, { name: 'Cafe Orient' });

run('website-utm-stripped', `<body><a href="https://cafeorient.ge/?utm_source=facebook&utm_campaign=summer&lang=en">Site</a></body>`,
  { website: 'https://cafeorient.ge/?lang=en' }, { name: 'Cafe Orient' });

run('website-relative-with-base', `<body><a href="/reservation">Book</a><a href="https://partner.ge/">Partner</a></body>`,
  { website: 'https://cafe.ge/' }, { name: 'Cafe Orient', baseUrl: 'https://cafe.ge/' });

// ── v6.9.135: business profile — hours / aggregate rating / address ──────
// BEFORE this change the module never parsed openingHours at all (hours came
// only from OSM tags), rating/reviewCount came from a loose HTML regex that
// misses integer values and "1,234"-style counts, and JSON-LD addresses were
// only read by the deep-crawl lane — never by the primary homepage scrape.
run('hours-spec-compressed', [
  '<script type="application/ld+json">{"@type":"Restaurant","openingHoursSpecification":[',
  '{"dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday"],"opens":"09:00","closes":"18:00"},',
  '{"dayOfWeek":"Saturday","opens":"10:00","closes":"14:00"}]}</script>',
].join(''), { hours: 'Mo-Fr 09:00-18:00; Sa 10:00-14:00' });

run('hours-spec-range-token',
  `<script type="application/ld+json">{"@type":"Store","openingHoursSpecification":{"dayOfWeek":"Mo-Su","opens":"10:00","closes":"22:00"}}</script>`,
  { hours: 'Mo-Su 10:00-22:00' });

run('hours-openstring-fullnames',
  `<script type="application/ld+json">{"@type":"Store","openingHours":"Monday-Friday 9am-5pm"}</script>`,
  { hours: 'Mo-Fr 9am-5pm' });

run('hours-microdata-meta',
  `<meta itemprop="openingHours" content="Tu-Su 11:00-23:00">`,
  { hours: 'Tu-Su 11:00-23:00' });

run('hours-osm-wins',
  `<script type="application/ld+json">{"openingHours":"Mo-Su 09:00-23:00"}</script>`,
  { hours: 'Mo-Su 08:00-16:00' }, { b: { hours: 'Mo-Su 08:00-16:00' } });

// structured aggregateRating beats the loose regex: "1,234" used to be
// parsed as reviewCount=1, and ratingValue:5 (integer) used to be missed.
run('jsonld-aggregate-rating',
  `<script type="application/ld+json">{"@type":"Restaurant","aggregateRating":{"ratingValue":4.7,"reviewCount":"1,234"}}</script>`,
  { rating: 4.7, reviewCount: 1234 });

run('jsonld-aggregate-integer',
  `<script type="application/ld+json">{"@type":"Cafe","aggregateRating":{"ratingValue":5,"ratingCount":87}}</script>`,
  { rating: 5, reviewCount: 87 });

run('jsonld-address-postal',
  `<script type="application/ld+json">{"@type":"LocalBusiness","address":{"streetAddress":"12 Rustaveli Ave","addressLocality":"Tbilisi","postalCode":"0108"}}</script>`,
  { address: '12 Rustaveli Ave, Tbilisi, 0108' });

run('address-osm-wins',
  `<script type="application/ld+json">{"address":{"streetAddress":"Other St"}}</script>`,
  { address: 'OSM Street, Tbilisi' }, { b: { address: 'OSM Street, Tbilisi' } });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
