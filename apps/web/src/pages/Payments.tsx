import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { DISPUTE_REASONS } from '../components/payments';
import { State, ago, errMsg, money } from '../components/ui';

const STATUS_PILL: Record<string, string> = { succeeded: 't', partially_refunded: 'a', refunded: 'b', failed: 'r', requires_payment: '', processing: 'b', canceled: '' };
const STATUS_TEXT: Record<string, string> = { succeeded: 'Paid', partially_refunded: 'Partly refunded', refunded: 'Refunded', failed: 'Failed', requires_payment: 'Awaiting payment', processing: 'Processing', canceled: 'Cancelled' };

// ------------------------------------------------------------------------------------------------ /settings/payments
export function PaymentsSettings() {
  const toast = useToast(); const qc = useQueryClient(); const nav = useNavigate(); const [sp] = useSearchParams(); const [busy, setBusy] = useState(false); const [role, setRole] = useState<'all' | 'payer' | 'payee'>('all');
  const acct = useQuery({ queryKey: ['pay-account'], queryFn: () => api('/payments/account') });
  const earn = useQuery({ queryKey: ['pay-earnings'], queryFn: () => api('/payments/earnings') });
  const list = useQuery({ queryKey: ['payments', role], queryFn: () => api('/payments', { query: { role } }) });
  const disputes = useQuery({ queryKey: ['my-disputes'], queryFn: () => api('/disputes') });
  useEffect(() => { if (sp.get('onboarded') || sp.get('refresh')) acct.refetch(); }, [sp]);   // eslint-disable-line react-hooks/exhaustive-deps
  const a = acct.data;
  async function onboard() {
    setBusy(true);
    try { const r = await api('/payments/account/onboarding', { method: 'POST', body: {} }); window.location.href = r.url; } catch (e) { toast(errMsg(e), 'err'); setBusy(false); }
  }
  async function fakeComplete() { try { await api('/payments/fake/onboarding/complete', { body: {} }); qc.invalidateQueries(); toast('Test account is ready'); } catch (e) { toast(errMsg(e), 'err'); } }
  async function dashboard() { try { const r = await api('/payments/account/dashboard', { body: {} }); window.open(r.url, '_blank', 'noopener'); } catch (e) { toast(errMsg(e), 'err'); } }
  const fakeReturn = sp.get('fake_onboarding');
  return (
    <main className="main"><div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>Payments &amp; payouts</h1></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <div className="card pad col">
          <div className="row"><h2 className="sec" style={{ margin: 0 }}>Get paid by card</h2><span className="sp" />{a && <span className={`pill ${a.status === 'active' ? 't' : a.status === 'incomplete' ? 'a' : ''}`}>{a.status === 'active' ? 'Ready' : a.status === 'incomplete' ? 'Setup unfinished' : 'Not set up'}</span>}</div>
          {acct.isLoading ? <State kind="loading" /> : <>
            <div className="sm">Sellers and drivers can accept card payments from buyers and shippers. Payouts go to your bank through Stripe, usually after a short delay so refunds and problems can be handled first.</div>
            {a?.status !== 'active' && <button className="btn" disabled={busy} onClick={onboard}>{a?.status === 'incomplete' ? 'Continue setup with Stripe' : 'Set up payouts with Stripe'}</button>}
            {a?.test_mode && a.status !== 'not_started' && a.status !== 'active' && <button className="btn teal" onClick={fakeComplete}>Test mode: mark my account ready</button>}
            {a?.test_mode && fakeReturn && <div className="muted sm">Test mode: you were returned from the pretend onboarding page.</div>}
            {a?.requirements_due?.length > 0 && a.status !== 'active' && <div className="muted sm">Stripe still needs: {a.requirements_due.map((r: string) => r.replace(/[._]/g, ' ')).join(', ')}.</div>}
            {a?.status === 'active' && !a.test_mode && <button className="btn ghost" onClick={dashboard}>Open my Stripe dashboard</button>}
            {a?.test_mode && <div className="muted sm">Test mode is on, so no real money moves.</div>}
            <div className="muted sm">Card payments are optional: you can always agree to be paid in cash or by e-transfer instead. Taxes (GST/HST/PST) on sales are your responsibility and are not calculated here yet.</div></>}
        </div>

        <h2 className="sec" style={{ margin: '6px 0 0' }}>Earnings</h2>
        {earn.isLoading ? <State kind="loading" /> : earn.data && <div className="kpis"><div className="kpi"><span>Received</span><b>{money(earn.data.gross_cents)}</b></div><div className="kpi"><span>twiqo fees</span><b>{money(earn.data.fee_cents)}</b></div><div className="kpi"><span>Refunded</span><b>{money(earn.data.refunded_cents)}</b></div><div className="kpi"><span>Your net</span><b>{money(earn.data.net_cents)}</b></div></div>}
        {earn.data?.payouts?.length > 0 && <div className="card pad col sm">{earn.data.payouts.map((p: any) => <div key={p.id} className="row"><span>{p.arrival_date ? new Date(p.arrival_date).toLocaleDateString('en-CA') : ago(p.created_at)}</span><span className="sp" /><span className="pill">{p.status}</span><b>{money(p.amount_cents)}</b></div>)}</div>}
        {earn.data && <div className="muted sm">{earn.data.note}</div>}

        <div className="row"><h2 className="sec" style={{ margin: 0 }}>History</h2><span className="sp" />{(['all', 'payer', 'payee'] as const).map((r) => <button key={r} className={`pill ${role === r ? 'b' : ''}`} onClick={() => setRole(r)}>{{ all: 'All', payer: 'Paid', payee: 'Received' }[r]}</button>)}</div>
        {list.isLoading ? <State kind="loading" /> : list.data.items.length === 0 ? <div className="muted">No payments yet.</div>
          : list.data.items.map((p: any) => <Link key={p.id} to={p.subject.type === 'order' ? `/orders/${p.subject.id}` : p.subject.type === 'booking' ? `/bookings/${p.subject.id}` : '#'} className="card pad row">
            <div style={{ flex: 1 }}><b>{p.subject.title ?? 'Payment'}</b><div className="muted sm">{p.my_role === 'payer' ? 'You paid' : 'You received'} · {ago(p.created_at)}{p.failure_reason ? ` · ${p.failure_reason}` : ''}</div></div>
            <div style={{ textAlign: 'right' }}><b>{money(p.amount_cents)}</b><div><span className={`pill ${STATUS_PILL[p.status] ?? ''}`}>{STATUS_TEXT[p.status] ?? p.status}</span></div></div></Link>)}

        {disputes.data?.items?.length > 0 && <><h2 className="sec" style={{ margin: '6px 0 0' }}>Problem reports</h2>
          {disputes.data.items.map((d: any) => <Link key={d.id} to={`/disputes/${d.id}`} className="card pad row"><div style={{ flex: 1 }}><b>{d.subject.title}</b><div className="muted sm">{DISPUTE_REASONS[d.reason] ?? d.reason} · {ago(d.created_at)}</div></div><span className={`pill ${d.status === 'open' ? 'a' : 't'}`}>{d.status}</span></Link>)}</>}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------------------------------------ /disputes/:id
export function DisputePage() {
  const { id } = useParams(); const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['dispute', id], queryFn: () => api(`/disputes/${id}`), refetchInterval: 15_000 });
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="Report not found" action={<Link className="btn" to="/settings/payments">Back</Link>} /></main>;
  const d = q.data; const open = d.status === 'open';
  const send = async () => { setBusy(true); try { await api(`/disputes/${id}/messages`, { body: { body: text.trim() } }); setText(''); q.refetch(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  return (
    <main className="main"><div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>Problem report</h1><span className="sp" /><span className={`pill ${open ? 'a' : 't'}`}>{d.status}</span></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <div className="card pad col" style={{ gap: 6 }}><b>{d.subject.title}</b><div className="muted sm">{DISPUTE_REASONS[d.reason] ?? d.reason} · opened by {d.opened_by.is_me ? 'you' : `@${d.opened_by.username}`} {ago(d.created_at)} ago</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{d.description}</div>
          <Link className="btn sm soft" to={d.subject.type === 'order' ? `/orders/${d.subject.id}` : `/bookings/${d.subject.id}`}>View the {d.subject.type}</Link></div>
        {!open && d.status === 'resolved' && <div className="card pad col" style={{ background: '#E6FAF3' }}><b>Resolved by twiqo staff: {{ refund_full: 'full refund', refund_partial: `partial refund of ${money(d.refund_cents ?? 0)}`, no_refund: 'no refund' }[d.resolution as string] ?? d.resolution}</b><div className="sm">{d.resolution_note}</div></div>}
        <h2 className="sec" style={{ margin: '6px 0 0' }}>Conversation</h2>
        <div className="col">{d.messages.length === 0 && <div className="muted sm">No replies yet. Add details or evidence below.</div>}
          {d.messages.map((m: any) => <div key={m.id} className="card pad col" style={{ gap: 4, background: m.staff ? '#EEF3FF' : undefined }}><div className="row sm"><b>{m.staff ? 'twiqo team' : m.author.display_name}</b><span className="sp" /><span className="muted">{ago(m.created_at)}</span></div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>{m.photo_url && <img src={m.photo_url} alt="Evidence" style={{ width: 160, borderRadius: 12 }} />}</div>)}</div>
        {open && <div className="card pad col"><textarea className="input" aria-label="Reply" style={{ minHeight: 80 }} placeholder="Add a reply or more details" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn" disabled={busy || !text.trim()} onClick={send}>Send</button>
          {d.opened_by.is_me && <button className="btn ghost" onClick={async () => { if (!confirm('Withdraw this report?')) return; try { await api(`/disputes/${id}/withdraw`, { body: {} }); qc.invalidateQueries(); q.refetch(); toast('Report withdrawn'); } catch (e) { toast(errMsg(e), 'err'); } }}>Withdraw report</button>}</div>}
        <div className="muted sm">twiqo staff review reports and can issue a full or partial refund from the seller's or driver's earnings. This is a review service, not insurance.</div>
      </div>
    </main>
  );
}
