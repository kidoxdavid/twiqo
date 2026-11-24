import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { State, ago, errMsg, cash } from '../components/ui';
import { LanguageSwitch, t, useLocale } from '../i18n';

const Head = ({ title }: { title: string }) => { const nav = useNavigate(); return <div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(-1)} aria-label={t('common.back')}><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>{title}</h1></div>; };

// ------------------------------------------------------------------------------------------------ /settings/invite
export function InvitePage() {
  useLocale(); const toast = useToast(); const q = useQuery({ queryKey: ['referrals'], queryFn: () => api('/referrals/me') });
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="error" /></main>;
  const r = q.data;
  const copy = async () => { try { await navigator.clipboard.writeText(r.link); toast(t('common.copied')); } catch { toast(r.link); } };
  const share = async () => { if (navigator.share) { try { await navigator.share({ title: 'twiqo', url: r.link }); } catch { /* cancelled */ } } else copy(); };
  return <main className="main"><Head title={t('invite.title')} />
    <div className="col" style={{ padding: '0 16px' }}>
      <div className="card pad col"><b>{t('invite.your_link')}</b><div className="card pad sm" style={{ wordBreak: 'break-all', background: 'var(--bg, #F4F7FE)' }}>{r.link}</div>
        <div className="row"><button className="btn" style={{ flex: 1 }} onClick={copy}>{t('common.copy')}</button><button className="btn soft" onClick={share}>Share</button></div>
        {!r.enabled && <div className="muted sm">The referral programme is paused right now. Your link still works but no credit is earned.</div>}
        <div className="muted sm">{r.rules}</div></div>
      <div className="kpis"><div className="kpi"><span>{t('invite.credit')}</span><b>{cash(r.credit_cents)}</b></div><div className="kpi"><span>{t('invite.signed_up')}</span><b>{r.stats.signed_up}</b></div><div className="kpi"><span>{t('invite.qualified')}</span><b>{r.stats.qualified}</b></div><div className="kpi"><span>{t('invite.earned')}</span><b>{cash(r.stats.earned)}</b></div></div>
      <div className="muted sm">Credit is worth {cash(r.reward_cents)} per qualifying invitation and can pay for a boost when it covers the full price. It has no cash value and can't be transferred.</div>
      <h2 className="sec" style={{ margin: '6px 0 0' }}>{t('invite.history')}</h2>
      {r.recent.length === 0 ? <div className="muted">{t('invite.none')}</div> : r.recent.map((x: any, i: number) => <div key={i} className="card pad row"><div style={{ flex: 1 }}><b>{x.display_name}</b><div className="muted sm">{ago(x.created_at)}</div></div><span className={`pill ${x.status === 'qualified' ? 't' : ''}`}>{x.status === 'qualified' ? (x.reward_cents ? `${t('invite.done')} ${cash(x.reward_cents)}` : t('invite.done')) : x.status === 'rejected' ? 'Not eligible' : t('invite.pending')}</span></div>)}
    </div></main>;
}

// ------------------------------------------------------------------------------------------------ /settings/pro
export function ProPage() {
  useLocale(); const toast = useToast(); const qc = useQueryClient(); const [sp] = useSearchParams(); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['sub'], queryFn: () => api('/subscriptions/me') });
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="error" /></main>;
  const s = q.data; const fakeReturn = sp.get('fake_subscription');
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await qc.invalidateQueries({ queryKey: ['sub'] }); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  const subscribe = () => act(async () => { const r = await api('/subscriptions/checkout', { method: 'POST', body: {} }); window.location.href = r.url; });
  const portal = () => act(async () => { const r = await api('/subscriptions/portal', { method: 'POST', body: {} }); window.location.href = r.url; });
  return <main className="main"><Head title={t('pro.title')} />
    <div className="col" style={{ padding: '0 16px' }}>
      <div className="card pad col"><div className="row"><b style={{ fontSize: 20 }}>{t('pro.title')}</b><span className="sp" />{s.active && <span className="pill t">{t('pro.active')}</span>}</div>
        <div><b style={{ fontSize: 28 }}>{cash(s.price_cents)}</b> <span className="muted">{t('pro.price')}</span></div>
        <ul style={{ paddingLeft: 18, lineHeight: 1.6, margin: 0 }}>{s.benefits.map((b: string) => <li key={b}>{b}</li>)}</ul>
        {s.active && s.current_period_end && <div className="sm muted">{s.cancel_at_period_end ? t('pro.ends') : t('pro.renews')} {new Date(s.current_period_end).toLocaleDateString(undefined, { dateStyle: 'medium' })}</div>}
        {s.status === 'past_due' && <div className="err">Your last payment failed. Update your card in the billing portal to keep Business Pro.</div>}
        {!s.active && s.enabled && <button className="btn" disabled={busy} onClick={subscribe}>{t('pro.subscribe')}</button>}
        {s.active && !s.test_mode && <button className="btn ghost" disabled={busy} onClick={portal}>{t('pro.manage')}</button>}
        {s.test_mode && <div className="card pad col" style={{ background: '#FFF6E0' }}><b>Test mode</b><div className="sm">No card is charged.{fakeReturn && !s.active ? ' You were returned from the pretend checkout page.' : ''}</div>
          {!s.active ? <button className="btn teal" disabled={busy} onClick={() => act(() => api('/subscriptions/fake/activate', { method: 'POST', body: {} }))}>Complete test checkout</button>
            : !s.cancel_at_period_end ? <button className="btn ghost" disabled={busy} onClick={() => act(() => api('/subscriptions/fake/cancel', { body: {} }))}>{t('pro.cancel_end')}</button>
            : <button className="btn ghost" disabled={busy} onClick={() => act(() => api('/subscriptions/fake/cancel', { body: { immediately: true } }))}>End now</button>}</div>}
        <div className="muted sm">{s.note}</div></div>
      <Link className="btn soft" to="/insights">{t('me.insights')}</Link>
    </div></main>;
}

// ------------------------------------------------------------------------------------------------ /insights
export function InsightsPage() {
  useLocale(); const [days, setDays] = useState(30); const q = useQuery({ queryKey: ['insights', days], queryFn: () => api('/insights', { query: { days } }) });
  const d = q.data; const max = Math.max(1, ...((d?.daily ?? []) as any[]).map((x) => x.views));
  return <main className="main"><Head title={t('insights.title')} />
    <div className="col" style={{ padding: '0 16px' }}>
      <div className="row">{[7, 30, 90].map((n) => <button key={n} className={`pill ${days === n ? 'b' : ''}`} onClick={() => setDays(n)}>{t('insights.last', { n })}</button>)}</div>
      {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="error" /> : <>
        <div className="kpis"><div className="kpi"><span>{t('insights.views')}</span><b>{d.totals.views}</b></div><div className="kpi"><span>{t('insights.saves')}</span><b>{d.totals.saves}</b></div><div className="kpi"><span>{t('insights.likes')}</span><b>{d.totals.likes}</b></div><div className="kpi"><span>{t('insights.offers')}</span><b>{d.totals.offers}</b></div></div>
        {d.pro ? <div className="card pad col"><div className="row"><b>{t('insights.views')}</b><span className="sp" />{d.conversion.views_to_offers !== null && <span className="pill t">{d.conversion.views_to_offers}% → {t('insights.offers').toLowerCase()}</span>}</div>
            <div className="row" style={{ alignItems: 'flex-end', gap: 3, height: 80 }} role="img" aria-label={t('insights.views')}>{d.daily.map((x: any) => <div key={x.day} title={`${String(x.day).slice(0, 10)}: ${x.views}`} style={{ flex: 1, minWidth: 2, background: 'var(--blue)', borderRadius: 3, height: `${Math.max(4, (x.views / max) * 100)}%` }} />)}</div></div>
          : <div className="card pad row"><span className="sm" style={{ flex: 1 }}>{t('insights.upgrade')}</span><Link className="btn sm" to="/settings/pro">{t('pro.title')}</Link></div>}
        {d.items.length === 0 ? <State kind="empty" title={t('insights.empty')} /> : d.items.map((i: any) => <Link key={i.id} to={i.type === 'listing' ? `/l/${i.id}` : `/s/${i.id}`} className="card pad col" style={{ gap: 4 }}><b>{i.title}</b>
          <div className="row wrap sm muted"><span>{i.views} {t('insights.views').toLowerCase()}</span><span>{i.visitors} {t('insights.visitors').toLowerCase()}</span><span>{i.saves} {t('insights.saves').toLowerCase()}</span><span>{i.likes} {t('insights.likes').toLowerCase()}</span><span>{i.offers} {t('insights.offers').toLowerCase()}</span></div></Link>)}
        <div className="muted sm">{d.note}</div></>}
    </div></main>;
}
export { LanguageSwitch };
