// v6.9.66 unit tests: Octoparse-style contact-page link discovery
// Run: npm test (tsx …) — guards scoreContactLinks, which since v6.9.147
// harvests anchors through htmlparser2 instead of a regex.
import { scoreContactLinks } from './src/clientEngine.js';

// node shim for bare test run (tsconfig excludes test files)
declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.log('FAIL', name, detail ?? ''); }
}

const BASE = 'https://example-cafe.ge/';

// T1: /contact-us/ — the slug the hardcoded list never guesses
{
  const html = `<a href="/contact-us/">Contact Us</a><a href="/menu/">Menu</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T1 /contact-us/ discovered', out.some(u => u.includes('/contact-us')), JSON.stringify(out));
}

// T2: Georgian anchor text (კონტაქტი)
{
  const html = `<a href="/ka/gverdi">კონტაქტი</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T2 Georgian anchor discovered', out.length > 0, JSON.stringify(out));
}

// T3: social links excluded
{
  const html = `<a href="https://facebook.com/somepage">FB</a><a href="/contact">Contact</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T3 social excluded', out.every(u => !u.includes('facebook.com')), JSON.stringify(out));
}

// T4: external domains excluded (stay within domain)
{
  const html = `<a href="https://other-site.com/contact">Contact</a><a href="/contact">Contact</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T4 external excluded', out.every(u => u.includes('example-cafe.ge')), JSON.stringify(out));
}

// T5: asset links excluded
{
  const html = `<a href="/contact.pdf">Contact</a><a href="/contact">Contact</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T5 asset excluded', out.length === 1 && out[0].endsWith('/contact'), JSON.stringify(out));
}

// T6: dedup — same page linked twice yields once
{
  const html = `<a href="/contact">Contact</a><a href="/contact/">Contact</a><a href="/contact#map">Contact</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T6 dedup', out.length === 1, JSON.stringify(out));
}

// T7: homepage never returned
{
  const html = `<a href="/">Home</a><a href="/contact">Contact</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T7 home excluded', out.every(u => !/example-cafe\.ge\/?$/.test(u)), JSON.stringify(out));
}

// T8: capped at 3
{
  const links = ['/contact', '/contact-us', '/kontakti', '/about-us', '/locations', '/team'].map(p => `<a href="${p}">Contact</a>`).join('');
  const out = scoreContactLinks(links, BASE);
  check('T8 cap 3', out.length === 3, JSON.stringify(out));
}

// T9: low-relevance links below threshold not returned
{
  const html = `<a href="/menu">Menu</a><a href="/gallery">Gallery</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T9 below threshold', out.length === 0, JSON.stringify(out));
}

// T10: branch/location page discovered
{
  const html = `<a href="/branches/vake">Our Branches</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T10 branch discovered', out.some(u => u.includes('/branches/')), JSON.stringify(out));
}

// T11: relative + absolute same-domain both resolved
{
  const html = `<a href="/contact">C</a><a href="https://www.example-cafe.ge/contact-us">CU</a>`;
  const out = scoreContactLinks(html, BASE);
  check('T11 both resolved', out.length === 2, JSON.stringify(out));
}

// T12: malformed HTML tolerated
{
  const html = `<a href="/contact">Contact <span>(more</span>`;
  const out = scoreContactLinks(html, BASE);
  check('T12 malformed tolerated', out.length >= 0, JSON.stringify(out));
}

console.log(`\n${pass}/${pass + fail} tests pass`);
if (fail > 0) process.exit(1);
