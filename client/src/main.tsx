import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminPanel from './AdminPanel'
import ErrorBoundary from './ErrorBoundary'
import './index.css'

// v6.9.120: /admin route — the Pages SPA is served from /Blue-Ocean/, so the
// admin console lives at /Blue-Ocean/admin (also reachable as /admin on the
// bare domain via the redirector's 404 forward). Render it WITHOUT the app
// chrome so the console stays isolated from user sessions.
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
