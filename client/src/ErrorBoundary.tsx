import React from 'react';

// v6.9.28: Global ErrorBoundary — until now ANY render error (or a failed
// dynamic import of a stale deploy chunk) unmounted the whole app and left a
// permanent BLACK SCREEN with no message and no recovery. This boundary
// catches render/import errors, shows what went wrong, and offers real
// recovery: a hard reload (busts stale index.html caches) and a cache wipe
// (clears old localStorage that may hold incompatible state).
interface Props { children: React.ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface in devtools even when the UI is broken
    console.error('[BlueOcean] crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0b1120', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif', padding: 24,
      }}>
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Blue Ocean hit an unexpected error</h1>
          <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>
            This is usually a stale cached version after an update. A reload fixes it.
          </p>
          <p style={{
            fontSize: 11, color: '#64748b', background: '#1e293b', borderRadius: 8,
            padding: '8px 12px', margin: '12px 0', overflowWrap: 'anywhere', textAlign: 'left',
          }}>
            {String(this.state.error?.message || this.state.error)}
          </p>
          <button
            onClick={() => {
              try { localStorage.removeItem('bo_cache_version'); } catch { /* ignore */ }
              location.reload();
            }}
            style={{
              background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', color: '#fff', border: 'none',
              borderRadius: 10, padding: '10px 28px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              marginRight: 10,
            }}
          >
            ⟳ Reload app
          </button>
          <button
            onClick={() => {
              try {
                Object.keys(localStorage).filter(k => k.startsWith('bo_')).forEach(k => localStorage.removeItem(k));
              } catch { /* ignore */ }
              location.reload();
            }}
            style={{
              background: 'transparent', color: '#94a3b8', border: '1px solid #334155',
              borderRadius: 10, padding: '10px 20px', fontSize: 13, cursor: 'pointer',
            }}
          >
            Clear app data & reload
          </button>
        </div>
      </div>
    );
  }
}
