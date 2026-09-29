// ── v6.9.115: AuthPanel — the full auth experience in one component ──
// Replaces the three ad-hoc panels (sign-in/up/forgot, set-new-password,
// change-password) with a single polished, accessible flow:
//   • segmented Sign in / Sign up tabs + Forgot-password sub-view
//   • icon-prefixed fields, show/hide password, Enter submits
//   • inline field errors + caps-lock warning, blur-on-touch validation
//   • password strength meter + live requirement checklist (sign-up)
//   • spinner button states, disabled-while-busy, success moments
//   • "check your inbox" screen with resend (60s cooldown)
//   • friendly server-error mapping with a contextual forgot-password link
// All markup is plain Tailwind on the app's existing theme tokens.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BoSession } from './auth';

export type AuthView = 'signin' | 'signup' | 'forgot' | 'sent' | 'setpw' | 'changepw';

export interface AuthPanelProps {
  view: AuthView;
  onView: (v: AuthView) => void;
  session: BoSession | null;
  recoverySession: BoSession | null;
  busy: boolean;
  message: { kind: 'err' | 'ok'; text: string } | null;
  email: string;
  onEmail: (v: string) => void;
  /** What kind of email the 'sent' screen refers to (copy differs). */
  sentKind: 'confirm' | 'reset';
  onClose: () => void;
  onSignIn: (email: string, pw: string) => Promise<void>;
  onSignUp: (email: string, pw: string) => Promise<void>;
  onForgot: (email: string) => Promise<void>;
  onResend: (email: string) => Promise<void>;
  /** v6.9.117: unconfirmed-email sign-in → show the confirmation inbox screen (parent owns sentKind). */
  onShowInboxConfirm: (email: string) => void;
  onSetNewPassword: (pw: string) => Promise<void>;
  onChangePassword: (pw: string) => Promise<void>;
  onSignOut: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function emailErr(v: string): string | null {
  if (!v.trim()) return 'Email is required.';
  if (!EMAIL_RE.test(v.trim().toLowerCase())) return 'That doesn’t look like a valid email.';
  return null;
}

function pwErr(v: string): string | null {
  if (!v) return 'Password is required.';
  if (v.length < 6) return 'Use at least 6 characters.';
  return null;
}

/** 0–4 strength score for the meter (length + variety). */
function pwScore(v: string): number {
  if (!v) return 0;
  let s = 0;
  if (v.length >= 6) s++;
  if (v.length >= 10) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) s++;
  return Math.min(s, 4);
}

const STRENGTH = [
  { label: '', cls: '' },
  { label: 'Weak', cls: 'bg-red-500' },
  { label: 'Fair', cls: 'bg-amber-500' },
  { label: 'Good', cls: 'bg-lime-500' },
  { label: 'Strong', cls: 'bg-emerald-500' },
];

function pwChecks(v: string) {
  return [
    { ok: v.length >= 6, label: '6+ characters' },
    { ok: /[A-Z]/.test(v) && /[a-z]/.test(v), label: 'Mixed case' },
    { ok: /\d/.test(v) || /[^A-Za-z0-9]/.test(v), label: 'Number or symbol' },
    { ok: v.length >= 10, label: '10+ characters (recommended)' },
  ];
}

/** Map raw GoTrue errors to friendly copy + an optional recovery action. */
export function friendlyAuthError(raw: string): { text: string; suggestForgot?: boolean } {
  const m = raw.toLowerCase();
  if (/invalid login/.test(m)) return { text: 'Wrong email or password. Double-check and try again.', suggestForgot: true };
  if (/email not confirmed/.test(m)) return { text: 'This email hasn’t been confirmed yet — check your inbox for the confirmation link.' };
  if (/rate limit/.test(m)) return { text: 'Too many attempts — wait a minute and try again.' };
  if (/already registered|user already/.test(m)) return { text: 'An account with this email already exists — try signing in instead.' };
  if (/password should be different/.test(m)) return { text: 'The new password must be different from the current one.' };
  if (/invalid format/.test(m) && /email/.test(m)) return { text: 'That email address doesn’t look valid.' };
  if (/failed to fetch|network|timeout/i.test(m)) return { text: 'Network hiccup — check your connection and try again.' };
  return { text: raw };
}

// ── Small building blocks ───────────────────────────────────────────

function Spinner({ cls = '' }: { cls?: string }) {
  return (
    <svg className={`animate-spin ${cls}`} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Field({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm opacity-70" aria-hidden="true">{icon}</span>
      {children}
    </div>
  );
}

const inputCls =
  'h-11 w-full rounded-lg border border-border bg-background pl-10 pr-11 text-sm text-foreground placeholder:text-muted-foreground/70 outline-none transition-all focus:border-primary/60 focus:ring-2 focus:ring-ring/50 aria-[invalid=true]:border-red-500/60';

function Msg({ kind, text }: { kind: 'err' | 'ok'; text: string }) {
  return (
    <div
      role={kind === 'err' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
        kind === 'err' ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      }`}
    >
      <span aria-hidden="true">{kind === 'err' ? '⚠️' : '✅'}</span>
      <span>{text}</span>
    </div>
  );
}

function PrimaryButton({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel?: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 text-sm font-semibold text-white shadow-lg transition-all hover:from-indigo-600 hover:to-violet-600 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? (<><Spinner /> {busyLabel || 'Working…'}</>) : label}
    </button>
  );
}

function PasswordInput({
  value, onChange, onEnter, placeholder, autoComplete, invalid, id,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder: string;
  autoComplete: string;
  invalid?: boolean;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <Field icon="🔑">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)}
        onBlur={() => setCaps(false)}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) onEnter(); }}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        className={inputCls}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {show ? '🙈' : '👁️'}
      </button>
      {caps && !show && (
        <span className="absolute -top-5 right-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">Caps Lock is on</span>
      )}
    </Field>
  );
}

// ── The panel ────────────────────────────────────────────────────────

export default function AuthPanel(props: AuthPanelProps) {
  const { view, onView, session, recoverySession, busy, message, email, onEmail, onClose } = props;
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; pw?: boolean; pw2?: boolean }>({});
  const [resendIn, setResendIn] = useState(0);
  const sentEmailRef = useRef('');

  // v6.9.117: remember WHICH address the sent screen refers to. The parent
  // owns the email field and may clear/change it (or the user may edit it
  // on another view) — "We sent a link to …" must stay accurate and Resend
  // must target the address that actually triggered the email.
  useEffect(() => {
    if (view === 'sent') {
      if (email.trim()) sentEmailRef.current = email.trim().toLowerCase();
    }
  }, [view, email]);

  useEffect(() => {
    if (view !== 'sent') return;
    setResendIn(60);
    const t = setInterval(() => setResendIn(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [view]);

  // Entering a fresh view clears stale input/errors from the previous one.
  useEffect(() => { setTouched({}); }, [view]);
  const clearSecrets = () => { setPw(''); setPw2(''); };

  const needsConfirm = view === 'sent';
  const emailTrim = email.trim().toLowerCase();
  const isPwView = view === 'signin' || view === 'signup' || view === 'setpw' || view === 'changepw';

  const eErr = touched.email ? emailErr(email) : null;
  const pErr = touched.pw ? pwErr(pw) : null;
  const mErr = touched.pw2 && pw2 !== pw ? 'Passwords don’t match.' : null;
  const score = useMemo(() => pwScore(pw), [pw]);
  const checks = useMemo(() => pwChecks(pw), [pw]);

  const submit = async () => {
    setTouched({ email: true, pw: true, pw2: true });
    // v6.9.117: password-only views (setpw/changepw) render NO email field —
    // validating the shared email state there silently blocked submission
    // whenever it was empty (e.g. a recovery link opened in a fresh browser).
    const needsEmail = view !== 'setpw' && view !== 'changepw';
    if ((needsEmail && emailErr(email)) || (isPwView && (pwErr(pw) || ((view === 'setpw' || view === 'changepw') && pw2 !== pw)))) return;
    try {
      if (view === 'signin') await props.onSignIn(emailTrim, pw);
      else if (view === 'signup') await props.onSignUp(emailTrim, pw);
      else if (view === 'forgot') { sentEmailRef.current = emailTrim; await props.onForgot(emailTrim); }
      else if (view === 'sent') { if (resendIn === 0) { await props.onResend(sentEmailRef.current || emailTrim); setResendIn(60); } }
      else if (view === 'setpw') await props.onSetNewPassword(pw);
      else if (view === 'changepw') await props.onChangePassword(pw);
    } finally { /* busy flags are managed by the parent */ }
  };
  const title =
    view === 'signin' ? 'Welcome back' :
    view === 'signup' ? 'Create your free account' :
    view === 'forgot' ? 'Reset your password' :
    view === 'sent' ? 'Check your inbox' :
    view === 'setpw' ? 'Set a new password' : 'Change password';

  const sub =
    view === 'signin' ? 'Your run history and preferences sync across devices while signed in.' :
    view === 'signup' ? 'Scans backed up to the cloud · preferences follow you to any device.' :
    view === 'forgot' ? 'Enter your email and we’ll send you a link to choose a new password.' :
    needsConfirm ? null :
    view === 'setpw' ? `Choose a new password for ${recoverySession?.email || 'your account'}.` :
    `Signed in as ${session?.email || ''}.`;

  return (
    <section className="mx-auto max-w-md px-4 pt-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card/60 shadow-2xl shadow-black/20">
        {/* header */}
        <div className="border-b border-border/70 bg-gradient-to-r from-indigo-500/10 via-violet-500/10 to-transparent px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-foreground">
                {view === 'signin' && '👋 '}{view === 'signup' && '✨ '}{view === 'forgot' && '🔑 '}{view === 'sent' && '📬 '}{view === 'setpw' && '🔒 '}{view === 'changepw' && '🔑 '}
                {title}
              </h2>
            </div>
            <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">✕ close</button>
          </div>
          {sub && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sub}</p>}
        </div>

        <div className="px-5 py-4">
          {/* segmented tabs */}
          {(view === 'signin' || view === 'signup') && (
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1" role="tablist">
              {(['signin', 'signup'] as const).map(v => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => { clearSecrets(); props.onView(v); }}
                  className={`h-9 rounded-md text-xs font-semibold transition-all ${
                    view === v ? 'bg-card text-foreground shadow ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {v === 'signin' ? 'Sign in' : 'Sign up'}
                </button>
              ))}
            </div>
          )}

          {message && <div className="mb-3"><Msg kind={message.kind} text={message.text} /></div>}

          {/* ── sent (check your inbox) ── */}
          {view === 'sent' ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-secondary/40 px-3 py-3">
                <span className="text-2xl" aria-hidden="true">📧</span>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {props.sentKind === 'reset' ? (
                    <>We sent a password-reset link to <b className="text-foreground">{sentEmailRef.current || emailTrim}</b>. Open it on this device to choose a new password. Didn’t get it? Check spam, or <button type="button" onClick={() => onView('forgot')} className="text-primary hover:underline">request a new link</button>.</>
                  ) : (
                    <>We sent a confirmation link to <b className="text-foreground">{sentEmailRef.current || emailTrim}</b>. <b className="text-foreground">Open it on this device and you’re signed in instantly</b> — no extra step. Didn’t get it? Check spam, or resend below.</>
                  )}
                </p>
              </div>
              {props.sentKind === 'confirm' && (
                <button
                  onClick={() => { if (resendIn === 0 && !busy) void submit(); }}
                  disabled={resendIn > 0 || busy}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-primary/40 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <><Spinner /> Sending…</> : resendIn > 0 ? `Resend available in ${resendIn}s` : '✉️ Resend confirmation email'}
                </button>
              )}
              <div className="text-center text-xs text-muted-foreground">
                <button onClick={() => { clearSecrets(); onView('signin'); }} className="text-primary hover:underline">← Back to sign in</button>
              </div>
            </div>
          ) : (
            /* ── form views ── */
            <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3" noValidate>
              {view !== 'setpw' && view !== 'changepw' && (
                <Field icon="📧">
                  <input
                    id="bo-auth-email"
                    type="email"
                    value={email}
                    onChange={e => onEmail(e.target.value)}
                    onBlur={() => setTouched(t => ({ ...t, email: true }))}
                    placeholder="you@example.com"
                    autoComplete="email"
                    aria-invalid={!!eErr || undefined}
                    aria-describedby={eErr ? 'bo-auth-email-err' : undefined}
                    className={inputCls}
                  />
                  {eErr && <p id="bo-auth-email-err" className="absolute -bottom-4 left-10 text-[10px] text-red-400">{eErr}</p>}
                </Field>
              )}

              {(view === 'signin' || view === 'signup') && (
                <div className={eErr ? 'mt-4' : ''}>
                  <PasswordInput
                    value={pw}
                    onChange={setPw}
                    placeholder={view === 'signup' ? 'Create a password' : 'Your password'}
                    autoComplete={view === 'signup' ? 'new-password' : 'current-password'}
                    invalid={!!pErr}
                  />
                  {pErr && <p className="mt-1 pl-10 text-[10px] text-red-400">{pErr}</p>}
                  {view === 'signup' && pw.length > 0 && (
                    <div className="mt-2 pl-10">
                      <div className="flex gap-1" aria-hidden="true">
                        {[1, 2, 3, 4].map(i => (
                          <span key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= score ? STRENGTH[score].cls : 'bg-border'}`} />
                        ))}
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">Strength: <b className="text-foreground">{STRENGTH[score].label}</b></span>
                        <span className="text-[10px] text-muted-foreground">{checks.filter(c => c.ok).length}/4</span>
                      </div>
                      <ul className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
                        {checks.map(c => (
                          <li key={c.label} className={`text-[10px] ${c.ok ? 'text-emerald-400' : 'text-muted-foreground'}`}>{c.ok ? '✓' : '○'} {c.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {(view === 'setpw' || view === 'changepw') && (
                <>
                  <PasswordInput value={pw} onChange={setPw} placeholder="New password (6+ characters)" autoComplete="new-password" invalid={!!pErr} />
                  {pErr && <p className="pl-10 text-[10px] text-red-400">{pErr}</p>}
                  <PasswordInput value={pw2} onChange={setPw2} placeholder="Repeat new password" autoComplete="new-password" invalid={!!mErr} />
                  {mErr && <p className="pl-10 text-[10px] text-red-400">{mErr}</p>}
                  {pw2 && pw === pw2 && <p className="pl-10 text-[10px] text-emerald-400">✓ Passwords match</p>}
                </>
              )}

              {view === 'signin' && (
                <div className="text-right">
                  <button type="button" onClick={() => { clearSecrets(); onView('forgot'); }} className="text-[11px] text-muted-foreground transition-colors hover:text-primary">
                    Forgot password?
                  </button>
                </div>
              )}

              <PrimaryButton
                busy={busy}
                label={view === 'signin' ? 'Sign in' : view === 'signup' ? 'Create account' : view === 'forgot' ? 'Email me a reset link' : view === 'setpw' ? 'Save new password' : 'Update password'}
                busyLabel={view === 'forgot' ? 'Sending…' : view === 'setpw' || view === 'changepw' ? 'Saving…' : 'Checking…'}
              />

              {/* contextual actions under errors */}
              {message?.kind === 'err' && view === 'signin' && /wrong email or password/i.test(message.text) && (
                <button type="button" onClick={() => { clearSecrets(); onView('forgot'); }} className="w-full text-center text-xs text-primary hover:underline">
                  Reset your password →
                </button>
              )}
              {message?.kind === 'err' && /hasn’t been confirmed|not been confirmed/i.test(message.text) && (
                <button type="button" onClick={() => props.onShowInboxConfirm(emailTrim)} className="w-full text-center text-xs text-primary hover:underline">
                  Open “check your inbox” →
                </button>
              )}
            </form>
          )}

          {/* footer links */}
          {view === 'forgot' && (
            <div className="mt-4 text-center text-xs text-muted-foreground">
              <button onClick={() => { clearSecrets(); onView('signin'); }} className="text-primary hover:underline">← Back to sign in</button>
            </div>
          )}
          {view === 'changepw' && (
            <button
              onClick={() => { clearSecrets(); props.onSignOut(); }}
              className="mt-3 h-9 w-full rounded-lg border border-border text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
