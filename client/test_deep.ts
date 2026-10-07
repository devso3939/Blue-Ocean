// v6.9.149 unit tests: deep skills — microformats h-card, OG-complete gate,
// sameAs sweep, MX probe behavior
// Run: npm test (tsx …)
import { readMicroformats, ogContactGate, sweepSameAs } from './src/deepSkills.js';

// node shim for bare test run (tsconfig excludes test files)
declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const wrap = (inner: string) => '<!doctype html><html><body>' + inner + '</body></html>';

// ── readMicroformats: h-card with v2 classes ─────────────────────

{
  const html = wrap('<div class="h-card"><span class="p-name">Cafe Orient</span><a class="u-email" href="mailto:info@orient.ge">mail</a><a class="u-url" href="/contact">site</a><span class="p-tel">+995 322 19 66 69</span></div>');
  const mc = readMicroformats(html, 'https://orient.ge/');
  eq('h-card: name', mc?.name, 'Cafe Orient');
  eq('h-card: email (mailto stripped)', mc?.email, 'info@orient.ge');
  eq('h-card: url resolved', mc?.url, 'https://orient.ge/contact');
  eq('h-card: tel', mc?.tel, '+995 322 19 66 69');
}

// ── readMicroformats: v1 vcard back-compat ───────────────────────

{
  const html = wrap('<div class="vcard"><span class="fn">Bar Tbilisi</span><a class="email" href="mailto:hi@bar.ge">e</a></div>');
  const mc = readMicroformats(html, 'https://bar.ge/');
  eq('v1 vcard: name via fn', mc?.name, 'Bar Tbilisi');
  eq('v1 vcard: email', mc?.email, 'hi@bar.ge');
}

// ── readMicroformats: nested h-adr ───────────────────────────────

{
  const html = wrap('<div class="h-card"><span class="p-name">Orient</span><span class="p-adr h-adr"><span class="p-street-address">12 Rustaveli Ave</span>, <span class="p-locality">Tbilisi</span></span></div>');
  const mc = readMicroformats(html, 'https://orient.ge/');
  eq('nested h-adr: street', mc?.street, '12 Rustaveli Ave');
  eq('nested h-adr: locality', mc?.locality, 'Tbilisi');
}

// ── readMicroformats: no card → null ─────────────────────────────

eq('no microformats → null', readMicroformats(wrap('<p>plain cafe page</p>'), 'https://x.ge/'), null);
eq('empty html → null', readMicroformats('', 'https://x.ge/'), null);

// ── ogContactGate: the page whose ONLY surface is meta ───────────

{
  const html = '<!doctype html><html><head><meta property="og:email" content="info@metaonly.ge"><meta property="og:phone_number" content="+995555123456"></head><body><p>Contact us by phone or mail.</p></body></html>';
  eq('og-only: gate opens', ogContactGate(html), true);
}
{
  // mailto present → close (engine's mailto layer covers it)
  const html = '<!doctype html><html><head><meta property="og:email" content="info@x.ge"></head><body><a href="mailto:info@x.ge">mail</a></body></html>';
  eq('og-only: mailto closes gate', ogContactGate(html), false);
}
{
  // visible email in body → close
  const html = '<!doctype html><html><head><meta property="og:email" content="info@x.ge"></head><body><p>Reach us at info@x.ge today</p></body></html>';
  eq('og-only: visible @ closes gate', ogContactGate(html), false);
}
eq('og-only: no meta → gate closed', ogContactGate(wrap('<p>hello</p>')), false);

// ── sweepSameAs: the four fields the walker skipped ──────────────

{
  const html = '<script type="application/ld+json">{"@graph":[{"@type":"LocalBusiness","sameAs":["https://www.facebook.com/orientge","https://www.instagram.com/orientge","https://tiktok.com/@orientge","https://www.linkedin.com/company/orient-ge","https://www.youtube.com/@orientge","https://x.com/orientge"]}]}</script>';
  const s = sweepSameAs(html);
  eq('sameAs: tiktok', s.tiktok, 'https://tiktok.com/@orientge');
  eq('sameAs: linkedin', s.linkedin, 'https://www.linkedin.com/company/orient-ge');
  eq('sameAs: youtube', s.youtube, 'https://www.youtube.com/@orientge');
  eq('sameAs: x.com', s.twitter, 'https://x.com/orientge');
}
{
  // flat sameAs (no @graph)
  const html = '<script type="application/ld+json">{"sameAs":["https://linkedin.com/company/acme"]}</script>';
  eq('sameAs: flat company', sweepSameAs(html).linkedin, 'https://linkedin.com/company/acme');
}
{
  // no sameAs key
  eq('sameAs: absent → {}', sweepSameAs(wrap('<script type="application/ld+json">{"@type":"Cafe"}</script>')), {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
