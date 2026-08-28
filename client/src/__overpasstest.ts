/**
 * Live Overpass regression: focused cafe scan through the NEW mirror chain
 * (overpass-api.de, kumi, osm.jp, private.coffee, osm.ru). Small bbox to be
 * gentle on shared infrastructure. Verifies: real businesses return, fields
 * populate, categorization works.
 */
import './__shim';
import { queryBusinesses } from './clientEngine';

async function main() {
  console.log('=== LIVE OVERPASS REGRESSION: focused cafe scan (Tbilisi, 3km) ===');
  const t0 = Date.now();
  const all = await queryBusinesses(
    41.6934, 44.8015, // Tbilisi center
    3000,
    (pct, msg) => { if (pct % 20 === 0) console.log(`  ${pct}%: ${msg}`); },
    'cafe',          // focused category query
    true,            // skipEnrichment (test the Overpass path itself)
  );
  const cafes = all.get('cafe') || [];
  console.log(`elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`cafes found: ${cafes.length}`);
  const withName = cafes.filter(c => c.name).length;
  const withPhone = cafes.filter(c => c.phone).length;
  const withWebsite = cafes.filter(c => c.website).length;
  console.log(`named: ${withName}, with phone (OSM tags): ${withPhone}, with website (OSM tags): ${withWebsite}`);
  for (const c of cafes.slice(0, 8)) {
    console.log(`  - ${c.name || '(unnamed)'} @ ${c.address || '(no addr)'} ${c.phone ? '☎' : ''}${c.website ? '⌂' : ''}`);
  }
  if (cafes.length < 15) throw new Error(`only ${cafes.length} cafes in central Tbilisi 3km — Overpass path broken`);
  if (withName < cafes.length * 0.7) throw new Error('too many unnamed businesses');
  console.log('\nOVERPASS LIVE PASS');
}

main().catch(e => { console.error('OVERPASS LIVE FAIL:', e && e.message || e); process.exit(1); });
