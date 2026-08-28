// Find the exact working WDQS invocation pattern
(async () => {
  const host = 'marriott.com';
  const sparql = 'SELECT ?itemLabel ?email ?phone WHERE { ?item wdt:P856 ?site . ' +
    'FILTER(STR(?site) CONTAINS "' + host + '") . ' +
    'OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3';
  const UA = 'BlueOcean/6.2 (market-gap research demo; contact@blueocean.app)';

  // Variant A: POST form + UA
  try {
    const r = await fetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'query=' + encodeURIComponent(sparql) + '&format=json',
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    console.log(`A POST+UA: ${r.status} | ${t.slice(0, 120)}`);
    if (r.ok) {
      const d = JSON.parse(t);
      for (const row of (d.results?.bindings || [])) console.log('  A:', row.itemLabel?.value, '|', row.email?.value || '-', '|', row.phone?.value || '-');
    }
  } catch (e) { console.log('A FAIL:', e.message); }

  // Variant B: GET, Accept sparql+json, no format param, UA
  try {
    const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql), {
      headers: { Accept: 'application/sparql+json', 'User-Agent': UA },
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    console.log(`B GET+UA: ${r.status} | ${t.slice(0, 120)}`);
    if (r.ok) {
      const d = JSON.parse(t);
      for (const row of (d.results?.bindings || [])) console.log('  B:', row.itemLabel?.value, '|', row.email?.value || '-', '|', row.phone?.value || '-');
    }
  } catch (e) { console.log('B FAIL:', e.message); }
})();
