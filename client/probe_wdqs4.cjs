// REGEXP + correct Accept verification
(async () => {
  const UA = 'BlueOcean/6.2 (market-gap research demo)';
  const host = 'marriott.com';
  const q = 'SELECT ?itemLabel ?email ?phone WHERE { ?item wdt:P856 ?site . ' +
    'FILTER(REGEXP(STR(?site), "' + host.replace(/\./g, '\\\\.') + '")) . ' +
    'OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3';
  const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(q), {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
    signal: AbortSignal.timeout(40000),
  });
  console.log('status:', r.status);
  const d = await r.json();
  const rows = d.results?.bindings || [];
  console.log(`rows: ${rows.length}`);
  for (const row of rows) {
    console.log(`  ${row.itemLabel?.value || '?'} | email: ${row.email?.value || '-'} | phone: ${row.phone?.value || '-'} | site: ${row.site?.value || '-'}`);
  }
})();
