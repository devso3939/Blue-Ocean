/**
 * Live probe of free/keyless services for the enrichment pipeline.
 * Tests with the same fetch patterns the browser engine would use.
 */
const targets = [
  { name: 'jina-reader', fn: () => fetch('https://r.jina.ai/https://example.com', { signal: AbortSignal.timeout(15000) }).then(r => r.text()).then(t => ({ ok: true, size: t.length, sample: t.slice(0, 80) })) },
  { name: 'allorigins-raw', fn: () => fetch('https://api.allorigins.win/raw?url=https://example.com', { signal: AbortSignal.timeout(15000) }).then(r => ({ ok: r.ok, status: r.status })) },
  { name: 'allorigins-get', fn: () => fetch('https://api.allorigins.win/get?url=https://example.com', { signal: AbortSignal.timeout(15000) }).then(r => r.json()).then(j => ({ ok: !!j.contents, size: (j.contents || '').length })) },
  { name: 'corsproxy.io', fn: () => fetch('https://corsproxy.io/?url=' + encodeURIComponent('https://example.com'), { signal: AbortSignal.timeout(15000) }).then(r => ({ ok: r.ok, status: r.status })) },
  { name: 'ddg-html', fn: () => fetch('https://html.duckduckgo.com/html/?q=hotel+genio+tbilisi+contact', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) }).then(r => r.text()).then(t => ({ ok: t.includes('result'), size: t.length, hasResults: /result__a/.test(t) })) },
  { name: 'ddg-lite', fn: () => fetch('https://lite.duckduckgo.com/lite/?q=hotel+genio+tbilisi', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) }).then(r => r.text()).then(t => ({ ok: r => r, size: t.length, hasResults: /result-link/.test(t) })) },
  { name: 'mojeek', fn: () => fetch('https://www.mojeek.com/search?q=hotel+genio+tbilisi', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) }).then(r => r.text()).then(t => ({ ok: true, size: t.length, hasResults: /results/.test(t) })) },
  { name: 'wayback', fn: () => fetch('https://archive.org/wayback/available?url=genio.ge', { signal: AbortSignal.timeout(15000) }).then(r => r.json()).then(j => ({ ok: !!(j.archived_snapshots && j.archived_snapshots.closest), snapshot: j.archived_snapshots?.closest?.url || null })) },
  { name: 'wikidata-sparql', fn: () => fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent('SELECT ?x WHERE { ?x wdt:P31 wd:Q5 } LIMIT 1'), { headers: { Accept: 'application/sparql+json', 'User-Agent': 'BlueOcean/6.2' }, signal: AbortSignal.timeout(15000) }).then(r => ({ ok: r.ok, status: r.status })) },
];

(async () => {
  for (const t of targets) {
    try {
      const res = await t.fn();
      console.log(`UP    ${t.name}: ${JSON.stringify(res).slice(0, 110)}`);
    } catch (e) {
      console.log(`DOWN  ${t.name}: ${(e && e.message || e).slice(0, 90)}`);
    }
  }
})();
