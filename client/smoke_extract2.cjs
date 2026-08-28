// Advanced extraction smoke: real-world obfuscation patterns
const { __internals } = require('./parsertest.cjs');
const ex = __internals.extractFromHtml;
let pass = 0, fail = 0;
function run(name, html, expect) {
  const b = { name: 'X', email: '', phone: '', facebook: '', instagram: '', website: '', twitter: '', pinterest: '', rating: undefined, reviewCount: undefined };
  try { ex(html, b); } catch (e) { console.log(`FAIL ${name}: threw ${e.message}`); fail++; return; }
  let ok = true;
  for (const [k, v] of Object.entries(expect)) {
    const got = b[k];
    const good = typeof v === 'function' ? v(got) : got === v;
    if (!good) { console.log(`FAIL ${name}: expected ${k}=${JSON.stringify(v)} got ${JSON.stringify(got)}`); ok = false; }
  }
  if (ok) { console.log(`ok   ${name}`); pass++; } else fail++;
}

// 1. Cloudflare-encoded email (data-cfemail)
// 'info@hadirka.ge' encoded with key 0x5c: [0x5c, ...xor bytes] -> hex string
function cfEncode(email, key) {
  const bytes = [key];
  for (const ch of Buffer.from(email, 'utf8')) bytes.push(ch ^ key);
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}
const cfHex = cfEncode('info@hadirka.ge', 0x5c);
run('cloudflare-email', `<a href="/cdn-cgi/l/email-protection#${cfHex}" data-cfemail="${cfHex}">[email&#160;protected]</a>`, { email: 'info@hadirka.ge' });

// 2. JSON-LD structured data
run('jsonld-email', `<script type="application/ld+json">{"@type":"LocalBusiness","email":"contact@piazza.it","telephone":"+995 322 55 12 34"}</script>`, { email: 'contact@piazza.it' });

// 3. tel: link
run('tel-link', `<a href="tel:+995322987654">Call</a>`, { phone: '+995322987654' });

// 4. HTML entity @
run('entity-email', `<span>office&#64;paradise.ge</span>`, { email: 'office@paradise.ge' });

// 5. mailto
run('mailto', `<a href="mailto:booking@rooms.ge?subject=hello">mail</a>`, { email: 'booking@rooms.ge' });

// 6. labeled phone
run('labeled-phone', `<div>Tel: +995 599 12 34 56</div>`, { phone: (p) => p && p.replace(/\D/g, '').endsWith('123456') });

// 7. facebook + instagram
run('socials', `<a href="https://www.facebook.com/marriott.tbilisi">f</a><a href="https://instagram.com/purarchil">i</a>`, {
  facebook: 'https://facebook.com/marriott.tbilisi',
  instagram: 'https://instagram.com/purarchil',
});

// 8. rating + review count from JSON-LD-ish markup
run('rating', `<div itemscope><meta itemprop="ratingValue" content="4.6">1,240 reviews</div>`, {
  rating: 4.6,
  reviewCount: 1240,
});

// 9. junk filtering: no email from google/privacy pages
run('junk-filter', `<a href="mailto:noreply@google.com">x</a><span>privacy policy</span>`, { email: '' });

// 10. website extraction picks real domain, skips socials/dirs
run('website-pick', `<a href="https://www.facebook.com/x">f</a><a href="https://rooms-hotels.com/ka">site</a>`, { website: 'https://rooms-hotels.com/ka' });

// 11-14. real-world junk seen in live run: dates, IPs, timestamps, file emails
run('date-not-phone', `<div>Last updated 2026-06-11</div><span>Tel: +995 322 74 74 74</span>`, { phone: (p) => !p.includes('2026') && p.includes('995') });
run('ip-not-phone', `<div>Server 23.58.223.22</div><span>Phone +995 32 215 88 88</span>`, { phone: (p) => !p.startsWith('23.58') && p.includes('995') });
run('timestamp-not-phone', `<div>id=1787851477009</div><span>Tel: +995599112233</span>`, { phone: (p) => !p.includes('1787851') && p.includes('995') });
run('image-not-email', `<img src="logo-ka@2x.png"><a href="mailto:info@libertybank.ge">mail</a>`, { email: 'info@libertybank.ge' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
