// v6.9.157 LIVE SAMPLE SCAN: one real search over one small area, then the
// real enrichment lane, then percent yield of email / phone / website / social.
// Run: npx tsx test_live_sample_scan.ts   (network required — this is NOT part
// of npm test; it's the user's live exam case: "1 search, how many % of
// businesses yield email/phone/website/social")
declare const process: { exit: (code: number) => void };

// src/__shim.ts's document shim + a minimal localStorage stub so the engine's
// cacheGet/cacheSet and host-health modules run unchanged under tsx.
import './src/__shim.js';
if (!(globalThis as any).localStorage) {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
    clear: () => { mem.clear(); },
  };
  Object.defineProperty((globalThis as any).localStorage, 'key', {
    value: Object.getOwnPropertyDescriptor((globalThis as any).localStorage, 'key')?.value,
  });
}
// key(i)/length iterate over a Map snapshot, like the DOM surface — close
// enough for the engine's LRU keys() scan.
// ── Tbilisi, Rustaveli Ave — 800 m radius (small sample, one merged search) ──
const LAT = 41.699;
const LON = 44.799;
const RADIUS = 800;

async function main(): Promise<void> {
  const engine = await import('./src/clientEngine.js');
  const {
    queryBusinesses, enrichDiscoverContacts, resetEngineHealth, setScanContext,
  } = engine as unknown as {
    queryBusinesses: (lat: number, lon: number, radius: number) => Promise<Map<string, unknown[]>>;
    enrichDiscoverContacts: (
      biz: Map<string, unknown[]>,
      opts?: { onProgress?: (msg: string, done: number, total: number) => void }) => Promise<void>;
    resetEngineHealth?: () => void;
    setScanContext: (ctx: Record<string, unknown>) => void;
  };
  // v6.9.157: the phone region gate (toE164Strict) needs the scan country —
  // the first run omitted countryCode, so foreign +country numbers leaked in.
  setScanContext({ countryCode: 'GE', countryName: 'Georgia', lang: 'ka', cityNative: 'Tbilisi', cityEn: 'Tbilisi' });

  resetEngineHealth?.();

  console.log('── Search 1: Overpass merged query, Rustaveli Ave 800m ──');
  const t0 = Date.now();
  const biz = await queryBusinesses(LAT, LON, RADIUS);
  const all: any[] = [];
  biz.forEach(arr => { for (const b of arr) all.push(b); });
  const secs1 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`parsed ${all.length} businesses in ${secs1}s (queries emited: 1 Overpass union)`);

  // Keep the exam sample small: first 30 unique businesses
  const seen = new Set<string>();
  const sample: any[] = [];
  for (const b of all) { if (!seen.has(b.id)) { seen.add(b.id); sample.push(b); } if (sample.length >= 30) break; }

  console.log('── Enrich: real serp dorks + website crawls (cap 4 min) ──');
  const t1 = Date.now();
  const BUDGET = 240_000;
  const enrichedMap = new Map<string, any[]>([['sample', sample]]);
  await enrichDiscoverContacts(enrichedMap, {
    onProgress: (msg, done, total) => {
      if (Date.now() - t1 > BUDGET) return; // budget is checked inside the lane too
      process.stdout.write?.(`  ${msg} (${done}/${total})\r`);
    },
  });
  const secs2 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\n  budget used: ${secs2}s`);

  // ── Yield per business ──
  const n = sample.length;
  const emailOk = sample.filter(b => !!b.email);
  const phoneOk = sample.filter(b => !!b.phone || !!b.whatsapp || !!b.viber || !!b.telegram);
  const webOk = sample.filter(b => !!b.website);
  const socialOk = sample.filter(b => !!(b.facebook || b.instagram || b.linkedin
    || b.youtube || b.tiktok || b.twitter || b.pinterest));
  const cnt = (c: number) => `${c}/${n} (${(100 * c / n).toFixed(0)}%)`;
  console.log(`\n── Yield over ${n} businesses ──`);
  console.log(`email     ${cnt(emailOk.length)}`);
  console.log(`phone     ${cnt(phoneOk.length)}`);
  console.log(`website   ${cnt(webOk.length)}`);
  console.log(`social    ${cnt(socialOk.length)}`);
  const full = sample.filter(b => !!b.email && (!!b.phone || !!b.whatsapp) && !!b.website);
  console.log(`full contact (email+phone+website together): ${full.length}/${n} (${(100 * full.length / n).toFixed(0)}%)`);
  console.log('\nPer-business detail:');
  for (const b of sample) {
    const fields: string[] = [];
    if (b.email) fields.push(`email=${b.email}`);
    if (b.phone) fields.push(`phone=${b.phone}`);
    else if (b.whatsapp) fields.push(`wa=${b.whatsapp}`);
    if (b.website) fields.push(`web=${b.website}`);
    const soc = [b.facebook, b.instagram, b.linkedin, b.youtube, b.tiktok, b.twitter, b.pinterest]
      .filter(Boolean).slice(0, 2);
    if (soc.length) fields.push(`social=${soc.join('|')}`);
    console.log(`  ${b.name} [${b.categoryLabel}] → ${fields.length ? fields.join('  ') : '(no contacts)'}`);
  }
}

main().catch(e => { console.error('scan failed:', e?.message || e); process.exit(1); });
