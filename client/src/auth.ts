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
    const r = await supabaseAuthFetch<AuthResponse>(`${SB_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
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
 * Send a password-recovery email. Always succeeds from the UI's point of
 * view (GoTrue returns 200 even for unknown addresses — deliberately
 * identical so the endpoint can't be used to enumerate accounts), so the
 * caller shows a neutral "check your inbox" message either way.
 */
export async function requestPasswordReset(email: string): Promise<{ sent: boolean; error?: string }> {
  const post = (redirectTo?: string) => supabaseAuthFetch(`${SB_URL}/auth/v1/recover`, {
    method: 'POST',
    headers: { 'apikey': SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(redirectTo ? { email, email_redirect_to: redirectTo } : { email }),
  });
  try {
    // Ask GoTrue to return the user to the page that requested the reset.
    // Projects with a redirect allow-list that excludes us still succeed —
    // the email then uses the project's default (SITE_URL) redirect.
    try {
      await post(location.origin + location.pathname);
    } catch (e) {
      if (/redirect/i.test(String((e as Error)?.message))) await post();
      else throw e;
    }
    // GoTrue answers 200 even for unknown addresses (no account enumeration).
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
    return true;
  } catch { return false; }
}
