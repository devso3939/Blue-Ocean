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

type Tab = 'overview' | 'traffic' | 'runs' | 'users';

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
      </main>
    </div>
  );
}
