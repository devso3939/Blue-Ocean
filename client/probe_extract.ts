// Focused probe: why does the deep-crawl lane extract nothing from real,
// fetched contact pages? Run extractFromHtml + extractFromText directly on
// mcdonalds.ge's contact page.
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

async function main(): Promise<void> {
  const engine = await import('./src/clientEngine.js');
  const { extractFromText, setScanContext, plausibleEmail } = engine as any;
  setScanContext({ countryCode: 'GE', countryName: 'Georgia', lang: 'ka', cityNative: 'Tbilisi', cityEn: 'Tbilisi' });

  const url = 'https://www.mcdonalds.ge/contact';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await r.text();
  console.log(`fetched ${url} -> ${r.status}, ${html.length} chars, has@=${html.includes('@')}`);

  const mk = () => ({
    id: 'x', name: 'McDonalds', website: 'https://www.mcdonalds.ge/', email: '', phone: '',
    address: '', facebook: '', instagram: '', linkedin: '', youtube: '', twitter: '',
    pinterest: '', tiktok: '', whatsapp: '', viber: '', telegram: '', rating: 0, reviewCount: 0,
    category: '', categoryLabel: '', hours: '', lat: 0, lon: 0, brand: '', cuisine: '',
  });

  const b1: any = mk();
  const touched = extractFromText(html.replace(/<[^>]+>/g, ' ').slice(0, 80000), b1);
  console.log('extractFromText(plain text) touched=', touched, '→', { email: b1.email, phone: b1.phone, fb: b1.facebook });

  const b2: any = mk();
  const t2 = extractFromText(html.slice(0, 80000), b2);
  console.log('extractFromText(raw html) touched=', t2, '→', { email: b2.email, phone: b2.phone, fb: b2.facebook });

  // raw gate probes on known values
  console.log('plausibleEmail(info@mcdonalds.ge) =', plausibleEmail('info@mcdonalds.ge'));
  const emails = (html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []).slice(0, 6);
  console.log('raw emails on page:', emails);
  process.exit(0);
}
main().catch(e => { console.error('probe failed:', e); process.exit(1); });
