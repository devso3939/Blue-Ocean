// v6.9.160 unit tests: geocoder hit normalization (cityResultFromHit).
// Run: npm test (tsx …) — pure/offline, no network.
//
// REGRESSION: resolveCity races three geocoders (Photon + 2× Nominatim) and
// the arms return DIFFERENT shapes — Photon hands back CityResult objects
// (numeric lat/lon + `bbox`), Nominatim hands back raw payloads (string
// lat/lon + `boundingbox` + `address`). The old mapper assumed the raw shape
// only, so a Photon win threw `r.boundingbox.map is not a function` and the
// app swallowed it: the city dropdown stayed empty for every query.
import { cityResultFromHit } from './src/clientEngine.js';

// node shim for bare test run (tsconfig excludes test file)
declare const process: { exit: (code: number) => void };

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

// ── Photon-mapped hit: must pass through instead of throwing ──────
{
  const hit = {
    name: 'Tbilisi', country: 'Georgia', countryCode: 'GE',
    lat: 41.6934591, lon: 44.8014495, population: null,
    populationSource: undefined,
    bbox: [41.6, 44.7, 41.8, 44.9],
  };
  const got = cityResultFromHit(hit);
  eq('photon: name kept', got?.name, 'Tbilisi');
  eq('photon: numeric coords kept', [got?.lat, got?.lon], [41.6934591, 44.8014495]);
  eq('photon: bbox kept', got?.bbox, [41.6, 44.7, 41.8, 44.9]);
  eq('photon: countryCode upper', got?.countryCode, 'GE');
}

// ── Photon hit with a broken/absent bbox: fallback box, still usable ──
{
  const got = cityResultFromHit({ name: 'Batumi', country: 'Georgia', countryCode: 'ge', lat: 41.64, lon: 41.64, bbox: [] });
  eq('photon: bad bbox → ±0.05 fallback', got?.bbox, [41.59, 41.59, 41.69, 41.69]);
  eq('photon: bad bbox still returned', got?.name, 'Batumi');
}

// ── Photon hit with unusable coords: dropped, never throws ────────
{
  eq('photon: NaN coords dropped', cityResultFromHit({ name: 'X', lat: 'nope', lon: 1, bbox: [0, 0, 1, 1] }), null);
  eq('photon: nameless dropped', cityResultFromHit({ name: '', lat: 1, lon: 2, bbox: [0, 0, 1, 1] }), null);
}

// ── Nominatim raw hit: bbox reordered [s,n,w,e] → [s,w,n,e] ───────
{
  const hit = {
    lat: '41.6934591', lon: '44.8014495',
    name: 'Tbilisi', display_name: 'Tbilisi, Georgia',
    address: { country: 'Georgia', country_code: 'ge' },
    extratags: { population: '1200000' },
    boundingbox: ['41.6', '41.8', '44.7', '44.9'], // Nominatim order
  };
  const got = cityResultFromHit(hit);
  eq('nominatim: coords parsed', [got?.lat, got?.lon], [41.6934591, 44.8014495]);
  eq('nominatim: bbox reordered', got?.bbox, [41.6, 44.7, 41.8, 44.9]);
  eq('nominatim: country + code', [got?.country, got?.countryCode], ['Georgia', 'GE']);
  eq('nominatim: population from extratags', got?.population, 1200000);
}

// ── Nominatim raw hit without extratags/boundingbox: safe defaults ──
{
  const got = cityResultFromHit({ lat: '41.5', lon: '44.5', display_name: 'Nowhere, Somewhere, Georgia' });
  eq('nominatim: name from display_name', got?.name, 'Nowhere');
  eq('nominatim: no bbox → ±0.05 fallback', got?.bbox, [41.45, 44.45, 41.55, 44.55]);
  eq('nominatim: population null', got?.population, null);
}

// ── Junk / partial records: null, never a throw ───────────────────
{
  eq('junk: null', cityResultFromHit(null), null);
  eq('junk: empty object', cityResultFromHit({}), null);
  eq('junk: coords missing', cityResultFromHit({ name: 'Ghost', boundingbox: ['1', '2', '3', '4'] }), null);
  eq('junk: numeric-string coords still parse', cityResultFromHit({ lat: 41.7, lon: 44.8, name: 'Numeric' })?.name, 'Numeric');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
