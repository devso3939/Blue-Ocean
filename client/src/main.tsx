import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import './index.css'

// v6.9.28: ErrorBoundary wraps the app — a render crash or a failed dynamic
// import (stale deploy chunk 404) now shows a recovery screen instead of a
// permanent black screen. It also pre-warms the maplibre chunk: if THAT import
// fails (old cached index.html pointing at deleted assets), we hard-reload
// once so the fresh index.html + assets load together.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
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
