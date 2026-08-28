// Verify the POST-form fix against real WDQS
(async () => {
  const host = 'marriott.com';
  const sparql = 'SELECT ?itemLabel ?email ?phone WHERE { ?item wdt:P856 ?site . ' +
    'FILTER(STR(?site) CONTAINS "' + host + '") . ' +
    'OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3';
  const r = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'query=' + encodeURIComponent(sparql) + '&format=json',
    signal: AbortSignal.timeout(30000),
  });
  console.log('status:', r.status);
  const d = await r.json();
  const rows = d?.results?.bindings || [];
  console.log(`rows: ${rows.length}`);
  for (const row of rows) {
    console.log(`  ${row.itemLabel?.value || '?'} | email: ${row.email?.value || '-'} | phone: ${row.phone?.value || '-'}`);
  }
})();
