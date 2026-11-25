import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ApiError, api, getAccessToken } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { Modal, State, ago, errMsg } from '../components/ui';
import { t, useLocale } from '../i18n';

const Head = ({ title }: { title: string }) => { const nav = useNavigate(); return <div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(-1)} aria-label={t('common.back')}><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>{title}</h1></div>; };

// ------------------------------------------------------------------------------------------------ /verify-email?token=
export function VerifyEmailPage() {
  const [sp] = useSearchParams(); const { reload } = useAuth(); const [state, setState] = useState<'working' | 'ok' | 'bad'>('working'); const [msg, setMsg] = useState('');
  useEffect(() => { const tok = sp.get('token'); if (!tok) { setState('bad'); setMsg('This link is missing its code.'); return; }
    api('/auth/verify-email', { body: { token: tok } }).then(() => { setState('ok'); reload().catch(() => undefined); }).catch((e) => { setState('bad'); setMsg(errMsg(e)); }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return <main className="main"><div className="col" style={{ padding: '40px 16px', textAlign: 'center', alignItems: 'center' }}>
    {state === 'working' && <State kind="loading" />}
    {state === 'ok' && <><h1 style={{ fontSize: 22, fontWeight: 800 }}>Email confirmed</h1><div className="muted">Thanks, your email address is verified.</div><Link className="btn" to="/">Continue to twiqo</Link></>}
    {state === 'bad' && <><h1 style={{ fontSize: 22, fontWeight: 800 }}>That link didn't work</h1><div className="muted">{msg}</div><Link className="btn" to="/settings/security">Send a new link</Link></>}</div></main>;
}

// ------------------------------------------------------------------------------------------------ /reset-password?token=
export function ResetPasswordPage() {
  const [sp] = useSearchParams(); const nav = useNavigate(); const toast = useToast(); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setErr(''); try { await api('/auth/password/reset', { body: { token: sp.get('token') ?? '', password: pw } }); toast('Password updated. Sign in with your new password.'); nav('/login'); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); } }
  return <main className="auth"><form className="card pad col" onSubmit={submit}><h1 className="sec" style={{ margin: 0 }}>Choose a new password</h1>
    <div className="field"><label htmlFor="np">New password</label><input id="np" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} autoComplete="new-password" required /><span className="muted sm">At least 8 characters. You'll be signed out everywhere else.</span></div>
    {err && <div className="err" role="alert">{err}</div>}<button className="btn block" disabled={busy || pw.length < 8}>Update password</button></form></main>;
}

// ------------------------------------------------------------------------------------------------ /settings/security
function Qr({ text }: { text: string }) { const [src, setSrc] = useState(''); useEffect(() => { QRCode.toDataURL(text, { margin: 1, width: 192 }).then(setSrc).catch(() => undefined); }, [text]); return src ? <img src={src} width={192} height={192} alt="QR code for your authenticator app" style={{ borderRadius: 12, border: '1px solid var(--line)' }} /> : null; }

export function SecurityPage() {
  useLocale(); const toast = useToast(); const qc = useQueryClient(); const nav = useNavigate(); const { logout } = useAuth();
  const sec = useQuery({ queryKey: ['security'], queryFn: () => api('/me/security') }); const sess = useQuery({ queryKey: ['sessions'], queryFn: () => api('/me/sessions') });
  const [pw, setPw] = useState({ current: '', next: '' }); const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null); const [code, setCode] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState(false); const [offF, setOffF] = useState({ password: '', code: '' }); const [del, setDel] = useState(false); const [delPw, setDelPw] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) toast(ok); qc.invalidateQueries({ queryKey: ['security'] }); qc.invalidateQueries({ queryKey: ['sessions'] }); return true; } catch (e) { toast(errMsg(e), 'err'); return false; } finally { setBusy(false); } };
  async function download() { const r = await fetch('/api/me/export', { headers: { Authorization: `Bearer ${getAccessToken()}` } }); if (!r.ok) return toast('Could not prepare your data', 'err'); const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'twiqo-my-data.json'; a.click(); }
  if (sec.isLoading) return <main className="main"><State kind="loading" /></main>; if (sec.isError) return <main className="main"><State h1 kind="error" /></main>;
  const s = sec.data;
  return <main className="main"><Head title="Account security" />
    <div className="col" style={{ padding: '0 16px' }}>
      <div className="card pad col"><div className="row"><b>Email</b><span className="sp" /><span className={`pill ${s.email_verified ? 't' : 'a'}`}>{s.email_verified ? 'Verified' : 'Not verified'}</span></div><div className="sm muted">{s.email}</div>
        {!s.email_verified && <><div className="sm">Verify your email so we can reach you about offers, bookings and payments, and so you can use instant book.</div><button className="btn sm" disabled={busy} onClick={() => run(async () => { await api('/auth/verify-email/request', { body: {} }); }, 'Check your inbox for the link')}>Send verification email</button></>}</div>

      <div className="card pad col"><div className="row"><b>Two-step verification</b><span className="sp" /><span className={`pill ${s.two_factor ? 't' : ''}`}>{s.two_factor ? 'On' : 'Off'}</span></div>
        <div className="sm muted">Adds a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy) when you sign in.</div>
        {!s.two_factor && !setup && <button className="btn" disabled={busy} onClick={() => run(async () => setSetup(await api('/me/2fa/setup', { body: {} })))}>Set up two-step verification</button>}
        {setup && <div className="col" style={{ alignItems: 'center' }}><Qr text={setup.otpauth_url} /><div className="sm muted" style={{ wordBreak: 'break-all', textAlign: 'center' }}>Can't scan? Enter this key: <b>{setup.secret}</b></div>
          <div className="field" style={{ width: '100%' }}><label htmlFor="tc">6-digit code</label><input id="tc" className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" /></div>
          <button className="btn block" disabled={busy || code.length !== 6} onClick={async () => { if (await run(async () => { const r = await api('/me/2fa/enable', { body: { code } }); setCodes(r.recovery_codes); setSetup(null); setCode(''); })) { /* codes dialog opens */ } }}>Turn on</button></div>}
        {s.two_factor && <><div className="sm">{s.recovery_codes_left} recovery codes left.</div><button className="btn ghost" onClick={() => setOff(true)}>Turn off…</button></>}</div>

      <div className="card pad col"><b>Change password</b>
        <div className="field"><label htmlFor="cp">Current password</label><input id="cp" type="password" className="input" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></div>
        <div className="field"><label htmlFor="n1">New password</label><input id="n1" type="password" className="input" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></div>
        <button className="btn" disabled={busy || pw.next.length < 8 || !pw.current} onClick={async () => { if (await run(() => api('/me/password', { body: { current_password: pw.current, new_password: pw.next } }), 'Password changed. Other devices were signed out.')) setPw({ current: '', next: '' }); }}>Update password</button></div>

      <div className="card pad col"><div className="row"><b>Where you're signed in</b><span className="sp" />{sess.data?.items.length > 1 && <button className="btn sm ghost" onClick={() => run(() => api('/me/sessions/revoke-others', { body: {} }), 'Signed out of other devices')}>Sign out others</button>}</div>
        {sess.data?.items.map((x: any) => <div key={x.id} className="row sm"><div style={{ flex: 1 }}><b>{x.device}</b>{x.current && <span className="pill t" style={{ marginLeft: 6 }}>This device</span>}<div className="muted">Active {ago(x.last_used_at)} ago</div></div>{!x.current && <button className="btn sm ghost" onClick={() => run(() => api(`/me/sessions/${x.id}`, { method: 'DELETE' }), 'Signed out')}>Sign out</button>}</div>)}</div>

      <div className="card pad col"><b>Your data</b><div className="sm muted">Download a copy of what twiqo holds about you, or delete your account. Records we must keep for payments and disputes are kept without your name.</div>
        <button className="btn soft" onClick={download}>Download my data</button><button className="btn ghost" style={{ color: 'var(--red-text)', borderColor: 'var(--red-text)' }} onClick={() => setDel(true)}>Delete my account…</button></div>
      <div className="muted sm">Accepted Terms &amp; Privacy Policy {s.terms.version ? `(${s.terms.version})` : ''} {s.terms.accepted_at ? ago(s.terms.accepted_at) + ' ago' : ''}. <Link to="/legal/terms" style={{ color: 'var(--blue)' }}>Read them</Link></div>
    </div>
    {codes && <Modal onClose={() => setCodes(null)} title="Save your recovery codes"><div className="col"><div className="sm">Each code works once if you lose your phone. They won't be shown again.</div>
      <div className="card pad" style={{ fontFamily: 'ui-monospace, monospace', columns: 2, lineHeight: 1.9 }}>{codes.map((c) => <div key={c}>{c}</div>)}</div>
      <button className="btn" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')).catch(() => undefined); toast('Copied'); }}>Copy codes</button><button className="btn ghost" onClick={() => setCodes(null)}>I've saved them</button></div></Modal>}
    {off && <Modal onClose={() => setOff(false)} title="Turn off two-step verification"><div className="col"><div className="field"><label htmlFor="op">Password</label><input id="op" type="password" className="input" value={offF.password} onChange={(e) => setOffF({ ...offF, password: e.target.value })} /></div>
      <div className="field"><label htmlFor="oc">Authenticator or recovery code</label><input id="oc" className="input" value={offF.code} onChange={(e) => setOffF({ ...offF, code: e.target.value })} autoComplete="one-time-code" /></div>
      <button className="btn danger" disabled={busy || !offF.password || offF.code.length < 6} onClick={async () => { if (await run(() => api('/me/2fa/disable', { body: offF }), 'Two-step verification is off')) setOff(false); }}>Turn off</button></div></Modal>}
    {del && <Modal onClose={() => setDel(false)} title="Delete your account?"><div className="col"><div className="sm">This removes your profile, listings and posts, signs you out everywhere and can't be undone. You can't delete while you have open orders, bookings or problem reports.</div>
      <div className="field"><label htmlFor="dp">Your password</label><input id="dp" type="password" className="input" value={delPw} onChange={(e) => setDelPw(e.target.value)} /></div>
      <button className="btn danger" disabled={busy || !delPw} onClick={async () => { setBusy(true); try { await api('/me', { method: 'DELETE', body: { password: delPw } }); await logout().catch(() => undefined); toast('Your account was deleted'); nav('/login'); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }}>Delete my account</button></div></Modal>}
  </main>;
}
void ApiError;
