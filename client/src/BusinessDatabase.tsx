// v6.9.128: Business Database as a first-class view in the MAIN app header
// (was admin-console-only in v6.9.126). Same server RPCs (bo.is_admin gates
// every call server-side), same deduped sheet, same Excel export. The token
// comes from the main app session (getAccessToken refreshes when needed), so
// the signed-in administrator sees the data without visiting /admin. Non-admin
// sessions get a clear "restricted" message — the RPC gate is the authority.
//
// v6.9.129: filters/sort/page/per persist to localStorage (bo.bizDb.v1) so a
// visit picks up exactly where the last one left off, and the header shows
// when the sheet was last synced (stats.last_sync from rpc_biz_db_stats).
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAccessToken } from './auth';
import { APP_VERSION } from './version';

const SB_URL = 'https://bfoagnqjkoqhogxvkvkw.supabase.co';
const SB_ANON = 'sb_publishable_UtCOExOHddCZ0UbTxbruWg_3m1U7a-0';

interface BizDbStats {
  total: number; with_phone: number; with_email: number; with_site: number;
  with_social: number; with_chat: number; countries: number; cities: number;
  last_sync: string | null; remaining: number;
}
interface BizDbRow {
  id: number; name: string; country: string; city: string;
  phone: string; email: string; website: string;
  facebook: string; instagram: string; linkedin: string; youtube: string; tiktok: string; twitter: string; pinterest: string;
  whatsapp: string; viber: string; telegram: string;
  lat: number | null; lon: number | null; address: string; category: string;
  rating: number | null; review_count: number | null; maps_url: string;
  source_runs: number; first_seen: string; last_seen: string; total: number;
}
interface OptRow { country?: string; city?: string; n: number }

async function rpc<T>(name: string, body: Record<string, unknown>, token: string | null): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey': SB_ANON,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data as { message?: string; error?: string })?.message
      || (data as { error?: string })?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

// ── zero-dependency real .xlsx writer (shared with AdminPanel) ─────────
function downloadXlsx(rows: Record<string, string | number>[], filename: string): void {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (buf: Uint8Array) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const enc = new TextEncoder();
  const files: { name: string; data: Uint8Array }[] = [];
  const add = (name: string, content: string) => files.push({ name, data: enc.encode(content) });
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const headers = rows.length ? Object.keys(rows[0]) : ['empty'];
  const colRef = (i: number) => { let s = ''; i++; while (i > 0) { s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); } return s; };
  const headerRow = `<row>${headers.map((h, i) => `<c r="${colRef(i)}1" t="inlineStr"><is><t>${xmlEsc(h)}</t></is></c>`).join('')}</row>`;
  const bodyRows = rows.slice(0, 100000).map((r, ri) => {
    const cells = headers.map((h, i) => {
      const v = r[h];
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${colRef(i)}${ri + 2}"><v>${v}</v></c>`;
      return `<c r="${colRef(i)}${ri + 2}" t="inlineStr"><is><t>${xmlEsc(String(v ?? ''))}</t></is></c>`;
    });
    return `<row>${cells.join('')}</row>`;
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headerRow}${bodyRows.join('')}</sheetData></worksheet>`;
  add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Businesses" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  add('xl/worksheets/sheet1.xml', sheet);

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
  const push = (arr: Uint8Array[], target: Uint8Array[]) => { for (const a of arr) target.push(a); };
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local: Uint8Array[] = [u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length), u16(nameBytes.length), u16(0)];
    push(local, parts); parts.push(nameBytes, f.data);
    push([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)], central);
    central.push(nameBytes);
    offset += local.reduce((s, a) => s + a.length, 0) + nameBytes.length + f.data.length;
  }
  const centralSize = central.reduce((s, a) => s + a.length, 0);
  const endOfCdr: Uint8Array[] = [u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)];
  const concat = (arrs: Uint8Array[]) => { let n = 0; for (const a of arrs) n += a.length; const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
  const blob = new Blob([concat(parts), concat(central), concat(endOfCdr)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url; aEl.download = filename; aEl.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const fmt = (n: number) => n.toLocaleString('en-US');
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// ── remembered view state: filters + page survive reloads ────────────────
// Same pattern as bo.aiAgent.v1 — one JSON blob read lazily by the useState
// initializers below and written back by the persistence effect.
const LS_KEY = 'bo.bizDb.v1';
interface BizDbSaved {
  q?: string; qApplied?: string; country?: string; city?: string;
  contact?: string; sort?: string; page?: number; per?: number;
}
const loadSaved = (): BizDbSaved => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as BizDbSaved;
  } catch { /* first visit or storage blocked */ }
  return {};
};

export default function BusinessDatabase({ onBack }: { onBack: () => void }) {
  const [stats, setStats] = useState<BizDbStats | null>(null);
  const [rows, setRows] = useState<BizDbRow[] | null>(null);
  const [countries, setCountries] = useState<OptRow[]>([]);
  const [cities, setCities] = useState<OptRow[]>([]);
  const [q, setQ] = useState(() => loadSaved().q ?? '');
  const [qApplied, setQApplied] = useState(() => loadSaved().qApplied ?? '');
  const [country, setCountry] = useState(() => loadSaved().country ?? '');
  const [city, setCity] = useState(() => loadSaved().city ?? '');
  const [contact, setContact] = useState(() => loadSaved().contact ?? 'any');
  const [sort, setSort] = useState(() => loadSaved().sort ?? 'newest');
  const [page, setPage] = useState(() => {
    const p = Number(loadSaved().page);
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  });
  const [per, setPer] = useState(() => {
    const n = Number(loadSaved().per);
    return Number.isFinite(n) && n > 0 ? n : 100;
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [restricted, setRestricted] = useState(false);

  // Remember filters + page across visits (v6.9.129).
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ q, qApplied, country, city, contact, sort, page, per }));
    } catch { /* storage unavailable */ }
  }, [q, qApplied, country, city, contact, sort, page, per]);

  // getAccessToken() reads the stored session and auto-refreshes it when the
  // access token has expired (v6.9.127 taught us why this matters).
  const token = useCallback(async () => getAccessToken(), []);

  const loadMeta = useCallback(async (tk: string) => {
    const [st, cs] = await Promise.all([
      rpc<BizDbStats>('rpc_biz_db_stats', {}, tk),
      rpc<OptRow[]>('rpc_biz_db_countries', {}, tk),
    ]);
    setStats(st); setCountries(cs || []);
  }, []);

  const loadRows = useCallback(async (tk: string, opts?: { page?: number }) => {
    setBusy(true); setErr('');
    try {
      let p = opts?.page ?? page;
      let list = (await rpc<BizDbRow[]>('rpc_biz_db_page', {
        p_page: p, p_per: per, p_sort: sort,
        p_q: qApplied, p_country: country, p_city: city, p_contact: contact,
      }, tk)) || [];
      // A remembered page can be past the end after the sheet changes — fall
      // back to page 1 instead of showing an empty table (v6.9.129).
      if (list.length === 0 && p > 1) {
        list = (await rpc<BizDbRow[]>('rpc_biz_db_page', {
          p_page: 1, p_per: per, p_sort: sort,
          p_q: qApplied, p_country: country, p_city: city, p_contact: contact,
        }, tk)) || [];
        p = 1;
      }
      setRows(list); setPage(p);
      setRestricted(false);
    } catch (e) {
      const m = String((e as Error).message || e);
      if (/permission|restricted|admin/i.test(m)) setRestricted(true);
      else setErr(m.slice(0, 200));
    } finally { setBusy(false); }
  }, [page, per, sort, qApplied, country, city, contact]);

  // Initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      const tk = await token();
      if (!tk) { setRestricted(true); return; }
      try { if (alive) await loadMeta(tk); } catch (e) {
        const m = String((e as Error).message || e);
        if (/permission|restricted|admin/i.test(m) && alive) setRestricted(true);
      }
      // v6.9.129: first query restores the remembered page, not page 1.
      if (alive) await loadRows(tk, { page });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-query when filters/sort/page-size change (debounced search). Skipped
  // on mount: the initial load above already queries the remembered page, and
  // this effect would otherwise clobber it straight back to page 1 (v6.9.129).
  const filtersMounted = useRef(false);
  useEffect(() => {
    if (!filtersMounted.current) { filtersMounted.current = true; return; }
    if (restricted) return;
    const id = setTimeout(async () => { const tk = await token(); if (tk) await loadRows(tk, { page: 1 }); }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, qApplied, country, city, contact, per]);

  // Dependent city list when country changes. On mount we only hydrate the
  // option list — the setCity('') reset applies to real country changes, or it
  // would wipe the restored city immediately (v6.9.129).
  const countryMounted = useRef(false);
  useEffect(() => {
    if (restricted) return;
    let alive = true;
    (async () => {
      const tk = await token(); if (!tk) return;
      try {
        const cs = await rpc<OptRow[]>('rpc_biz_db_cities', { p_country: country }, tk);
        if (alive) {
          setCities(cs || []);
          if (countryMounted.current) setCity('');
          countryMounted.current = true;
        }
      }
      catch { if (alive) setCities([]); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  const sync = async () => {
    const tk = await token(); if (!tk) return;
    setBusy(true); setMsg('');
    try {
      let last: { runs_synced?: number; added?: number; remaining?: number } | null = null;
      for (let i = 0; i < 30; i++) {
        const r = await rpc<{ runs_synced: number; added: number; remaining: number }>('rpc_biz_db_sync', { p_batch: 30 }, tk);
        last = r;
        if (typeof r.remaining === 'number' && r.remaining <= 0) break;
      }
      setMsg(last ? `Synced ${last.runs_synced ?? 0} runs → +${last.added ?? 0} unique businesses.` : 'Sync finished.');
      await loadMeta(tk);
      await loadRows(tk, { page: 1 });
    } catch (e) {
      setMsg(`sync error: ${String((e as Error).message || e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  const exportXlsx = async () => {
    const tk = await token(); if (!tk) return;
    setBusy(true); setMsg('');
    try {
      const raw = await rpc<Record<string, unknown>[]>('rpc_biz_db_export', {
        p_limit: 20000, p_q: qApplied, p_country: country, p_city: city, p_contact: contact,
      }, tk);
      const flat = (raw || []).map(rr => {
        const r = rr as Record<string, unknown>;
        const s = (k: string) => String(r[k] ?? '');
        return {
          'Business': s('name'), 'Country': s('country'), 'City': s('city'),
          'Phone': s('phone'), 'Email': s('email'), 'Website': s('website'),
          'Facebook': s('facebook'), 'Instagram': s('instagram'), 'LinkedIn': s('linkedin'),
          'YouTube': s('youtube'), 'TikTok': s('tiktok'), 'Twitter/X': s('twitter'), 'Pinterest': s('pinterest'),
          'WhatsApp': s('whatsapp'), 'Viber': s('viber'), 'Telegram': s('telegram'),
          'Address': s('address'), 'Category': s('category'),
          'Rating': String(r.rating ?? ''), 'Reviews': String(r.review_count ?? ''),
          'Google Maps': s('maps_url'), 'Seen in runs': Number(r.source_runs ?? 0), 'First seen': s('first_seen'),
        };
      });
      downloadXlsx(flat, `blue-ocean-businesses-${new Date().toISOString().slice(0, 10)}.xlsx`);
      setMsg(`Exported ${flat.length} rows to Excel.`);
    } catch (e) {
      setMsg(`export error: ${String((e as Error).message || e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <button onClick={onBack} title="Blue Ocean — home" className="flex items-center gap-2 rounded-lg px-1 py-0.5 hover:opacity-80 transition-all">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-500 text-white">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </div>
            <span className="text-sm font-bold">Blue Ocean <span className="text-muted-foreground font-normal">· Business Database</span> <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary/60 font-mono">v{APP_VERSION}</span></span>
          </button>
          <div className="flex items-center gap-3">
            {stats && (
              <span
                className="whitespace-nowrap text-[11px] text-muted-foreground"
                title={stats.last_sync ? `Last sync: ${when(stats.last_sync)}` : 'No sync has run yet'}
              >
                ⟳ last synced <span className="font-medium text-foreground/80">{ago(stats.last_sync)}</span>
              </span>
            )}
            <button
              onClick={onBack}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-all"
            >
              ← Back
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-3 p-4">
        {restricted && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            🔒 The Business Database is restricted to the administrator account. Sign in with the admin email in the main app to browse every business ever scanned.
            <div className="mt-2"><button onClick={onBack} className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/10">← Back to search</button></div>
          </div>
        )}

        {!restricted && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                { label: 'Unique businesses', value: fmt(stats?.total ?? 0), sub: `${fmt(stats?.remaining ?? 0)} runs pending sync` },
                { label: 'With phone', value: fmt(stats?.with_phone ?? 0), sub: `${fmt(stats?.with_email ?? 0)} with email` },
                { label: 'With website', value: fmt(stats?.with_site ?? 0), sub: `${fmt(stats?.with_social ?? 0)} with socials` },
                { label: 'With chat links', value: fmt(stats?.with_chat ?? 0), sub: `${stats?.countries ?? 0} countries · ${stats?.cities ?? 0} cities` },
              ].map(c => (
                <div key={c.label} className="rounded-xl border border-border bg-muted/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
                  <div className="mt-0.5 text-2xl font-bold text-foreground">{c.value}</div>
                  <div className="text-[11px] text-muted-foreground">{c.sub}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 p-3">
              <input
                value={q} onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') setQApplied(q); }}
                onBlur={() => setQApplied(q)}
                placeholder="Search name, phone, email, city…"
                className="w-56 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
              />
              <select value={country} onChange={e => setCountry(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                <option value="">All countries</option>
                {countries.map(c => <option key={c.country} value={c.country}>{c.country} ({fmt(c.n)})</option>)}
              </select>
              <select value={city} onChange={e => setCity(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                <option value="">All cities</option>
                {cities.map(c => <option key={c.city} value={c.city}>{c.city} ({fmt(c.n)})</option>)}
              </select>
              <select value={contact} onChange={e => setContact(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                <option value="any">Any contact</option>
                <option value="phone">Has phone</option>
                <option value="email">Has email</option>
                <option value="site">Has website</option>
                <option value="socials">Has socials</option>
                <option value="chat">Has chat links</option>
              </select>
              <select value={sort} onChange={e => setSort(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name_asc">Name A→Z</option>
                <option value="name_desc">Name Z→A</option>
                <option value="country">Country</option>
                <option value="city">City</option>
                <option value="category">Category</option>
                <option value="rating">Rating</option>
                <option value="reviews">Reviews</option>
                <option value="sources">Most sightings</option>
                <option value="contact">Most contact info</option>
              </select>
              <select value={per} onChange={e => setPer(Number(e.target.value))} className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground">
                {[20, 100, 200, 500, 1000, 10000].map(n => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <div className="ml-auto flex items-center gap-2">
                <button disabled={busy} onClick={() => void sync()}
                  className="rounded-lg border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-400 hover:bg-sky-500/20 disabled:opacity-40">
                  {busy ? 'Working…' : '⟳ Sync runs'}
                </button>
                <button disabled={busy} onClick={() => void exportXlsx()}
                  className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40">
                  ⬇ Export Excel
                </button>
              </div>
            </div>

            {msg && <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">{msg}</div>}
            {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</div>}
            {rows && rows.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Showing {fmt((page - 1) * per + 1)}–{fmt((page - 1) * per + rows.length)} of {fmt(rows[0].total)} unique businesses.
              </p>
            )}

            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Business</th><th className="px-3 py-2">Where</th>
                    <th className="px-3 py-2">Phone</th><th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Website</th><th className="px-3 py-2">Socials / Chat</th>
                    <th className="px-3 py-2 text-right">Rating</th>
                    <th className="px-3 py-2 text-right">Sightings</th>
                    <th className="px-3 py-2">First seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(rows || []).map(r => (
                    <tr key={r.id} className="hover:bg-muted/40">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground" title={r.address}>{r.name}</div>
                        <div className="text-[10px] text-muted-foreground">{r.category || '—'}{r.rating ? ` · ★ ${Number(r.rating).toFixed(1)}${r.review_count ? ` (${r.review_count})` : ''}` : ''}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.city || '—'}{r.country ? `, ${r.country}` : ''}</td>
                      <td className="px-3 py-2">{r.phone
                        ? <a href={`tel:${r.phone}`} className="text-sky-400 hover:underline">{r.phone}</a>
                        : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-3 py-2">{r.email
                        ? <a href={`mailto:${r.email}`} className="text-sky-400 hover:underline" title={r.email}>{r.email.length > 24 ? r.email.slice(0, 24) + '…' : r.email}</a>
                        : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-3 py-2">{r.website
                        ? <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">🌐</a>
                        : <span className="text-muted-foreground/50">—</span>}
                        {r.maps_url && <a href={r.maps_url} target="_blank" rel="noopener noreferrer" className="ml-1 text-emerald-400 hover:underline" title="Google Maps">📍</a>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {r.facebook && <a href={r.facebook} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">FB</a>}
                          {r.instagram && <a href={r.instagram} target="_blank" rel="noopener noreferrer" className="text-pink-400 hover:underline">IG</a>}
                          {r.linkedin && <a href={r.linkedin} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline">LI</a>}
                          {r.youtube && <a href={r.youtube} target="_blank" rel="noopener noreferrer" className="text-red-400 hover:underline">YT</a>}
                          {r.tiktok && <a href={r.tiktok} target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:underline">TT</a>}
                          {r.twitter && <a href={r.twitter} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">X</a>}
                          {r.whatsapp && <a href={r.whatsapp} target="_blank" rel="noopener noreferrer" className="text-green-400 hover:underline" title={r.whatsapp}>💬</a>}
                          {r.viber && <a href={r.viber} className="text-purple-400 hover:underline" title={r.viber}>🟣</a>}
                          {r.telegram && <a href={r.telegram} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:underline" title={r.telegram}>✈️</a>}
                          {!r.facebook && !r.instagram && !r.linkedin && !r.youtube && !r.tiktok && !r.twitter && !r.whatsapp && !r.viber && !r.telegram && <span className="text-muted-foreground/50">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{r.rating ? `★ ${Number(r.rating).toFixed(1)}` : '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`rounded px-1.5 py-0.5 ${r.source_runs > 1 ? 'bg-amber-500/20 text-amber-400' : 'bg-muted text-muted-foreground'}`}>{r.source_runs}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={when(r.first_seen)}>{ago(r.first_seen)}</td>
                    </tr>
                  ))}
                  {rows && rows.length === 0 && (
                    <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No businesses match — adjust filters or press ⟳ Sync runs to ingest archived runs.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <button disabled={busy || page <= 1} onClick={() => void (async () => { const tk = await token(); if (tk) await loadRows(tk, { page: page - 1 }); })()}
                className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-30">← Prev</button>
              <span className="text-xs text-muted-foreground">Page {fmt(page)}{rows && rows[0] ? ` · ${fmt(Math.ceil(rows[0].total / per))} total` : ''}</span>
              <button disabled={busy || !rows || (rows[0] ? page * per >= rows[0].total : true)} onClick={() => void (async () => { const tk = await token(); if (tk) await loadRows(tk, { page: page + 1 }); })()}
                className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-30">Next →</button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Uniqueness: same normalized name within ~111 m geocell, same phone digits, or same email → merged into one row.
              Later sightings fill only blank fields and bump the Sightings counter.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
