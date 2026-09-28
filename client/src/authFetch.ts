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

/** Current stored access token (raw — callers refresh via getAccessToken()). */
export function storedAccessToken(): string | null {
  try {
    const raw = localStorage.getItem('bo_auth_session_v1');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s?.accessToken || null;
  } catch { return null; }
}
