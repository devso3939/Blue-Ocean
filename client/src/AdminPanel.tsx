// v6.9.120: Admin panel — /Blue-Ocean/admin
// Login is a REAL Supabase password sign-in; every data call below is an RPC
// that re-checks server-side (bo.is_admin → the hardcoded admin email), so
// this UI is a convenience layer, not the security boundary. Sessions are
// stored separately from the main app session so admin mode and user mode
// never interfere.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_VERSION } from './version';

const SB_URL = 'https://bfoagnqjkoqhogxvkvkw.supabase.co';
const SB_ANON = 'sb_publishable_UtCOExOHddCZ0UbTxbruWg_3m1U7a-0';
// v6.9.120: the admin identity is hardcoded here AND in the DB gate
// (bo.is_admin). Changing either side alone grants nothing.
const ADMIN_EMAIL = 'ananiadevsurashvili@gmail.com';
const LS_KEY = 'bo_admin_session_v1';

interface AdminSession { accessToken: string; email: string; exp: number }

function loadSession(): AdminSession | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AdminSession;
    if (!s.accessToken || Date.now() / 1000 > s.exp - 60) return null;
    return s;
  } catch { return null; }
}

function decodeExp(jwt: string): number {
  try {
    const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof p.exp === 'number' ? p.exp : 0;
  } catch { return 0; }
}

async function rpc<T>(name: string, body: Record<string, unknown>, token?: string | null): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey': SB_ANON,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
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

interface Overview {
  users_total: number; suspended: number;
  runs_total: number; guest_runs: number; user_runs: number; runs_24h: number;
  biz_total: number;
  events_24h: number; uniques_24h: number; events_7d: number; uniques_7d: number;
}
interface TrafficRow { day: string; events: number; uniques: number; signed_in: number }
interface RunRow {
  run_id: string; kind: 'analyze' | 'discover'; ts: string; version: string;
  country: string; city: string; category: string | null;
  biz_count: number; any_contact_pct: number; user_id: string | null; email: string | null;
}
interface UserRow {
  user_id: string; email: string; created_at: string; last_sign_in_at: string | null;
  runs: number; biz: number; last_run: string | null; suspended: boolean; reason: string;
}

type Tab = 'overview' | 'traffic' | 'runs' | 'users' | 'database';

// ── v6.9.126: Business Database types ────────────────────────────────
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

// ── v6.9.126: zero-dependency real .xlsx writer (Open XML + stored zip) ──
// Excel opens stored (uncompressed) zip archives fine; avoids adding the
// 400 kB sheetjs dependency for one export button. CRC32 is table-based.
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

  // Stored zip: local file headers + central directory.
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

const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <div className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3">
    <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className="mt-0.5 text-2xl font-bold text-slate-100">{value}</div>
    {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
  </div>
);

const fmt = (n: number) => n.toLocaleString('en-US');
const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function AdminPanel() {
  const [session, setSession] = useState<AdminSession | null>(() => loadSession());
  const [email, setEmail] = useState(ADMIN_EMAIL);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('overview');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [traffic, setTraffic] = useState<TrafficRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [runScope, setRunScope] = useState<'all' | 'guests' | 'users'>('all');
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  // ── v6.9.126: Business Database state ─────────────────────────────
  const [dbStats, setDbStats] = useState<BizDbStats | null>(null);
  const [dbRows, setDbRows] = useState<BizDbRow[] | null>(null);
  const [dbCountries, setDbCountries] = useState<OptRow[]>([]);
  const [dbCities, setDbCities] = useState<OptRow[]>([]);
  const [dbQ, setDbQ] = useState('');
  const [dbQApplied, setDbQApplied] = useState(''); // search fires on Enter/debounce
  const [dbCountry, setDbCountry] = useState('');
  const [dbCity, setDbCity] = useState('');
  const [dbContact, setDbContact] = useState('any');
  const [dbSort, setDbSort] = useState('newest');
  const [dbPage, setDbPage] = useState(1);
  const [dbPer, setDbPer] = useState(100);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState('');

  const refreshInterval = useCallback((t: Tab): number => {
    if (t === 'overview') return 30000;
    if (t === 'traffic') return 60000;
    return 0; // runs/users: manual refresh
  }, []);

  // ── data loaders (admin token guarded) ─────────────────────────────
  const load = useCallback(async (t: Tab) => {
    if (!session) return;
    setLoadErr('');
    try {
      if (t === 'overview') setOverview(await rpc<Overview>('rpc_admin_overview', {}, session.accessToken));
      else if (t === 'traffic') setTraffic(await rpc<TrafficRow[]>('rpc_admin_traffic', { p_hours: 720 }, session.accessToken));
      else if (t === 'runs') setRuns(await rpc<RunRow[]>('rpc_admin_runs', { p_limit: 200, p_scope: runScope }, session.accessToken));
      else setUsers(await rpc<UserRow[]>('rpc_admin_users', { p_limit: 500 }, session.accessToken));
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (/JWT|expired|invalid/i.test(msg)) {
        localStorage.removeItem(LS_KEY);
        setSession(null);
      } else setLoadErr(msg.slice(0, 200));
    }
  }, [session, runScope]);

  useEffect(() => { void load(tab); }, [tab, load]);
  useEffect(() => { void load('runs'); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [runScope]);

  // ── v6.9.126: Business Database loaders ───────────────────────────
  const loadDbMeta = useCallback(async (token: string) => {
    try {
      const [st, cs] = await Promise.all([
        rpc<BizDbStats>('rpc_biz_db_stats', {}, token),
        rpc<OptRow[]>('rpc_biz_db_countries', {}, token),
      ]);
      setDbStats(st); setDbCountries(cs || []);
    } catch { /* tab-level error shown by loader */ }
  }, []);

  const loadDbRows = useCallback(async (opts?: { page?: number }) => {
    if (!session) return;
    setDbBusy(true);
    try {
      const page = opts?.page ?? dbPage;
      const rows = await rpc<BizDbRow[]>('rpc_biz_db_page', {
        p_page: page, p_per: dbPer, p_sort: dbSort,
        p_q: dbQApplied, p_country: dbCountry, p_city: dbCity, p_contact: dbContact,
      }, session.accessToken);
      setDbRows(rows || []);
      setDbPage(page);
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (/JWT|expired|invalid/i.test(msg)) { localStorage.removeItem(LS_KEY); setSession(null); }
      else setLoadErr(msg.slice(0, 200));
    } finally { setDbBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, dbPage, dbPer, dbSort, dbQApplied, dbCountry, dbCity, dbContact]);

  useEffect(() => {
    if (tab !== 'database' || !session) return;
    void loadDbMeta(session.accessToken);
    void loadDbRows({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Re-query when filters/sort/page-size change (debounced 300ms for search box)
  useEffect(() => {
    if (tab !== 'database' || !session) return;
    const id = setTimeout(() => { void loadDbRows({ page: 1 }); }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbSort, dbQApplied, dbCountry, dbCity, dbContact, dbPer]);

  // Load dependent city list when country changes
  useEffect(() => {
    if (tab !== 'database' || !session) return;
    rpc<OptRow[]>('rpc_biz_db_cities', { p_country: dbCountry }, session.accessToken)
      .then(cs => { setDbCities(cs || []); setDbCity(''); })
      .catch(() => setDbCities([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbCountry, tab]);

  useEffect(() => {
    const ms = refreshInterval(tab);
    if (!ms || !session) return;
    const id = setInterval(() => void load(tab), ms);
    return () => clearInterval(id);
  }, [tab, session, load, refreshInterval]);

  // ── login / logout ─────────────────────────────────────────────────
  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (email.trim().toLowerCase() !== ADMIN_EMAIL) {
        throw new Error('This console is restricted to the administrator account.');
      }
      const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json() as { access_token?: string; error_description?: string; msg?: string; user?: { email?: string } };
      if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.msg || 'Sign-in failed.');
      }
      // Server-side authority check: try an admin RPC with the fresh token.
      // The email is the gate; this proves the account matches it RIGHT NOW.
      await rpc<Overview>('rpc_admin_overview', {}, data.access_token);
      const s: AdminSession = {
        accessToken: data.access_token,
        email: data.user?.email || ADMIN_EMAIL,
        exp: decodeExp(data.access_token),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(s));
      setSession(s);
      setPassword('');
    } catch (e2) {
      setErr(String((e2 as Error).message || e2).slice(0, 200));
    } finally { setBusy(false); }
  };

  const doLogout = () => { localStorage.removeItem(LS_KEY); setSession(null); };

  // ── v6.9.126: database sync + export ──────────────────────────────
  const dbSync = async () => {
    if (!session) return;
    setDbBusy(true); setDbMsg('');
    try {
      let last: { runs_synced?: number; added?: number; remaining?: number } | null = null;
      for (let i = 0; i < 30; i++) {
        const r = await rpc<{ runs_synced: number; added: number; remaining: number }>(
          'rpc_biz_db_sync', { p_batch: 30 }, session.accessToken);
        last = r;
        if (typeof r.remaining === 'number' && r.remaining <= 0) break;
      }
      setDbMsg(last ? `Synced ${last.runs_synced ?? 0} runs → +${last.added ?? 0} unique businesses.` : 'Sync finished.');
      await loadDbMeta(session.accessToken);
      await loadDbRows({ page: 1 });
    } catch (e) {
      setDbMsg(`sync error: ${String((e as Error).message || e).slice(0, 160)}`);
    } finally { setDbBusy(false); }
  };

  const dbExport = async () => {
    if (!session) return;
    setDbBusy(true); setDbMsg('');
    try {
      const rows = await rpc<Record<string, unknown>[]>('rpc_biz_db_export', {
        p_limit: 20000, p_q: dbQApplied, p_country: dbCountry, p_city: dbCity, p_contact: dbContact,
      }, session.accessToken);
      const flat = (rows || []).map(rr => {
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
      setDbMsg(`Exported ${flat.length} rows to Excel.`);
    } catch (e) {
      setDbMsg(`export error: ${String((e as Error).message || e).slice(0, 160)}`);
    } finally { setDbBusy(false); }
  };

  // ── moderation ─────────────────────────────────────────────────────
  const act = async (what: 'suspend' | 'unsuspend' | 'delete', u: UserRow) => {
    if (what === 'delete' && !window.confirm(
      `DELETE ${u.email} permanently?\n\nThis removes their account, all their runs and prefs. There is no undo.`
    )) return;
    if (what === 'suspend' && !window.confirm(`Suspend ${u.email}? Their sessions are revoked and sync is blocked until you un-suspend.`)) return;
    setActionMsg(''); setBusy(true);
    try {
      const msg = what === 'delete'
        ? await rpc<string>('rpc_admin_delete_user', { p_user: u.user_id }, session!.accessToken)
        : await rpc<string>('rpc_admin_set_suspended',
            { p_user: u.user_id, p_suspended: what === 'suspend', p_reason: what === 'suspend' ? 'Suspended by admin' : '' },
            session!.accessToken);
      setActionMsg(`${what}: ${msg}`);
      await load('users');
      await load('overview');
    } catch (e) {
      setActionMsg(`error: ${String((e as Error).message || e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  // ── derived: traffic sparkline (pure CSS bars) ─────────────────────
  const maxEvents = useMemo(() => Math.max(1, ...(traffic || []).map(r => r.events)), [traffic]);

  // ───────────────────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-200">
        <form onSubmit={doLogin} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl">
          <h1 className="text-xl font-bold">Blue Ocean · Admin</h1>
          <p className="mt-1 text-xs text-slate-400">Traffic, runs and user moderation console.</p>
          <label className="mt-5 block text-xs text-slate-400">Email</label>
          <input type="email" value={email} readOnly
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-300" />
          <label className="mt-3 block text-xs text-slate-400">Password</label>
          <input type="password" value={password} autoFocus onChange={e => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            placeholder="••••••••" />
          {err && <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}
          <button type="submit" disabled={busy || !password}
            className="mt-5 w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40">
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <p className="mt-4 text-[11px] text-slate-500">v{APP_VERSION} · access is verified server-side per request</p>
        </form>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'runs', label: 'Runs' },
    { id: 'users', label: 'Users' },
    { id: 'database', label: '🗄️ Database' },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <h1 className="text-base font-bold">Blue Ocean · Admin</h1>
            <p className="text-[11px] text-slate-400">{session.email} · v{APP_VERSION}</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="./" className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">← App</a>
            <button onClick={doLogout} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">Sign out</button>
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-800 bg-slate-900/40 px-4">
        <div className="mx-auto flex max-w-6xl gap-1">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium ${tab === t.id ? 'border-b-2 border-sky-500 text-sky-300' : 'text-slate-400 hover:text-slate-200'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {loadErr && <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{loadErr}</div>}
        {actionMsg && <div className="mb-4 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">{actionMsg}</div>}

        {tab === 'overview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="Visitors 24h" value={fmt(overview?.uniques_24h ?? 0)} sub={`${fmt(overview?.events_24h ?? 0)} sessions`} />
              <Card label="Visitors 7d" value={fmt(overview?.uniques_7d ?? 0)} sub={`${fmt(overview?.events_7d ?? 0)} sessions`} />
              <Card label="Registered users" value={fmt(overview?.users_total ?? 0)} sub={`${fmt(overview?.suspended ?? 0)} suspended`} />
              <Card label="Runs total" value={fmt(overview?.runs_total ?? 0)} sub={`${fmt(overview?.runs_24h ?? 0)} in 24h`} />
              <Card label="Guest runs" value={fmt(overview?.guest_runs ?? 0)} sub="no account" />
              <Card label="User runs" value={fmt(overview?.user_runs ?? 0)} sub="signed-in owners" />
              <Card label="Businesses scanned" value={fmt(overview?.biz_total ?? 0)} sub="sum of all runs" />
            </div>
            <p className="text-xs text-slate-500">
              Usage model: one archived run (analyze or discover) counts as one usage; per-user usage = run count +
              businesses scanned. Guests are counted by anonymous browser session.
            </p>
          </div>
        )}

        {tab === 'traffic' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
              <h2 className="text-sm font-semibold text-slate-300">Sessions per day (last 30 days)</h2>
              {!traffic && <p className="mt-2 text-xs text-slate-500">Loading…</p>}
              {traffic && traffic.length === 0 && <p className="mt-2 text-xs text-slate-500">No traffic recorded yet — events start logging with v{APP_VERSION}.</p>}
              {traffic && traffic.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {traffic.map(r => (
                    <div key={r.day} className="flex items-center gap-2 text-xs">
                      <span className="w-20 shrink-0 text-slate-500">{r.day.slice(5)}</span>
                      <div className="h-3 flex-1 overflow-hidden rounded bg-slate-800">
                        <div className="h-full rounded bg-sky-600" style={{ width: `${(r.events / maxEvents) * 100}%` }} />
                      </div>
                      <span className="w-24 shrink-0 text-right text-slate-400">
                        {fmt(r.events)} · {fmt(r.uniques)} uniq
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => void load('traffic')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">Refresh</button>
          </div>
        )}

        {tab === 'runs' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex gap-1 rounded-lg border border-slate-700 p-0.5">
                {(['all', 'guests', 'users'] as const).map(s => (
                  <button key={s} onClick={() => setRunScope(s)}
                    className={`rounded-md px-3 py-1 text-xs capitalize ${runScope === s ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                    {s === 'guests' ? 'Guest runs' : s === 'users' ? 'User runs' : 'All'}
                  </button>
                ))}
              </div>
              <button onClick={() => void load('runs')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">Refresh</button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900 text-slate-400">
                  <tr>
                    <th className="px-3 py-2">When</th><th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Where</th><th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Businesses</th>
                    <th className="px-3 py-2 text-right">Contact %</th>
                    <th className="px-3 py-2">Made by</th>
                    <th className="px-3 py-2">Version</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {(runs || []).map(r => (
                    <tr key={r.run_id} className="hover:bg-slate-900/60">
                      <td className="whitespace-nowrap px-3 py-2 text-slate-300" title={when(r.ts)}>{ago(r.ts)}</td>
                      <td className="px-3 py-2">{r.kind}</td>
                      <td className="px-3 py-2">{r.city}, {r.country}</td>
                      <td className="px-3 py-2 text-slate-400">{r.category || '—'}</td>
                      <td className="px-3 py-2 text-right">{fmt(r.biz_count)}</td>
                      <td className="px-3 py-2 text-right">{Number(r.any_contact_pct).toFixed(0)}%</td>
                      <td className="px-3 py-2">
                        {r.email
                          ? <span className="text-sky-300">{r.email}</span>
                          : <span className="text-slate-500">👤 Guest</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{r.version || '—'}</td>
                    </tr>
                  ))}
                  {runs && runs.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No runs in this scope.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">
                {fmt(users?.length ?? 0)} registered · usage = runs + businesses scanned
              </p>
              <button onClick={() => void load('users')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">Refresh</button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900 text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2 text-right">Runs</th>
                    <th className="px-3 py-2 text-right">Businesses</th>
                    <th className="px-3 py-2">Last run</th>
                    <th className="px-3 py-2">Joined</th>
                    <th className="px-3 py-2">Last sign-in</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {(users || []).map(u => (
                    <tr key={u.user_id} className={`hover:bg-slate-900/60 ${u.suspended ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2 font-medium text-slate-200">{u.email}</td>
                      <td className="px-3 py-2 text-right">{fmt(u.runs)}</td>
                      <td className="px-3 py-2 text-right">{fmt(u.biz)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{ago(u.last_run)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{when(u.created_at)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{ago(u.last_sign_in_at)}</td>
                      <td className="px-3 py-2">
                        {u.suspended
                          ? <span className="rounded bg-rose-500/20 px-2 py-0.5 text-rose-300" title={u.reason}>suspended</span>
                          : <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-300">active</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {u.suspended
                          ? <button disabled={busy} onClick={() => void act('unsuspend', u)}
                              className="rounded border border-emerald-600/50 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10">Unsuspend</button>
                          : <button disabled={busy} onClick={() => void act('suspend', u)}
                              className="rounded border border-amber-600/50 px-2 py-1 text-amber-300 hover:bg-amber-500/10">Suspend</button>}
                        <button disabled={busy} onClick={() => void act('delete', u)}
                          className="ml-1 rounded border border-rose-600/50 px-2 py-1 text-rose-300 hover:bg-rose-500/10">Delete</button>
                      </td>
                    </tr>
                  ))}
                  {users && users.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No registered users yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === 'database' && (
          <div className="space-y-3">
            {/* header cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card label="Unique businesses" value={fmt(dbStats?.total ?? 0)} sub={`${fmt(dbStats?.remaining ?? 0)} runs pending sync`} />
              <Card label="With phone" value={fmt(dbStats?.with_phone ?? 0)} sub={`${fmt(dbStats?.with_email ?? 0)} with email`} />
              <Card label="With website" value={fmt(dbStats?.with_site ?? 0)} sub={`${fmt(dbStats?.with_social ?? 0)} with socials`} />
              <Card label="With chat links" value={fmt(dbStats?.with_chat ?? 0)} sub={`${dbStats?.countries ?? 0} countries · ${dbStats?.cities ?? 0} cities`} />
            </div>

            {/* controls */}
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
              <input
                value={dbQ} onChange={e => setDbQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') setDbQApplied(dbQ); }}
                onBlur={() => setDbQApplied(dbQ)}
                placeholder="Search name, phone, email, city…"
                className="w-56 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
              />
              <select value={dbCountry} onChange={e => setDbCountry(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200">
                <option value="">All countries</option>
                {dbCountries.map(c => <option key={c.country} value={c.country}>{c.country} ({fmt(c.n)})</option>)}
              </select>
              <select value={dbCity} onChange={e => setDbCity(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200">
                <option value="">All cities</option>
                {dbCities.map(c => <option key={c.city} value={c.city}>{c.city} ({fmt(c.n)})</option>)}
              </select>
              <select value={dbContact} onChange={e => setDbContact(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200">
                <option value="any">Any contact</option>
                <option value="phone">Has phone</option>
                <option value="email">Has email</option>
                <option value="site">Has website</option>
                <option value="socials">Has socials</option>
                <option value="chat">Has chat links</option>
              </select>
              <select value={dbSort} onChange={e => setDbSort(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200">
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
              <select value={dbPer} onChange={e => setDbPer(Number(e.target.value))}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200">
                {[20, 100, 200, 500, 1000, 10000].map(n => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <div className="ml-auto flex items-center gap-2">
                <button disabled={dbBusy} onClick={() => void dbSync()}
                  className="rounded-lg border border-sky-600/60 bg-sky-600/20 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-600/30 disabled:opacity-40">
                  {dbBusy ? 'Working…' : '⟳ Sync runs'}
                </button>
                <button disabled={dbBusy} onClick={() => void dbExport()}
                  className="rounded-lg border border-emerald-600/60 bg-emerald-600/20 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40">
                  ⬇ Export Excel
                </button>
              </div>
            </div>

            {dbMsg && <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">{dbMsg}</div>}
            {dbRows && dbRows.length > 0 && (
              <p className="text-[11px] text-slate-500">
                Showing {fmt((dbPage - 1) * dbPer + 1)}–{fmt((dbPage - 1) * dbPer + dbRows.length)} of {fmt(dbRows[0].total)} unique businesses.
              </p>
            )}

            {/* the sheet */}
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900 text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Business</th><th className="px-3 py-2">Where</th>
                    <th className="px-3 py-2">Phone</th><th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Website</th><th className="px-3 py-2">Socials / Chat</th>
                    <th className="px-3 py-2 text-right">Rating</th>
                    <th className="px-3 py-2 text-right">Sightings</th>
                    <th className="px-3 py-2">First seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {(dbRows || []).map(r => (
                    <tr key={r.id} className="hover:bg-slate-900/60">
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-200" title={r.address}>{r.name}</div>
                        <div className="text-[10px] text-slate-500">{r.category || '—'}{r.rating ? ` · ★ ${Number(r.rating).toFixed(1)}${r.review_count ? ` (${r.review_count})` : ''}` : ''}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-400">{r.city || '—'}{r.country ? `, ${r.country}` : ''}</td>
                      <td className="px-3 py-2">{r.phone
                        ? <a href={`tel:${r.phone}`} className="text-sky-300 hover:underline">{r.phone}</a>
                        : <span className="text-slate-600">—</span>}</td>
                      <td className="px-3 py-2">{r.email
                        ? <a href={`mailto:${r.email}`} className="text-sky-300 hover:underline" title={r.email}>{r.email.length > 24 ? r.email.slice(0, 24) + '…' : r.email}</a>
                        : <span className="text-slate-600">—</span>}</td>
                      <td className="px-3 py-2">{r.website
                        ? <a href={r.website} target="_blank" rel="noopener noreferrer" className="text-emerald-300 hover:underline">🌐</a>
                        : <span className="text-slate-600">—</span>}
                        {r.maps_url && <a href={r.maps_url} target="_blank" rel="noopener noreferrer" className="ml-1 text-emerald-300 hover:underline" title="Google Maps">📍</a>}
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
                          {!r.facebook && !r.instagram && !r.linkedin && !r.youtube && !r.tiktok && !r.twitter && !r.whatsapp && !r.viber && !r.telegram && <span className="text-slate-600">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-slate-400">{r.rating ? `★ ${Number(r.rating).toFixed(1)}` : '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`rounded px-1.5 py-0.5 ${r.source_runs > 1 ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-500'}`}>{r.source_runs}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-500" title={when(r.first_seen)}>{ago(r.first_seen)}</td>
                    </tr>
                  ))}
                  {dbRows && dbRows.length === 0 && (
                    <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">No businesses match — adjust filters or press ⟳ Sync runs to ingest archived runs.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* pagination */}
            <div className="flex items-center justify-between">
              <button disabled={dbBusy || dbPage <= 1} onClick={() => void loadDbRows({ page: dbPage - 1 })}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-30">← Prev</button>
              <span className="text-xs text-slate-500">Page {fmt(dbPage)}{dbRows && dbRows[0] ? ` · ${fmt(Math.ceil(dbRows[0].total / dbPer))} total` : ''}</span>
              <button disabled={dbBusy || !dbRows || (dbRows[0] ? dbPage * dbPer >= dbRows[0].total : true)} onClick={() => void loadDbRows({ page: dbPage + 1 })}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-30">Next →</button>
            </div>
            <p className="text-[11px] text-slate-600">
              Uniqueness: same normalized name within ~111 m geocell, same phone digits, or same email → merged into one row.
              Later sightings fill only blank fields and bump the Sightings counter.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
