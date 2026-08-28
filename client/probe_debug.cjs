// Debug the two failures
(async () => {
  const host = 'marriott.com';
  const sparql = 'SELECT ?itemLabel ?email ?phone WHERE { ?item wdt:P856 ?site . ' +
    'FILTER(STR(?site) CONTAINS "' + host + '") . ' +
    'OPTIONAL { ?item wdt:P968 ?email } OPTIONAL { ?item wdt:P1329 ?phone } } LIMIT 3';
  try {
    const url = 'https://query.wikidata.org/sparql?query=' + encodeURIComponent(sparql) + '&format=json';
    console.log('URL:', url.slice(0, 120));
    const r = await fetch(url, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'BlueOcean/6.2 (market-gap research demo)' },
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    console.log('status:', r.status, 'body head:', text.slice(0, 300));
  } catch (e) { console.log('WIKIDATA ERR:', e.message); }

  try {
    const av = await fetch('https://archive.org/wayback/available?url=' + encodeURIComponent('https://genio.ge'), { signal: AbortSignal.timeout(15000) });
    const j = await av.json();
    console.log('WAYBACK genio.ge:', JSON.stringify(j).slice(0, 250));
  } catch (e) { console.log('WAYBACK ERR:', e.message); }
})();
