// v6.9.155 unit tests: PDF contact extraction (pdfjs-dist wrapper) and the
// contact-smelling PDF link picker.
// Run: npm test (tsx …)
import { looksLikePdfUrl, isPdfContentType, normalizePdfText, extractPdfText, fetchPdfTextViaBackend } from './src/pdfSkills.js';
import { pickPdfLinks } from './src/clientEngine.js';

// node shim for bare test run (tsconfig excludes test files)
declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

// ── minimal PDF builder (no dependency; enough for pdf.js to parse) ──
function buildPdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(' ');
  objs.push('<</Type/Catalog/Pages 2 0 R>>');
  objs.push(`<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`);
  pages.forEach((text, i) => {
    const contentObj = 3 + pages.length + i; // contents come after the page objects
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentObj} 0 R/Resources<</Font<</F1 5 0 R>>>>>>`);
  });
  pages.forEach((text) => {
    const stream = `BT /F1 18 Tf 60 700 Td (${text}) Tj ET`;
    objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  });
  objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

(async () => {
  // ── looksLikePdfUrl ─────────────────────────────────────────────
  eq('url: plain .pdf', looksLikePdfUrl('https://x.ge/menu.pdf'), true);
  eq('url: .pdf + query', looksLikePdfUrl('https://x.ge/menu.pdf?v=2'), true);
  eq('url: .pdf + hash', looksLikePdfUrl('https://x.ge/file.pdf#page=3'), true);
  eq('url: uppercase .PDF', looksLikePdfUrl('https://x.ge/MENU.PDF'), true);
  eq('url: not a pdf', looksLikePdfUrl('https://x.ge/about'), false);
  eq('url: .pdf in query only', looksLikePdfUrl('https://x.ge/view?f=a.pdf'), false);
  eq('url: empty', looksLikePdfUrl(''), false);
  eq('url: garbage', looksLikePdfUrl('not a url'), false);

  // ── isPdfContentType ────────────────────────────────────────────
  eq('ct: application/pdf', isPdfContentType('application/pdf'), true);
  eq('ct: x-pdf + charset', isPdfContentType('application/x-pdf; charset=binary'), true);
  eq('ct: html', isPdfContentType('text/html'), false);
  eq('ct: null', isPdfContentType(null), false);

  // ── normalizePdfText ────────────────────────────────────────────
  eq('norm: ligature ffi', normalizePdfText('o\uFB03ce'), 'office');
  eq('norm: ligature fi', normalizePdfText('con\uFB01rm'), 'confirm');
  eq('norm: @ spacing collapsed', normalizePdfText('billing @ acme .ge'), 'billing@acme .ge');
  eq('norm: whitespace runs', normalizePdfText('a   b\u00A0c\n\n\n\nd'), 'a b c\nd');
  eq('norm: empty', normalizePdfText(''), '');

  // ── extractPdfText ──────────────────────────────────────────────
  {
    const pdf = buildPdf(['Contact: info@example-cafe.ge  Call +995 322 19 66 69']);
    const text = await extractPdfText(pdf);
    eq('pdf: email recovered', text.includes('info@example-cafe.ge'), true);
    eq('pdf: phone recovered', text.includes('+995 322 19 66 69'), true);
  }
  {
    const pdf = buildPdf(['Page one: sales@acme.ge', 'Page two: hr@acme.ge']);
    const text = await extractPdfText(pdf);
    eq('pdf: multi-page joins', text.includes('sales@acme.ge') && text.includes('hr@acme.ge'), true);
  }
  {
    const pdf = buildPdf(['Page one: sales@acme.ge', 'Page two: hr@acme.ge']);
    const text = await extractPdfText(pdf, { maxPages: 1 });
    eq('pdf: maxPages cap', text.includes('sales@acme.ge') && !text.includes('hr@acme.ge'), true);
  }
  {
    const pdf = buildPdf(['x'.repeat(5000)]);
    const text = await extractPdfText(pdf, { maxChars: 1000 });
    eq('pdf: maxChars cap', text.length <= 1000, true);
  }
  eq('pdf: garbage bytes -> empty', await extractPdfText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), '');
  eq('pdf: empty bytes -> empty', await extractPdfText(new Uint8Array(0)), '');
  eq('pdf: text into validators', /info@example-cafe\.ge/.test(await extractPdfText(buildPdf(['write info@example-cafe.ge']))) , true);

  // ── pickPdfLinks ────────────────────────────────────────────────
  {
    const html = [
      '<a href="/menu.pdf">Menu</a>',
      '<a href="/contact-us.pdf">Contact us</a>',
      '<a href="/images/logo.pdf">Logo</a>',
      '<a href="/brochure.pdf">Brochure</a>',
      '<a href="https://other.com/x.pdf">Off-site</a>',
    ].join('');
    const picked = pickPdfLinks(html, 'https://cafe.ge/', 2);
    eq('pick: internal contact-smelling only', picked.length, 2);
    eq('pick: internal host', picked.every(u => u.startsWith('https://cafe.ge/')), true);
    eq('pick: excludes off-site', picked.some(u => u.includes('other.com')), false);
    eq('pick: excludes logo', picked.some(u => u.includes('logo.pdf')), false);
  }
  eq('pick: empty html', pickPdfLinks('', 'https://cafe.ge/', 2), []);

  // ── backend fallback is a safe no-op without VITE_BACKEND_URL ────
  eq('backend: disabled without env', await fetchPdfTextViaBackend('https://x.ge/a.pdf'), '');
  eq('pick: cap respected', pickPdfLinks(
    '<a href="/a-menu.pdf">m</a><a href="/b-menu.pdf">m</a><a href="/c-menu.pdf">m</a>',
    'https://cafe.ge/', 2).length, 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
