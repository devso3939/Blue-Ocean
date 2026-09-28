// ─── v6.9.110: User accounts — email sign-in/sign-up (Supabase GoTrue) ───
// Minimal REST client against the project's built-in auth endpoints. No
// SDK dependency: the same fetch + anon-key pattern the engine already
// uses for RPCs. The session (access + refresh JWT) lives in localStorage
// and is refreshed transparently before expiry.
//
//   • sign-up posts to /auth/v1/signup (email confirmation off → returns
//     a session immediately; on → email confirmation required)
//   • sign-in posts to /auth/v1/token?grant_type=password
//   • every signed-in RPC carries `Authorization: Bearer <access_token>`
//     so PostgREST's auth.uid() resolves server-side
//   • prefs + run archive sync ride the existing RPC surface (migration 019)

import { supabaseAuthFetch, detectRecoveryToken } from './authFetch';

const SB_URL = 'https://bfoagnqjkoqhogxvkvkw.supabase.co';
const SB_ANON = 'sb_publishable_UtCOExOHddCZ0UbTxbruWg_3m1U7a-0';

const LS_KEY = 'bo_auth_session_v1';

export interface BoSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;     // epoch seconds
  userId: string;
  email: string;
}

export function getStoredSession(): BoSession | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as BoSession;
    return s && s.accessToken && s.userId ? s : null;
  } catch { return null; }
}

function storeSession(s: BoSession | null): void {
  try {
    if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
    else localStorage.removeItem(LS_KEY);
  } catch { /* storage full — session stays memory-only for this page */ }
}

export function currentUserId(): string | null {
  return getStoredSession()?.userId ?? null;
}

export function currentUserEmail(): string | null {
  return getStoredSession()?.email ?? null;
}

/** True when the stored access token is expired (or expires within 60s). */
export function sessionExpired(): boolean {
  const s = getStoredSession();
  return !s || s.expiresAt - 60 <= Date.now() / 1000;
}

interface AuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string };
  error_description?: string;
  error?: string;
  msg?: string;
}

function toSession(r: AuthResponse): BoSession | null {
  if (!r.access_token || !r.user?.id) return null;
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token || '',
    expiresAt: Math.floor(Date.now() / 1000) + (r.expires_in || 3600),
    userId: r.user.id,
    email: r.user.email || '',
  };
}

// v6.9.111: an AuthResponse that carries user fields but no new token pair
// (e.g. PUT /auth/v1/user) still resolves to the user's identity.

/**
 * v6.9.111: GoTrue's refresh-grant responses (recovery-link exchange) and
 * some PUT /user responses carry token fields but NO `user` object — parse
 * the identity straight out of the access token's JWT claims instead.
 */
function jwtClaims(token?: string): { sub?: string; email?: string } {
  try {
    if (!token || token.length < 40) return {};
    const payload = token.split('.')[1];
    if (!payload) return {};
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)) || {};
  } catch { return {}; }
}

export async function signUp(email: string, password: string): Promise<{ session: BoSession | null; needsConfirm: boolean; error?: string }> {
  try {
    // v6.9.112: confirmation links return the user to this exact page too.
    const r = await postAuthEmail('signup', { email, password }) as AuthResponse;
    if (r.error_description || r.error || r.msg) return { session: null, needsConfirm: false, error: r.error_description || r.error || r.msg };
    const session = toSession(r);
    if (session) storeSession(session);
    // No session but no error → confirmation email sent.
    return { session, needsConfirm: !session, error: undefined };
  } catch (e) {
    return { session: null, needsConfirm: false, error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

export async function signIn(email: string, password: string): Promise<{ session: BoSession | null; error?: string }> {
  try {
    const r = await supabaseAuthFetch<AuthResponse>(`${SB_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.error_description || r.error || r.msg) {
      const msg = r.error_description || r.error || r.msg || 'Sign-in failed';
      return { session: null, error: /invalid login/i.test(msg) ? 'Wrong email or password.' : msg.slice(0, 120) };
    }
    const session = toSession(r);
    if (session) storeSession(session);
    return { session, error: session ? undefined : 'Sign-in failed — try again.' };
  } catch (e) {
    return { session: null, error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

export async function refreshSession(): Promise<BoSession | null> {
  const s = getStoredSession();
  if (!s?.refreshToken) { storeSession(null); return null; }
  try {
    const r = await supabaseAuthFetch<AuthResponse>(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    if (r.error_description || r.error) { storeSession(null); return null; }
    const fresh = toSession(r);
    storeSession(fresh);
    return fresh;
  } catch { return null; }
}

export function signOut(): void {
  const s = getStoredSession();
  if (s?.refreshToken) {
    // Best-effort server-side revoke; local wipe happens regardless.
    void supabaseAuthFetch(`${SB_URL}/auth/v1/logout?scope=global`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.accessToken}` },
      body: JSON.stringify({}),
    }).catch(() => {});
  }
  storeSession(null);
}

/** Valid (refreshed if needed) access token, or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
  let s = getStoredSession();
  if (!s) return null;
  if (sessionExpired()) {
    s = await refreshSession();
    if (!s) return null;
  }
  return s.accessToken;
}

// ── v6.9.111: forgot password — request reset + set new password ──

/**
 * v6.9.112: POST an auth-email endpoint asking GoTrue to return the user to
 * the exact page that made the request (email_redirect_to). When the project's
 * redirect allow-list rejects the URL, retry without it — the email then uses
 * the project's Site URL default (see backend/supabase/README.md, "Auth email
 * redirects", for the dashboard allow-list this depends on).
 */
async function postAuthEmail(path: string, body: Record<string, unknown>): Promise<unknown> {
  const post = (redirectTo?: string) => supabaseAuthFetch(`${SB_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(redirectTo ? { ...body, email_redirect_to: redirectTo } : body),
  });
  try {
    noteRedirectRequest(); // v6.9.113: remember for redirect diagnostics
    return await post(location.origin + location.pathname);
  } catch (e) {
    if (/redirect/i.test(String((e as Error)?.message))) return await post();
    throw e;
  }
}

/**
 * Send a password-recovery email. Always succeeds from the UI's point of
 * view (GoTrue returns 200 even for unknown addresses — deliberately
 * identical so the endpoint can't be used to enumerate accounts), so the
 * caller shows a neutral "check your inbox" message either way.
 */
export async function requestPasswordReset(email: string): Promise<{ sent: boolean; error?: string }> {
  try {
    await postAuthEmail('recover', { email });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

/**
 * Set a new password using the recovery session created by the email link.
 * Returns the (possibly refreshed) session — GoTrue rotates the access and
 * refresh tokens on a password change, so callers must adopt the result.
 */
export async function updatePassword(password: string): Promise<{ session: BoSession | null; error?: string }> {
  try {
    // Auto-refresh an expired stored session first — the bearer must be live.
    await getAccessToken();
    const s = getStoredSession();
    if (!s?.accessToken) return { session: null, error: 'Your session has expired — sign in again.' };
    const r = await supabaseAuthFetch<AuthResponse>(`${SB_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.accessToken}` },
      body: JSON.stringify({ password }),
    });
    const emsg = r.error_description || r.error || r.msg;
    if (emsg) return { session: null, error: emsg.slice(0, 120) };
    // Token rotation: adopt any new pair; fall back to JWT-claim identity
    // when the response omits the user object (seen on some GoTrue versions).
    const claims = jwtClaims(r.access_token);
    const fresh: BoSession = toSession(r) || {
      accessToken: r.access_token || s.accessToken,
      refreshToken: r.refresh_token || s.refreshToken,
      expiresAt: r.expires_in ? Math.floor(Date.now() / 1000) + r.expires_in : Math.floor(Date.now() / 1000) + 3600,
      userId: claims.sub || s.userId,
      email: claims.email || s.email,
    };
    if (!fresh.refreshToken) fresh.refreshToken = s.refreshToken;
    storeSession(fresh);
    return { session: fresh };
  } catch (e) {
    return { session: null, error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

/**
 * Consume a recovery link landing (`#access_token=…&type=recovery`). Exchanges
 * the one-time token for a session (keeping the user's existing refresh token
 * when GoTrue doesn't rotate it), wipes the hash from the address bar, and
 * reports whether a password-reset form should be shown.
 */
export async function consumeRecoveryLink(): Promise<boolean> {
  const token = detectRecoveryToken();
  if (!token) return false;
  // Scrub the hash immediately so a refresh / share can't replay the token.
  try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
  try {
    const r = await supabaseAuthFetch<AuthResponse>(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (r.error_description || r.error) return false;
    if (!r.access_token) return false;
    // Refresh-grant responses may omit `user` — take identity from JWT claims,
    // keeping the previous session's identity as a last resort.
    const claims = jwtClaims(r.access_token);
    const prev = getStoredSession();
    const session: BoSession = {
      accessToken: r.access_token,
      refreshToken: r.refresh_token || prev?.refreshToken || '',
      expiresAt: Math.floor(Date.now() / 1000) + (r.expires_in || 3600),
      userId: r.user?.id || claims.sub || prev?.userId || '',
      email: r.user?.email || claims.email || prev?.email || '',
    };
    if (!session.userId) return false;
    storeSession(session);
    recordRecoveryLanding(); // v6.9.113: diagnostics saw the landing
    return true;
  } catch { return false; }
}

// ── v6.9.113: auth redirect diagnostics (Settings panel) ─────────────
// Makes the GoTrue redirect allow-list problem visible in-app: what the
// client requests, what the project is configured with, and where the last
// recovery email ACTUALLY landed (the fallback is silent otherwise).

const REDIRECT_REQ_KEY = 'bo_auth_redirect_req_v1';
const REDIRECT_LANDING_KEY = 'bo_auth_redirect_landing_v1';

export interface RedirectDiagnostics {
  /** Exactly what the client asks GoTrue to honor (email_redirect_to). */
  requestedRedirect: string;
  /** Project Site URL (default link target), '' when the probe failed. */
  siteUrl: string;
  /** Project Redirect URLs allow-list, [] when the probe failed. */
  allowList: string[];
  /** false → the /auth/v1/settings probe failed (CORS/offline). */
  allowListKnown: boolean;
  /** Where the last recovery email landed, when seen by this browser. */
  lastLanding: { at: number; url: string } | null;
  /** null → no landing recorded; false → allow-list fell back to Site URL. */
  landingMatchesRequest: boolean | null;
  /** Live server-side probe of the allow-list (migration 020 RPC). */
  probeVerdict: 'honored' | 'not-honored' | 'unknown';
  probeDetail: string;
}

/** GoTrue-style allow-list match: exact, or glob via `*`. */
export function redirectAllows(url: string, pattern: string): boolean {
  if (url === pattern) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url);
}

function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.origin + ua.pathname === ub.origin + ub.pathname;
  } catch { return a === b; }
}

/** Remember which page requested an auth email (called before the POST). */
function noteRedirectRequest(): void {
  try { localStorage.setItem(REDIRECT_REQ_KEY, location.origin + location.pathname); } catch { /* private mode */ }
}

/**
 * Record where a recovery link actually landed. Call right after
 * consumeRecoveryLink() returns true — the hash is already scrubbed by then,
 * so the URL is reconstructed as origin+path+search (enough for allow-list
 * matching). Falls back to the current page when no request was recorded
 * in this browser (email opened on another device).
 */
export function recordRecoveryLanding(): void {
  try {
    const landing = location.origin + location.pathname + location.search;
    const requested = localStorage.getItem(REDIRECT_REQ_KEY) || location.origin + location.pathname;
    localStorage.setItem(REDIRECT_LANDING_KEY, JSON.stringify({ at: Date.now(), url: landing, requested }));
  } catch { /* private mode */ }
}

async function fetchAuthConfig(): Promise<{ siteUrl: string; allowList: string[] } | null> {
  try {
    const r = await fetch(`${SB_URL}/auth/v1/settings`, { headers: { 'apikey': SB_ANON }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d: any = await r.json();
    // The PUBLIC settings endpoint does not expose site_url/redirect_urls
    // (admin-only). Only report data when the fields are actually present;
    // otherwise the caller shows an honest "unknown" instead of a misleading
    // "allow-list is empty".
    const list = d?.external?.redirect_urls ?? d?.redirect_urls;
    const siteUrl = d?.external?.site_url ?? d?.site_url;
    const hasData = typeof siteUrl === 'string' || Array.isArray(list);
    if (!hasData) return null;
    return { siteUrl: typeof siteUrl === 'string' ? siteUrl : '', allowList: Array.isArray(list) ? list : [] };
  } catch { return null; }
}

/**
 * v6.9.114: live allow-list probe via the migration-020 RPC. GoTrue answers
 * the verify endpoint with a 302 to the honored URL (or the Site URL when
 * rejected); the server-side pg_net follower reports where it landed.
 *   honored candidate  → 'followed' (final page fetched)
 *   rejected candidate → 'follow-failed' (Site URL typically unreachable)
 * A baseline probe of a never-allow-listed URL shares the rejected
 * signature, so channel trouble (both arms 'timeout') reads as unknown.
 * The two probes run SEQUENTIALLY — burst submissions to one host made
 * pg_net fail every parallel connection ("Couldn't connect to server").
 */
async function probeOnce(candidate: string): Promise<{ result: string; detail?: string; status?: string } | null> {
  try {
    const start = await supabaseAuthFetch<{ rids?: (number | null)[]; error?: string }>(
      `${SB_URL}/rest/v1/rpc/rpc_auth_redirect_probe_start`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_candidates: [candidate] }),
      });
    const rid = start?.rids?.[0];
    if (!rid) return { result: 'submit-failed', detail: start?.error };
    await new Promise(r => setTimeout(r, 2200)); // pg_net worker round-trip
    const poll = await supabaseAuthFetch<{ responses?: Record<string, { result: string; detail?: string; status?: string }> }>(
      `${SB_URL}/rest/v1/rpc/rpc_auth_redirect_probe_poll`, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_rids: [rid] }),
      });
    return poll?.responses?.[`_${rid}`] ?? { result: 'no-response' };
  } catch (e) {
    return { result: 'rpc-error', detail: String((e as Error)?.message || e).slice(0, 80) };
  }
}

async function probeAllowList(requested: string): Promise<{ verdict: RedirectDiagnostics['probeVerdict']; detail: string }> {
  const baseline = await probeOnce('https://allowlist-probe.invalid/');
  const page = await probeOnce(requested);
  if (!page || page.result === 'timeout' || page.result === 'submit-failed' || page.result === 'rpc-error') {
    return { verdict: 'unknown', detail: `probe unavailable (${page?.result || 'no response'})` };
  }
  if (page.result === 'followed') {
    return { verdict: 'honored', detail: `GoTrue accepted this URL (followed to a ${page.status || '?'} response)` };
  }
  // follow-failed: rejected, or honored-but-target-unreachable. The baseline
  // (always rejected) shows the same signature — a matching baseline confirms
  // the probe channel itself works and the page URL was genuinely not honored.
  const rejected = baseline?.result === 'follow-failed';
  return {
    verdict: rejected ? 'not-honored' : 'unknown',
    detail: rejected
      ? `GoTrue did NOT accept this URL (redirect fell back to the Site URL: ${page.detail || 'unreachable'})`
      : `inconclusive (${page.detail || page.result})`,
  };
}

export async function getRedirectDiagnostics(): Promise<RedirectDiagnostics> {
  const requested = (() => { try { return localStorage.getItem(REDIRECT_REQ_KEY) || location.origin + location.pathname; } catch { return location.origin + location.pathname; } })();
  const cfg = await fetchAuthConfig();
  let lastLanding: RedirectDiagnostics['lastLanding'] = null;
  try {
    const raw = localStorage.getItem(REDIRECT_LANDING_KEY);
    if (raw) { const p = JSON.parse(raw); if (p?.url) lastLanding = { at: p.at, url: p.url }; }
  } catch { /* ignore */ }
  const probe = await probeAllowList(requested);
  return {
    requestedRedirect: requested,
    siteUrl: cfg?.siteUrl ?? '',
    allowList: cfg?.allowList ?? [],
    allowListKnown: !!cfg,
    lastLanding,
    landingMatchesRequest: lastLanding ? samePage(lastLanding.url, requested) : null,
    probeVerdict: probe.verdict,
    probeDetail: probe.detail,
  };
}
