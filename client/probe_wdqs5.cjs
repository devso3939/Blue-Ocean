// Get FULL error body + try STRSTARTS variant
(async () => {
  const UA = 'BlueOcean/6.2 (market-gap research demo)';
  const tests = {
    regexp: 'SELECT ?item ?email ?phone WHERE { ?item wdt:P856 ?site . FILTER(REGEXP(STR(?site), "marriott")) . OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3',
    strstarts: 'SELECT ?item ?email ?phone WHERE { ?item wdt:P856 ?site . FILTER(STRSTARTS(STR(?site), "https://www.marriott.com")) . OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3',
  };
  for (const [name, q] of Object.entries(tests)) {
    const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(q), {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
      signal: AbortSignal.timeout(40000),
    });
    const t = await r.text();
    console.log(`== ${name}: ${r.status}`);
    if (r.ok) {
      const d = JSON.parse(t);
      console.log(`rows: ${d.results?.bindings?.length || 0}`);
      for (const row of (d.results?.bindings || []).slice(0, 3)) {
        console.log(`  ${row.item?.value} | email: ${row.email?.value || '-'} | phone: ${row.phone?.value || '-'} | site: ${row.site?.value || '-'}`);
      }
    } else {
      const idx = t.indexOf('MalformedQueryException');
      console.log(t.slice(Math.max(0, idx - 50), idx + 200) || t.slice(0, 250));
    }
  }
})();
