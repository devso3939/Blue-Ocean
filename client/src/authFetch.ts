// v6.9.110: thin JSON fetch wrapper shared by the auth module. Kept in its
// own file so auth.ts stays dependency-light and supabaseRpc can import the
// bearer-token helper without a circular dependency.

export async function supabaseAuthFetch<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(body?.error_description || body?.msg || body?.error || `HTTP ${res.status}`) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

/**
 * v6.9.111: detect a recovery-link landing. Supabase's implicit flow puts
 * the grant in the URL fragment (never sent to a server):
 *   #access_token=<jwt>&expires_in=…&refresh_token=<one-time>&token_type=bearer&type=recovery
 * Returns the refresh_token when this is a recovery landing, else null.
 */
export function detectRecoveryToken(): string | null {
  try {
    if (!location.hash || location.hash.length < 8) return null;
    const p = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
    if (p.get('type') !== 'recovery') return null;
    const rt = p.get('refresh_token');
    return rt ? rt : null;
  } catch { return null; }
}

/** Current stored access token (raw — callers refresh via getAccessToken()). */
export function storedAccessToken(): string | null {
  try {
    const raw = localStorage.getItem('bo_auth_session_v1');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s?.accessToken || null;
  } catch { return null; }
}
