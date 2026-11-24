import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { Ticks } from '../components/Icon';

export function AuthPage() {
  const { me, login, register } = useAuth(); const nav = useNavigate();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [f, setF] = useState({ identifier: '', password: '', email: '', username: '', display_name: '', city: 'Calgary' });
  const [err, setErr] = useState<string | null>(null); const [fieldErr, setFieldErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFieldErr({});
    try {
      if (mode === 'in') await login(f.identifier, f.password);
      else await register({ email: f.email, username: f.username, password: f.password, display_name: f.display_name, city: f.city || undefined });
      nav('/');
    } catch (x) {
      if (x instanceof ApiError) { setErr(x.message); setFieldErr(Object.fromEntries((x.details ?? []).map((d) => [d.path, d.message]))); } else setErr('Something went wrong');
    } finally { setBusy(false); }
  }
  return (
    <main className="auth">
      <div className="hero-auth"><Ticks w={72} /><h1>twiqo</h1><div className="muted">Connect. Discover. Move.</div></div>
      <form className="card pad col" onSubmit={submit} noValidate>
        <h2 className="sec" style={{ margin: 0 }}>{mode === 'in' ? 'Welcome back' : 'Join twiqo'}</h2>
        {mode === 'up' && <>
          <div className="field"><label htmlFor="dn">Your name</label><input id="dn" className="input" value={f.display_name} onChange={set('display_name')} autoComplete="name" required />{fieldErr.display_name && <span className="err">{fieldErr.display_name}</span>}</div>
          <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" className="input" value={f.email} onChange={set('email')} autoComplete="email" required />{fieldErr.email && <span className="err">{fieldErr.email}</span>}</div>
          <div className="field"><label htmlFor="un">Username</label><input id="un" className="input" value={f.username} onChange={set('username')} autoComplete="username" placeholder="letters, numbers, . or _" required />{fieldErr.username && <span className="err">{fieldErr.username}</span>}</div>
          <div className="field"><label htmlFor="ct">City</label><input id="ct" className="input" value={f.city} onChange={set('city')} placeholder="e.g. Calgary" /><span className="muted sm">Only your city is shown — never your address.</span></div>
        </>}
        {mode === 'in' && <div className="field"><label htmlFor="id">Email or username</label><input id="id" className="input" value={f.identifier} onChange={set('identifier')} autoComplete="username" required /></div>}
        <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" className="input" value={f.password} onChange={set('password')} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={mode === 'up' ? 8 : 1} />{mode === 'up' && <span className="muted sm">At least 8 characters.</span>}{fieldErr.password && <span className="err">{fieldErr.password}</span>}</div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn block" disabled={busy}>{busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="btn soft block" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); setFieldErr({}); }}>{mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}</button>
      </form>
    </main>
  );
}
