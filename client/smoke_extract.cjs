// Smoke test for the module-level extraction function
const { __internals } = require('./parsertest.cjs');
const b = { name: 'Test Cafe', email: '', phone: '', facebook: '', instagram: '', website: '', twitter: '', pinterest: '' };
const html = '<html><head></head><body>'
  + '<div class="contact"><a href="mailto:info@testcafe.ge">mail</a> Call +995 322 12 34 56</div>'
  + '<a href="https://facebook.com/testcafe">fb</a>'
  + '<a href="https://instagram.com/testcafe.tbi">ig</a>'
  + '</body></html>';
__internals.extractFromHtml(html, b);
console.log(JSON.stringify(b, null, 1));
const ok = b.email === 'info@testcafe.ge' && b.phone.includes('995') && b.facebook && b.instagram;
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
