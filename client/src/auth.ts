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

import { supabaseAuthFetch } from './authFetch';

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
