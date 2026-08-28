// Binary-search the SPARQL syntax failure
(async () => {
  const UA = 'BlueOcean/6.2 (market-gap research demo)';
  const tests = {
    'minimal': 'SELECT ?s ?o WHERE { ?s wdt:P856 ?o } LIMIT 1',
    'with-filter': 'SELECT ?s ?o WHERE { ?s wdt:P856 ?o . FILTER(STR(?o) CONTAINS "marriott") } LIMIT 1',
    'full-structure': 'SELECT ?item ?email ?phone WHERE { ?item wdt:P856 ?site . FILTER(STR(?site) CONTAINS "marriott.com") . OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3',
    'no-dot-after-filter': 'SELECT ?item ?email ?phone WHERE { ?item wdt:P856 ?site . FILTER(STR(?site) CONTAINS "marriott.com") OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3',
  };
  for (const [name, q] of Object.entries(tests)) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(q), {
        headers: { Accept: 'application/sparql+json', 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      let extra = '';
      if (r.ok) {
        const d = JSON.parse(t);
        extra = `rows=${d.results?.bindings?.length || 0}`;
        for (const row of (d.results?.bindings || []).slice(0, 2)) extra += ' | ' + JSON.stringify(row).slice(0, 140);
      } else {
        extra = t.slice(t.indexOf('Exception'), t.indexOf('Exception') + 160) || t.slice(0, 160);
      }
      console.log(`${name}: ${r.status} ${extra}`);
    } catch (e) { console.log(`${name}: ERR ${e.message}`); }
    await new Promise(res => setTimeout(res, 1500));
  }
})();
