// Diagnostic probe: why is enrichDiscoverContacts a no-op? Logs every fetch
// the engine makes during the lane, times it, reports field changes.
declare const process: { exit: (code: number) => void; };
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
}

const realFetch = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  calls.push(url.slice(0, 120));
  const t = Date.now();
  try {
    const r = await realFetch(input as any, init);
    calls.push(`  -> ${r.status} (${Date.now() - t}ms)`);
    return r;
  } catch (e: any) {
    calls.push(`  -> ERR ${e?.name || e} (${Date.now() - t}ms)`);
    throw e;
  }
}) as typeof fetch;

async function main(): Promise<void> {
  const engine = await import('./src/clientEngine.js');
  const { enrichDiscoverContacts, setScanContext } = engine as any;
  setScanContext({ countryCode: 'GE', countryName: 'Georgia', lang: 'ka', cityNative: 'Tbilisi', cityEn: 'Tbilisi' });

  const mk = (id: string, website: string) => ({
    id, name: 'Probe Business', website, email: '', phone: '', address: 'Tbilisi',
    facebook: '', instagram: '', twitter: '', youtube: '', tiktok: '', pinterest: '',
    linkedin: '', whatsapp: '', viber: '', telegram: '', branches: undefined,
  });
  const biz = new Map([['probe', [
    mk('p1', 'https://www.mcdonalds.ge/'),
    mk('p2', 'https://www.mrcook.ge/'),
  ] as any[]]]);

  const t0 = Date.now();
  await enrichDiscoverContacts(biz, { onProgress: (m: string) => console.log('progress:', m) });
  console.log(`lane took ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  const arr: any[] = [];
  biz.forEach(v => arr.push(...v));
  for (const b of arr) console.log(`${b.id}: email=${b.email || '-'} phone=${b.phone || '-'} fb=${b.facebook || '-'}`);
  console.log(`\nfetch calls (${calls.length}):`);
  console.log(calls.slice(0, 40).join('\n'));
  process.exit(0);
}
main().catch(e => { console.error('probe failed:', e); process.exit(1); });
