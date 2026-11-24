import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { Ticks } from '../components/Icon';
import { LanguageSwitch, t, useLocale } from '../i18n';

export function AuthPage() {
  const { me, login, register } = useAuth(); const nav = useNavigate(); useLocale(); const [sp] = useSearchParams();
  const [mode, setMode] = useState<'in' | 'up' | 'forgot'>('in'); const [accept, setAccept] = useState(false); const [otp, setOtp] = useState(''); const [needOtp, setNeedOtp] = useState(false); const [sent, setSent] = useState(false);
  const [f, setF] = useState({ identifier: '', password: '', email: '', username: '', display_name: '', city: 'Calgary', ref: sp.get('ref') ?? '' });
  const [mode0] = useState(() => !!sp.get('ref'));
  useEffect(() => { if (mode0) setMode('up'); }, [mode0]);
  const [err, setErr] = useState<string | null>(null); const [fieldErr, setFieldErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFieldErr({});
    try {
      if (mode === 'forgot') { await api('/auth/password/forgot', { body: { email: f.email } }); setSent(true); return; }
      if (mode === 'in') await login(f.identifier, f.password, needOtp ? otp : undefined);
      else await register({ accept_terms: accept, email: f.email, username: f.username, password: f.password, display_name: f.display_name, city: f.city || undefined, ref: f.ref || undefined });
      nav('/');
    } catch (x) {
      if (x instanceof ApiError && x.code === 'otp_required') { setNeedOtp(true); setErr(null); }
      else if (x instanceof ApiError) { setErr(x.message); setFieldErr(Object.fromEntries((x.details ?? []).map((d) => [d.path, d.message]))); } else setErr('Something went wrong');
    } finally { setBusy(false); }
  }
  return (
    <main className="auth">
      <div className="hero-auth"><Ticks w={72} /><h1>twiqo</h1><div className="muted">{t('auth.tagline')}</div></div>
      <form className="card pad col" onSubmit={submit} noValidate>
        <h2 className="sec" style={{ margin: 0 }}>{mode === 'in' ? t('auth.welcome') : mode === 'forgot' ? 'Reset your password' : t('auth.join')}</h2>
        {mode === 'forgot' && (sent ? <div role="status">If that email has a twiqo account, we've sent a reset link. It works for 1 hour.</div> : <div className="field"><label htmlFor="fe">{t('auth.email')}</label><input id="fe" type="email" className="input" value={f.email} onChange={set('email')} autoComplete="email" required /></div>)}
        {mode === 'up' && <>
          <div className="field"><label htmlFor="dn">{t('auth.name')}</label><input id="dn" className="input" value={f.display_name} onChange={set('display_name')} autoComplete="name" required />{fieldErr.display_name && <span className="err">{fieldErr.display_name}</span>}</div>
          <div className="field"><label htmlFor="em">{t('auth.email')}</label><input id="em" type="email" className="input" value={f.email} onChange={set('email')} autoComplete="email" required />{fieldErr.email && <span className="err">{fieldErr.email}</span>}</div>
          <div className="field"><label htmlFor="un">{t('auth.username')}</label><input id="un" className="input" value={f.username} onChange={set('username')} autoComplete="username" placeholder={t('auth.username_hint')} required />{fieldErr.username && <span className="err">{fieldErr.username}</span>}</div>
          <div className="field"><label htmlFor="ct">{t('auth.city')}</label><input id="ct" className="input" value={f.city} onChange={set('city')} placeholder="e.g. Calgary" /><span className="muted sm">{t('auth.city_hint')}</span></div>
        <div className="field"><label htmlFor="rf">{t('auth.invite')}</label><input id="rf" className="input" value={f.ref} onChange={set('ref')} autoComplete="off" /><span className="muted sm">{t('auth.invite_hint')}</span></div>
        </>}
        {mode === 'in' && <div className="field"><label htmlFor="id">{t('auth.identifier')}</label><input id="id" className="input" value={f.identifier} onChange={set('identifier')} autoComplete="username" required /></div>}
        {mode !== 'forgot' && <div className="field"><label htmlFor="pw">{t('auth.password')}</label><input id="pw" type="password" className="input" value={f.password} onChange={set('password')} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={mode === 'up' ? 8 : 1} />{mode === 'up' && <span className="muted sm">At least 8 characters.</span>}{fieldErr.password && <span className="err">{fieldErr.password}</span>}</div>}
        {mode === 'in' && needOtp && <div className="field"><label htmlFor="otp">Authentication code</label><input id="otp" className="input" value={otp} onChange={(e) => setOtp(e.target.value)} autoComplete="one-time-code" inputMode="numeric" autoFocus required /><span className="muted sm">Enter the 6-digit code from your authenticator app, or a recovery code.</span></div>}
        {mode === 'up' && <label className="row sm" style={{ alignItems: 'flex-start', gap: 8 }}><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} style={{ marginTop: 3 }} /><span>I agree to the <a href="/legal/terms" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>Terms</a> and <a href="/legal/privacy" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>Privacy Policy</a>, and I'm at least 18.</span></label>}
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn block" disabled={busy || (mode === 'up' && !accept) || (mode === 'forgot' && sent)}>{busy ? t('auth.busy') : mode === 'in' ? t('auth.signin') : mode === 'forgot' ? 'Send reset link' : t('auth.create')}</button>
        {mode === 'in' && <button type="button" className="sm" style={{ color: 'var(--blue)', alignSelf: 'center' }} onClick={() => { setMode('forgot'); setErr(null); setSent(false); }}>Forgot your password?</button>}
        <button type="button" className="btn soft block" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); setFieldErr({}); setNeedOtp(false); }}>{mode === 'in' ? t('auth.new') : t('auth.have')}</button>
      </form>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}><LanguageSwitch /></div>
    </main>
  );
}
