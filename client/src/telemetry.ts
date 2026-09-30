// v6.9.120: client telemetry + suspension enforcement helpers.
// Kept dependency-free so both App.tsx and AdminPanel-adjacent flows can use
// it without cycles. All network calls are fire-and-forget with hard timeouts;
// nothing here may ever delay or break a user interaction.

const SB_URL = 'https://bfoagnqjkoqhogxvkvkw.supabase.co';
const SB_ANON = 'sb_publishable_UtCOExOHddCZ0UbTxbruWg_3m1U7a-0';

/** Stable anonymous browser session id (per browser profile, 30-day rotation). */
export function browserSessionId(): string {
  try {
    const K = 'bo_bsid_v1';
    const now = Date.now();
    const raw = localStorage.getItem(K);
    if (raw) {
      const s = JSON.parse(raw) as { id: string; at: number };
      if (s.id && now - s.at < 30 * 86400_000) return s.id;
    }
    const id = (crypto?.randomUUID?.() || `bs-${now}-${Math.floor(Math.random() * 1e9)}`);
    localStorage.setItem(K, JSON.stringify({ id, at: now }));
    return id;
  } catch { return 'no-ls'; }
}

/**
 * Log one traffic event (boot). Auth: the anon key only — Supabase stamps
 * user_id server-side when an Authorization bearer is present, which lets the
 * admin console split guest vs signed-in sessions. Never throws.
 */
export function logBootEvent(path: string, version: string, accessToken?: string | null): void {
  try {
    void fetch(`${SB_URL}/rest/v1/rpc/rpc_event_log`, {
      method: 'POST',
      headers: {
        'apikey': SB_ANON,
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        p_event: 'boot', p_path: path.slice(0, 200),
        p_session: browserSessionId(), p_version: version.slice(0, 20),
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => { /* fire-and-forget */ });
  } catch { /* never break boot */ }
}

export interface SuspensionInfo { suspended: boolean; reason?: string }

/**
 * Server-side suspension check for the stored session's token. Returns null
 * when the token is absent/dead (caller falls back to normal auth flows).
 */
export async function checkSuspension(accessToken: string): Promise<SuspensionInfo | null> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/rpc_user_status_get`, {
      method: 'POST',
      headers: {
        'apikey': SB_ANON,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json() as SuspensionInfo;
  } catch { return null; }
}
