import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { State, ago, errMsg } from '../components/ui';
import { t, useLocale } from '../i18n';

const Head = ({ title }: { title: string }) => { const nav = useNavigate(); return <div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(-1)} aria-label={t('common.back')}><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>{title}</h1></div>; };

// ------------------------------------------------------------------------------------------------ /settings
export function SettingsHub() {
  useLocale(); const rows: [string, string, string][] = [['/settings/profile', 'Edit profile', 'Name, photo, bio and privacy'], ['/settings/security', 'Account security', 'Password, two-step verification, sessions, your data'], ['/settings/notifications', 'Notifications & saved searches', 'Push, email and alerts'],
    ['/settings/verification', 'Verification', 'Verify your identity and driver documents'], ['/settings/safety', 'Safety', 'Emergency contacts for deliveries'], ['/settings/payments', 'Payments & payouts', 'Cards, payouts, receipts'], ['/settings/invite', 'Invite friends', 'Earn twiqo credit'], ['/settings/pro', 'Business Pro', 'Lower fees and deeper insights'], ['/legal/terms', 'Terms, privacy & policies', 'How twiqo works and how we protect you']];
  return <main className="main"><Head title="Settings" /><div className="col" style={{ padding: '0 16px' }}>{rows.map(([to, a, b]) => <Link key={to} to={to} className="card pad row"><div style={{ flex: 1 }}><b>{a}</b><div className="muted sm">{b}</div></div><Icon name="back" className="flip" /></Link>)}</div></main>;
}

// ------------------------------------------------------------------------------------------------ /settings/notifications
const b64 = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
export function NotificationSettings() {
  useLocale(); const toast = useToast(); const qc = useQueryClient(); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['channels'], queryFn: () => api('/me/notification-channels') }); const ss = useQuery({ queryKey: ['saved-searches'], queryFn: () => api('/saved-searches') });
  const set = async (type: string, channel: 'email' | 'push', enabled: boolean) => { try { await api('/me/notification-channels', { method: 'PUT', body: { type, channel, enabled } }); qc.invalidateQueries({ queryKey: ['channels'] }); } catch (e) { toast(errMsg(e), 'err'); } };
  async function enablePush() {
    setBusy(true);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('This browser does not support push notifications. On iPhone, add twiqo to your Home Screen first.');
      const cfg = await api('/push/config'); if (!cfg.enabled) throw new Error('Push notifications are not switched on for this twiqo server yet.');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings and try again.');
      const reg = await navigator.serviceWorker.ready; const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(cfg.public_key) }));
      await api('/push/subscribe', { body: sub.toJSON() }); toast('Push notifications are on for this device'); qc.invalidateQueries({ queryKey: ['channels'] });
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  async function disablePush() { try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); } toast('Push is off for this device'); qc.invalidateQueries({ queryKey: ['channels'] }); } catch (e) { toast(errMsg(e), 'err'); } }
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>; if (q.isError) return <main className="main"><State kind="error" /></main>;
  const c = q.data;
  return <main className="main"><Head title="Notifications" /><div className="col" style={{ padding: '0 16px' }}>
    <div className="card pad col"><div className="row"><b>Push notifications</b><span className="sp" /><span className={`pill ${c.push_devices ? 't' : ''}`}>{c.push_devices ? `${c.push_devices} device${c.push_devices > 1 ? 's' : ''}` : 'Off'}</span></div>
      <div className="sm muted">Get offers, booking updates and alerts on this device even when twiqo is closed.</div>
      {c.push_enabled_on_server ? <div className="row"><button className="btn" disabled={busy} onClick={enablePush}>Turn on for this device</button>{c.push_devices > 0 && <button className="btn ghost" onClick={disablePush}>Turn off here</button>}</div> : <div className="sm">Push isn't set up on this server yet.</div>}</div>
    <div className="card pad col"><div className="row"><b>Email</b><span className="sp" /><label className="row sm" style={{ gap: 6 }}><input type="checkbox" checked={!c.email_notifications_off} onChange={async (e) => { await api('/me/email-notifications', { method: 'PUT', body: { off: !e.target.checked } }); qc.invalidateQueries({ queryKey: ['channels'] }); }} />Send me notification emails</label></div>
      {!c.email_verified && <div className="sm" style={{ color: 'var(--amber)' }}>Verify your email in <Link to="/settings/security" style={{ color: 'var(--blue)' }}>Account security</Link> to receive notification emails. Security emails are always sent.</div>}</div>
    <h2 className="sec" style={{ margin: '6px 0 0' }}>What to send</h2>
    <div className="card pad col" style={{ gap: 0 }}><div className="row sm muted" style={{ padding: '0 0 8px' }}><span style={{ flex: 1 }}>Notification</span><span style={{ width: 54, textAlign: 'center' }}>Email</span><span style={{ width: 54, textAlign: 'center' }}>Push</span></div>
      {c.items.map((i: any) => <div key={i.type} className="row sm" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}><span style={{ flex: 1 }}>{i.label}</span>
        <span style={{ width: 54, textAlign: 'center' }}><input type="checkbox" aria-label={`${i.label}: email`} checked={i.email} onChange={(e) => set(i.type, 'email', e.target.checked)} /></span><span style={{ width: 54, textAlign: 'center' }}><input type="checkbox" aria-label={`${i.label}: push`} checked={i.push} onChange={(e) => set(i.type, 'push', e.target.checked)} /></span></div>)}</div>
    <h2 className="sec" style={{ margin: '6px 0 0' }}>Saved searches</h2>
    {ss.data?.items.length === 0 ? <div className="muted sm">No saved searches yet. Use "Save this search" on the Market or Move pages to get alerts when something new matches.</div>
      : ss.data?.items.map((s: any) => <div key={s.id} className="card pad row"><div style={{ flex: 1 }}><b>{s.name}</b><div className="muted sm">{s.kind === 'listing' ? 'Listings' : s.kind === 'journey' ? 'Journeys' : 'Shipments'}{s.last_alert_at ? ` · last alert ${ago(s.last_alert_at)} ago` : ''}</div></div>
        <label className="row sm" style={{ gap: 6 }}><input type="checkbox" checked={s.active} onChange={async (e) => { await api(`/saved-searches/${s.id}`, { method: 'PATCH', body: { active: e.target.checked } }); qc.invalidateQueries({ queryKey: ['saved-searches'] }); }} />On</label>
        <button className="btn sm ghost" onClick={async () => { await api(`/saved-searches/${s.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['saved-searches'] }); }}>Delete</button></div>)}
  </div></main>;
}

// ------------------------------------------------------------------------------------------------ /settings/verification
const KIND: Record<string, string> = { drivers_licence: "Driver's licence", vehicle_registration: 'Vehicle registration', insurance: 'Vehicle insurance' };
const STATUS_PILL: Record<string, string> = { pending: 'a', approved: 't', rejected: 'r', expired: 'r' };
export function VerificationPage() {
  useLocale(); const toast = useToast(); const qc = useQueryClient(); const [sp] = useSearchParams(); const [busy, setBusy] = useState(false);
  const idv = useQuery({ queryKey: ['idv'], queryFn: () => api('/identity/status') }); const docs = useQuery({ queryKey: ['docs'], queryFn: () => api('/driver/documents') });
  const [f, setF] = useState({ kind: 'drivers_licence', expires_on: '' }); const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (sp.get('returned')) { idv.refetch(); const id = setTimeout(() => idv.refetch(), 4000); return () => clearTimeout(id); } }, [sp]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function start() { setBusy(true); try { const r = await api('/identity/start', { body: {} }); window.location.href = r.url; } catch (e) { toast(errMsg(e), 'err'); setBusy(false); } }
  async function upload() {
    if (!file || !f.expires_on) return; setBusy(true);
    try { const fd = new FormData(); fd.append('kind', f.kind); fd.append('expires_on', f.expires_on); fd.append('file', file); await api('/driver/documents', { form: fd }); toast('Uploaded. We\'ll review it shortly.'); setFile(null); setF({ ...f, expires_on: '' }); qc.invalidateQueries({ queryKey: ['docs'] }); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  if (idv.isLoading || docs.isLoading) return <main className="main"><State kind="loading" /></main>;
  const i = idv.data; const d = docs.data;
  return <main className="main"><Head title="Verification" /><div className="col" style={{ padding: '0 16px' }}>
    <div className="card pad col"><div className="row"><b>Identity</b><span className="sp" /><span className={`pill ${i.verified ? 't' : ''}`}>{i.verified ? 'Verified' : 'Not verified'}</span></div>
      <div className="sm muted">{i.note}</div>
      {!i.verified && <button className="btn" disabled={busy} onClick={start}>{i.latest?.status === 'requires_input' ? 'Try again' : i.latest?.status === 'processing' ? 'Check again' : 'Verify my identity'}</button>}
      {i.latest && !i.verified && <div className="sm muted">Last attempt: {String(i.latest.status).replace('_', ' ')} ({ago(i.latest.created_at)} ago)</div>}
      {i.test_mode && !i.verified && i.latest && <div className="card pad col" style={{ background: '#FFF6E0' }}><b>Test mode</b><button className="btn teal sm" onClick={async () => { await api('/identity/fake/complete', { body: {} }); idv.refetch(); }}>Pretend the check passed</button></div>}</div>
    <div className="card pad col"><div className="row"><b>Driver documents</b><span className="sp" />{d.enforced && <span className="pill a">Required to post transport</span>}</div>
      <div className="sm muted">{d.note}</div>
      {d.missing.length > 0 && <div className="sm">Still needed: <b>{d.missing.map((m: string) => (m === 'identity' ? 'Identity verification' : KIND[m] ?? m)).join(', ')}</b></div>}
      <div className="row wrap">{(['identity', 'licence', 'insurance'] as const).map((k) => <span key={k} className={`pill ${d.trust[k] ? 't' : ''}`}>{d.trust[k] ? '✓ ' : ''}{k === 'identity' ? 'ID verified' : k === 'licence' ? 'Licence' : 'Insurance'}</span>)}</div>
      {d.items.map((x: any) => <div key={x.id} className="row sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}><div style={{ flex: 1 }}><b>{KIND[x.kind]}</b><div className="muted">Expires {String(x.expires_on).slice(0, 10)}{x.review_note ? ` · ${x.review_note}` : ''}</div></div><span className={`pill ${STATUS_PILL[x.status] ?? ''}`}>{x.status}</span>
        {['pending', 'rejected'].includes(x.status) && <button className="btn sm ghost" onClick={async () => { await api(`/driver/documents/${x.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['docs'] }); }}>Remove</button>}</div>)}
      <h3 className="sm" style={{ margin: '8px 0 0' }}>Add a document</h3>
      <div className="field"><label htmlFor="dk">Type</label><select id="dk" className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="field"><label htmlFor="de">Expiry date on the document</label><input id="de" type="date" className="input" value={f.expires_on} min={new Date(Date.now() + 864e5).toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, expires_on: e.target.value })} /></div>
      <div className="field"><label htmlFor="df">Photo or PDF</label><input id="df" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
      <button className="btn" disabled={busy || !file || !f.expires_on} onClick={upload}>Upload for review</button></div>
  </div></main>;
}

// ------------------------------------------------------------------------------------------------ /settings/safety
export function SafetySettings() {
  useLocale(); const toast = useToast(); const qc = useQueryClient(); const q = useQuery({ queryKey: ['ecs'], queryFn: () => api('/me/emergency-contacts') }); const [f, setF] = useState({ name: '', email: '', phone: '' });
  const add = async () => { try { await api('/me/emergency-contacts', { body: { name: f.name, ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}) } }); setF({ name: '', email: '', phone: '' }); qc.invalidateQueries({ queryKey: ['ecs'] }); } catch (e) { toast(errMsg(e), 'err'); } };
  return <main className="main"><Head title="Safety" /><div className="col" style={{ padding: '0 16px' }}>
    <div className="card pad col"><b>Emergency contacts</b><div className="sm muted">If you press the safety alert during a delivery, twiqo emails these people your message and last known location. We can't text or call them, so an email is needed. Up to 3.</div>
      {q.data?.items.map((c: any) => <div key={c.id} className="row sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}><div style={{ flex: 1 }}><b>{c.name}</b><div className="muted">{c.email ?? ''} {c.phone ?? ''}</div></div><button className="btn sm ghost" onClick={async () => { await api(`/me/emergency-contacts/${c.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['ecs'] }); }}>Remove</button></div>)}
      {(q.data?.items.length ?? 0) < 3 && <><div className="field"><label htmlFor="en">Name</label><input id="en" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div><div className="field"><label htmlFor="ee">Email</label><input id="ee" type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div><div className="field"><label htmlFor="ep">Phone (optional)</label><input id="ep" className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        <button className="btn" disabled={!f.name.trim() || (!f.email && !f.phone)} onClick={add}>Add contact</button></>}</div>
    <div className="card pad sm"><b>In an emergency, call 911.</b> twiqo is not an emergency service. The in-app alert tells the other person, twiqo staff and your contacts, but it can't send help.</div>
  </div></main>;
}
