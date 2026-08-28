// Standalone verification of the new keyless passes (same logic as engine)
(async () => {
  // 1. Wikidata SPARQL — real query: find email/phone for a hotel domain
  const host = 'marriott.com';
  const sparql = 'SELECT ?itemLabel ?email ?phone WHERE { ?item wdt:P856 ?site . ' +
    'FILTER(STR(?site) CONTAINS "' + host + '") . ' +
    'OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3';
  try {
    const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql) + '&format=json', {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BlueOcean/6.2 (market-gap research demo)' },
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    const rows = d?.results?.bindings || [];
    console.log(`WIKIDATA: ${rows.length} rows for ${host}`);
    for (const row of rows) {
      console.log(`  ${row.itemLabel?.value || '?'} | email: ${row.email?.value || '-'} | phone: ${row.phone?.value || '-'}`);
    }
  } catch (e) { console.log('WIKIDATA FAIL:', e.message); }

  // 2. Wayback — dead-site recovery path
  try {
    const av = await fetch('https://archive.org/wayback/available?url=' + encodeURIComponent('https://www.hadirka.ge'), { signal: AbortSignal.timeout(15000) });
    const j = await av.json();
    const snap = j?.archived_snapshots?.closest;
    console.log(`WAYBACK: available=${snap?.available} url=${(snap?.url || 'none').slice(0, 70)}`);
    if (snap?.url) {
      const r = await fetch(snap.url, { signal: AbortSignal.timeout(20000) });
      const html = await r.text();
      const email = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const tel = html.match(/href="tel:([^"]+)"/);
      console.log(`  snapshot ${r.status}, ${(html.length / 1024).toFixed(0)}KB, email found: ${email ? email[0] : 'none'}, tel found: ${tel ? 'yes' : 'no'}`);
    }
  } catch (e) { console.log('WAYBACK FAIL:', e.message); }
})();
