import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { Ticks } from '../components/Icon';
import { LanguageSwitch, t, useLocale } from '../i18n';

export function AuthPage() {
  const { me, login, register } = useAuth(); const nav = useNavigate(); useLocale(); const [sp] = useSearchParams();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [f, setF] = useState({ identifier: '', password: '', email: '', username: '', display_name: '', city: 'Calgary', ref: sp.get('ref') ?? '' });
  const [mode0] = useState(() => !!sp.get('ref'));
  useEffect(() => { if (mode0) setMode('up'); }, [mode0]);
  const [err, setErr] = useState<string | null>(null); const [fieldErr, setFieldErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFieldErr({});
    try {
      if (mode === 'in') await login(f.identifier, f.password);
      else await register({ email: f.email, username: f.username, password: f.password, display_name: f.display_name, city: f.city || undefined, ref: f.ref || undefined });
      nav('/');
    } catch (x) {
      if (x instanceof ApiError) { setErr(x.message); setFieldErr(Object.fromEntries((x.details ?? []).map((d) => [d.path, d.message]))); } else setErr('Something went wrong');
    } finally { setBusy(false); }
  }
  return (
    <main className="auth">
      <div className="hero-auth"><Ticks w={72} /><h1>twiqo</h1><div className="muted">{t('auth.tagline')}</div></div>
      <form className="card pad col" onSubmit={submit} noValidate>
        <h2 className="sec" style={{ margin: 0 }}>{mode === 'in' ? t('auth.welcome') : t('auth.join')}</h2>
        {mode === 'up' && <>
          <div className="field"><label htmlFor="dn">{t('auth.name')}</label><input id="dn" className="input" value={f.display_name} onChange={set('display_name')} autoComplete="name" required />{fieldErr.display_name && <span className="err">{fieldErr.display_name}</span>}</div>
          <div className="field"><label htmlFor="em">{t('auth.email')}</label><input id="em" type="email" className="input" value={f.email} onChange={set('email')} autoComplete="email" required />{fieldErr.email && <span className="err">{fieldErr.email}</span>}</div>
          <div className="field"><label htmlFor="un">{t('auth.username')}</label><input id="un" className="input" value={f.username} onChange={set('username')} autoComplete="username" placeholder={t('auth.username_hint')} required />{fieldErr.username && <span className="err">{fieldErr.username}</span>}</div>
          <div className="field"><label htmlFor="ct">{t('auth.city')}</label><input id="ct" className="input" value={f.city} onChange={set('city')} placeholder="e.g. Calgary" /><span className="muted sm">{t('auth.city_hint')}</span></div>
        <div className="field"><label htmlFor="rf">{t('auth.invite')}</label><input id="rf" className="input" value={f.ref} onChange={set('ref')} autoComplete="off" /><span className="muted sm">{t('auth.invite_hint')}</span></div>
        </>}
        {mode === 'in' && <div className="field"><label htmlFor="id">{t('auth.identifier')}</label><input id="id" className="input" value={f.identifier} onChange={set('identifier')} autoComplete="username" required /></div>}
        <div className="field"><label htmlFor="pw">{t('auth.password')}</label><input id="pw" type="password" className="input" value={f.password} onChange={set('password')} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={mode === 'up' ? 8 : 1} />{mode === 'up' && <span className="muted sm">At least 8 characters.</span>}{fieldErr.password && <span className="err">{fieldErr.password}</span>}</div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn block" disabled={busy}>{busy ? t('auth.busy') : mode === 'in' ? t('auth.signin') : t('auth.create')}</button>
        <button type="button" className="btn soft block" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); setFieldErr({}); }}>{mode === 'in' ? t('auth.new') : t('auth.have')}</button>
      </form>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}><LanguageSwitch /></div>
    </main>
  );
}
