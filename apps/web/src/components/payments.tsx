import { Suspense, lazy, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from './Toast';
import { Modal, State, errMsg, money } from './ui';

const StripeCheckout = lazy(() => import('./StripeCheckout'));

export const PAY_LABEL: Record<string, string> = { unpaid: 'Not paid on twiqo', paid: 'Paid by card', partially_refunded: 'Partly refunded', refunded: 'Refunded' };
export const PAY_PILL: Record<string, string> = { unpaid: '', paid: 't', partially_refunded: 'a', refunded: 'b' };

// ------------------------------------------------------------------------------------------------ pay
export function PayDialog({ subject, onClose, onDone }: { subject: { order_id?: string; booking_id?: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const start = useQuery({ queryKey: ['checkout', subject.order_id ?? subject.booking_id], queryFn: () => api('/payments/checkout', { body: subject }), retry: false, staleTime: Infinity, gcTime: 0 });
  const [busy, setBusy] = useState(false);
  const d = start.data;
  const finish = () => { toast('Payment received'); onDone(); onClose(); };
  async function fake(outcome: 'succeeded' | 'failed') {
    setBusy(true);
    try { const p = await api('/payments/fake/pay', { body: { payment_id: d.payment.id, outcome } }); if (p.status === 'succeeded') finish(); else toast(p.failure_reason ?? 'The card was declined', 'err'); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  return <Modal onClose={onClose} title="Pay by card">
    <div className="col">
      {start.isLoading && <State kind="loading" />}
      {start.isError && <div className="col"><div className="err" role="alert">{errMsg(start.error)}</div><button className="btn ghost" onClick={onClose}>Close</button></div>}
      {d && <>
        <div className="card pad row"><span className="muted">Total</span><span className="sp" /><b style={{ fontSize: 22 }}>{money(d.payment.amount_cents)}</b></div>
        {d.provider === 'fake'
          ? <div className="card pad col" style={{ background: '#FFF6E0' }}><b>Test mode</b><div className="sm">No real card is charged. This panel only exists when the payment provider is set to "fake" for development.</div>
              <button className="btn teal" disabled={busy} onClick={() => fake('succeeded')}>Pay with test card</button><button className="btn ghost" disabled={busy} onClick={() => fake('failed')}>Simulate a declined card</button></div>
          : <Suspense fallback={<State kind="loading" />}><StripeCheckout publishableKey={d.publishable_key} clientSecret={d.client_secret} amount={money(d.payment.amount_cents)} onPaid={finish} /></Suspense>}
        <div className="muted sm">Payments are processed by Stripe. The seller receives the payment minus twiqo's fee after Stripe's payout delay. twiqo does not hold your money in escrow, so if something goes wrong use "Report a problem" and our team will review it.</div>
      </>}
    </div></Modal>;
}

// ------------------------------------------------------------------------------------------------ refund
export function RefundDialog({ payment, onClose, onDone }: { payment: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const left = payment.amount_cents - payment.refunded_cents;
  const [amount, setAmount] = useState((left / 100).toFixed(2)); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const cents = Math.round(parseFloat(amount) * 100); const ok = cents >= 1 && cents <= left && reason.trim().length >= 3;
  return <Modal onClose={onClose} title="Refund the buyer"><div className="col">
    <div className="field"><label htmlFor="ra">Amount (up to {money(left)})</label><input id="ra" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
    <div className="field"><label htmlFor="rr">Reason</label><input id="rr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown to the buyer" /></div>
    <div className="muted sm">The refund comes out of your earnings. twiqo's fee is returned in proportion, according to current settings.</div>
    <button className="btn danger" disabled={!ok || busy} onClick={async () => { setBusy(true); try { await api(`/payments/${payment.id}/refund`, { body: { amount_cents: cents, reason: reason.trim() } }); toast('Refund sent'); onDone(); onClose(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }}>Refund {ok ? money(cents) : ''}</button></div></Modal>;
}

// ------------------------------------------------------------------------------------------------ order / booking payment panel
export function PaymentPanel({ kind, id, status, buyerSide, canPay, disputeId, onChanged }: { kind: 'order' | 'booking'; id: string; status: string; buyerSide: boolean; canPay: boolean; disputeId?: string | null; onChanged: () => void }) {
  const qc = useQueryClient(); const [pay, setPay] = useState(false); const [refund, setRefund] = useState(false);
  const list = useQuery({ queryKey: ['payments', 'subject', id], queryFn: () => api('/payments'), select: (r: any) => r.items.find((p: any) => p.subject?.id === id && ['succeeded', 'partially_refunded', 'refunded'].includes(p.status)) });
  const p = list.data; const done = () => { qc.invalidateQueries(); onChanged(); };
  return <div className="card pad col" aria-label="Payment">
    <div className="row"><h2 className="sec" style={{ margin: 0 }}>Payment</h2><span className="sp" /><span className={`pill ${PAY_PILL[status] ?? ''}`}>{PAY_LABEL[status] ?? status}</span></div>
    {p && <div className="sm">{money(p.amount_cents)} paid{p.refunded_cents > 0 && <> · {money(p.refunded_cents)} refunded</>}{p.my_role === 'payee' && p.fee_cents !== undefined && <> · twiqo fee {money(p.fee_cents)} · you receive {money(p.net_cents - 0)}</>}</div>}
    {status === 'unpaid' && <div className="muted sm">{buyerSide ? 'You can pay by card here, or arrange payment directly with them.' : 'The buyer can pay by card here, or pay you directly. Card payments need payout setup.'}</div>}
    {canPay && status === 'unpaid' && <button className="btn" onClick={() => setPay(true)}>Pay by card</button>}
    {!buyerSide && status === 'unpaid' && <Link className="btn soft" to="/settings/payments">Set up card payouts</Link>}
    {p?.can_refund && <button className="btn ghost" onClick={() => setRefund(true)}>Refund…</button>}
    {disputeId && <Link className="btn soft" to={`/disputes/${disputeId}`}>View the open dispute</Link>}
    {pay && <PayDialog subject={kind === 'order' ? { order_id: id } : { booking_id: id }} onClose={() => setPay(false)} onDone={done} />}
    {refund && p && <RefundDialog payment={p} onClose={() => setRefund(false)} onDone={done} />}
  </div>;
}

// ------------------------------------------------------------------------------------------------ disputes
export const DISPUTE_REASONS: Record<string, string> = { not_delivered: 'Item never arrived', not_as_described: 'Not as described', damaged: 'Damaged', no_show: 'No-show', payment_issue: 'Payment problem', other: 'Something else' };

export function ReportProblem({ subject, onDone }: { subject: { order_id?: string; booking_id?: string }; onDone: (id: string) => void }) {
  const toast = useToast(); const [open, setOpen] = useState(false); const [reason, setReason] = useState('not_as_described'); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  return <>
    <button className="btn ghost" onClick={() => setOpen(true)}>Report a problem</button>
    {open && <Modal onClose={() => setOpen(false)} title="Report a problem"><div className="col">
      <div className="field"><label htmlFor="dr">What went wrong?</label><select id="dr" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(DISPUTE_REASONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="field"><label htmlFor="dd">Tell us what happened</label><textarea id="dd" className="input" style={{ minHeight: 100 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="At least a couple of sentences, so our team can review it." /></div>
      <div className="muted sm">The other person is told and can reply. Completion is paused until our team has reviewed it. This is a review by twiqo staff, not an insurance claim or a guarantee of a refund.</div>
      <button className="btn" disabled={busy || text.trim().length < 10} onClick={async () => { setBusy(true); try { const d = await api('/disputes', { body: { ...subject, reason, description: text.trim() } }); toast('Report sent'); setOpen(false); onDone(d.id); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }}>Send report</button></div></Modal>}
  </>;
}

// ------------------------------------------------------------------------------------------------ boosts
export function BoostButton({ targetType, targetId }: { targetType: 'listing' | 'transport_service' | 'post'; targetId: string }) {
  const [open, setOpen] = useState(false);
  return <><button className="btn soft" onClick={() => setOpen(true)}>Boost</button>{open && <BoostFlow targetType={targetType} targetId={targetId} onClose={() => setOpen(false)} />}</>;
}
export function BoostFlow({ targetType, targetId, onClose }: { targetType: 'listing' | 'transport_service' | 'post'; targetId: string; onClose: () => void }) {
  const [pay, setPay] = useState<any>(null); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['boost-pricing'], queryFn: () => api('/boosts/pricing') });
  const opts = (q.data?.options ?? []).filter((o: any) => o.target_type === targetType);
  async function choose(o: any) {
    try { const r = await api('/boosts', { body: { target_type: targetType, target_id: targetId, placement: o.placement } }); setPay(r); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return <>
    {!pay && <Modal onClose={onClose} title="Boost this"><div className="col">
      {q.isLoading ? <State kind="loading" /> : opts.length === 0 ? <div className="muted">Boosts are not available for this right now.</div> : opts.map((o: any) => <button key={o.placement} className="card pad row" style={{ textAlign: 'left' }} onClick={() => choose(o)}>
        <div style={{ flex: 1 }}><b>{o.label}</b><div className="muted sm">{o.days} days · {o.placement === 'featured' ? 'ranks higher in browse and search' : 'shown in other people\'s feeds, always labelled "Sponsored"'}</div></div><b>{money(o.price_cents)}</b></button>)}
      <div className="muted sm">Boosts are paid advertising. They improve visibility but don't guarantee sales, and they are not refundable once running unless our team agrees.</div></div></Modal>}
    {pay && <BoostPay r={pay} onClose={onClose} onDone={() => { qc.invalidateQueries(); }} />}
  </>;
}
function BoostPay({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const [busy, setBusy] = useState(false);
  const fin = () => { toast('Boost is live'); onDone(); onClose(); };
  return <Modal onClose={onClose} title="Pay for your boost"><div className="col">
    <div className="card pad row"><span>{r.payment.subject.title}</span><span className="sp" /><b>{money(r.payment.amount_cents)}</b></div>
    {r.provider === 'fake'
      ? <div className="card pad col" style={{ background: '#FFF6E0' }}><b>Test mode</b><div className="sm">No real card is charged.</div><button className="btn teal" disabled={busy} onClick={async () => { setBusy(true); try { await api('/payments/fake/pay', { body: { payment_id: r.payment.id } }); fin(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }}>Pay with test card</button></div>
      : <Suspense fallback={<State kind="loading" />}><StripeCheckout publishableKey={r.publishable_key} clientSecret={r.client_secret} amount={money(r.payment.amount_cents)} onPaid={fin} /></Suspense>}
  </div></Modal>;
}
