// ── v6.9.116: imperative auth toast ──────────────────────────────────
// The confirmation toast must survive App re-renders/remounts (observed
// live during the confirmation-landing flow), so it renders OUTSIDE React:
// a styled DOM node appended to document.body, auto-removed after 6s.
// Queue-based like the rest of the flow: consumeAuthLink writes the flag,
// the App bootstrap (and this module's own poll) pops it.

const TOAST_FLAG = 'bo_auth_confirm_toast_v1';

export function showAuthToast(text: string, ttlMs = 6000): void {
  try {
    const host = document.body;
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'status');
    wrap.style.cssText = 'position:fixed;left:0;right:0;top:64px;z-index:9999;display:flex;justify-content:center;padding:0 16px;pointer-events:none;animation:bo-toast-in .25s ease-out;';
    wrap.innerHTML =
      '<div style="pointer-events:auto;display:flex;align-items:center;gap:8px;border-radius:9999px;border:1px solid rgba(16,185,129,.4);background:rgba(16,185,129,.15);padding:8px 16px;font-size:14px;font-weight:600;color:#6ee7b7;box-shadow:0 20px 25px -5px rgba(0,0,0,.3);backdrop-filter:blur(8px)">'
      + text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
      + '<button aria-label="Dismiss" style="margin-left:4px;border:none;background:none;color:rgba(110,231,183,.7);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:9999px">✕</button></div>';
    wrap.querySelector('button')?.addEventListener('click', () => wrap.remove());
    // Mark the node so a duplicate queue-consume can't stack a second copy.
    wrap.setAttribute('data-bo-auth-toast', '1');
    wrap.setAttribute('data-bo-auth-toast-text', text);
    host.appendChild(wrap);
    setTimeout(() => wrap.remove(), ttlMs);
  } catch { /* non-DOM env */ }
}

/** Pop a queued toast (written by auth.ts before the session) once. */
export function consumeQueuedAuthToast(): void {
  try {
    const queued = sessionStorage.getItem(TOAST_FLAG);
    if (queued) {
      sessionStorage.removeItem(TOAST_FLAG);
      // The bootstrap usually shows the toast directly after the exchange;
      // skip here if that identical toast is already on screen.
      const live = document.querySelector('[data-bo-auth-toast]');
      if (live?.getAttribute('data-bo-auth-toast-text') !== queued) showAuthToast(queued);
    }
  } catch { /* private mode */ }
}

/**
 * Poll briefly for a queued toast — covers the remount path where the
 * first App instance performed the exchange and a later instance must
 * surface the message. Runs ~20s, then gives up.
 */
export function startAuthToastPoll(): void {
  let polls = 0;
  const iv = setInterval(() => {
    polls++;
    consumeQueuedAuthToast();
    if (polls > 40) clearInterval(iv);
  }, 500);
}
