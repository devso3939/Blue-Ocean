import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminPanel from './AdminPanel'
import ErrorBoundary from './ErrorBoundary'
import './index.css'

// v6.9.120: /admin route — the Pages SPA is served from /Blue-Ocean/, so the
// admin console lives at /Blue-Ocean/admin. GitHub Pages has no server-side
// rewrites: deep links hit the bundled 404.html, which boots the SPA with the
// ORIGINAL path passed as ?__route=… — restore it here (v6.9.121), then let
// the route check decide between the console and the app.
(function restore404Route() {
  try {
    const p = new URLSearchParams(location.search);
    const r = p.get('__route');
    if (r) {
      p.delete('__route');
      const qs = p.toString();
      history.replaceState(null, '', r + (qs ? `?${qs}` : '') + location.hash);
      sessionStorage.removeItem('bo_404_reload'); // clean URL restored — guard off
    }
  } catch { /* best effort */ }
})();

const ADMIN_ROUTE = /\/(blue-ocean)?\/?admin\/?$/i.test(location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {ADMIN_ROUTE
        ? <AdminPanel />
        : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
)

// Stale-chunk auto-recovery: importing the maplibre chunk is the first thing
// every scan/map flow does. If it 404s (classic stale-deploy black screen),
// reload once with cache-busting so index.html and chunks refresh together.
import('maplibre-gl').catch((e) => {
  console.error('[BlueOcean] map engine chunk failed to load (stale deploy?) — reloading once', e);
  const k = 'bo_chunk_reload';
  if (sessionStorage.getItem(k) !== '1') {
    sessionStorage.setItem(k, '1');
    location.reload();
  }
});
