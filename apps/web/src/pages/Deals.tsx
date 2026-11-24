import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { OfferCard, RouteLine, fmtDate, fmtDateTime, windowText } from '../components/transport';
import { Icon, Ticks } from '../components/Icon';
import { t, useLocale } from '../i18n';
import { PaymentPanel, ReportProblem } from '../components/payments';
import { Avatar, ImageUploader, Modal, State, ago, errMsg, money, type Uploaded } from '../components/ui';

// ------------------------------------------------------------------------------------------------ offers inbox
export function Offers() {
  useLocale();
  const [tab, setTab] = useState<'received' | 'sent' | 'closed'>('received');
  const q = useQuery({ queryKey: ['offers', tab], queryFn: () => api('/offers', { query: tab === 'closed' ? { state: 'closed' } : { role: tab, state: 'active' } }) });
  return (
    <main className="main"><h1 className="page">{t('deals.offers')}</h1>
      <div className="tabs" role="tablist">{([['received', t('deals.waiting')], ['sent', t('deals.sent')], ['closed', t('deals.closed')]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="col" style={{ padding: '0 16px' }}>
        {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="error" /> : q.data.items.length === 0
          ? <State kind="empty" title={tab === 'received' ? 'No offers waiting' : tab === 'sent' ? "You haven't sent any open offers" : 'Nothing closed yet'} text={tab === 'sent' ? 'Make an offer on a listing or book space on a journey.' : undefined} action={tab === 'sent' && <div className="row" style={{ justifyContent: 'center' }}><Link className="btn" to="/market">Browse the market</Link><Link className="btn ghost" to="/move">Find a driver</Link></div>} />
          : q.data.items.map((o: any) => <OfferCard key={o.id} o={o} />)}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------------------------------------ bookings
const STEPS: [string, string][] = [['confirmed', 'Move confirmed'], ['pickup_confirmed', 'Pickup confirmed'], ['in_transit', 'In transit'], ['delivered', 'Delivery confirmed']];
const ORDER = ['confirmed', 'pickup_confirmed', 'in_transit', 'delivered', 'completed'];

export function Bookings() {
  useLocale();
  const [tab, setTab] = useState<'active' | 'done'>('active');
  const b = useQuery({ queryKey: ['bookings', tab], queryFn: () => api('/bookings', { query: { state: tab } }) });
  const o = useQuery({ queryKey: ['orders'], queryFn: () => api('/orders') });
  return (
    <main className="main"><h1 className="page">{t('deals.moves_orders')}</h1>
      <div className="tabs">{([['active', t('deals.active')], ['done', t('deals.past')]] as const).map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="col" style={{ padding: '0 16px' }}>
        <h2 className="sec">{t('deals.transport')}</h2>
        {b.isLoading ? <State kind="loading" /> : b.data.items.length === 0 ? <State kind="empty" title="No bookings here" action={<Link className="btn" to="/move">Find a driver</Link>} />
          : b.data.items.map((x: any) => <Link key={x.id} to={`/bookings/${x.id}`} className="card pad col" style={{ gap: 8 }}>
            <div className="row"><b>{x.shipment.title}</b><span className="sp" /><span className={`pill ${x.status === 'completed' ? 't' : x.status === 'cancelled' ? 'r' : 'b'}`}>{x.status.replace('_', ' ')}</span></div>
            <RouteLine from={x.shipment.from.city} to={x.shipment.to.city} />
            <div className="row sm muted"><span>{x.my_role === 'shipper' ? 'Carried by' : 'Shipping for'} {x.counterparty.display_name}</span><span className="sp" /><b style={{ color: 'var(--navy)' }}>{money(x.agreed_cents)}</b></div></Link>)}
        <h2 className="sec">{t('deals.purchases')}</h2>
        {o.isLoading ? <State kind="loading" /> : o.data.items.length === 0 ? <div className="muted">No orders yet.</div>
          : o.data.items.map((x: any) => <Link key={x.id} to={`/orders/${x.id}`} className="attach"><div className="th">{x.listing.image_url && <img src={x.listing.image_url} alt="" />}</div><div className="tx"><b>{x.listing.title}</b><span className="muted sm">{x.my_role === 'buyer' ? 'Bought from' : 'Sold to'} {x.counterparty.display_name} · {money(x.total_cents)}</span></div><span className={`pill ${x.status === 'completed' ? 't' : x.status === 'cancelled' ? 'r' : 'b'}`}>{x.status}</span></Link>)}
      </div>
    </main>
  );
}

function Stepper({ status }: { status: string }) {
  const idx = ORDER.indexOf(status);
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 0 }} role="list" aria-label="Delivery progress">
      {STEPS.map(([k, l], i) => { const done = idx > i || status === 'completed' || (idx === i && i === 3); const cur = idx === i && !done;
        return <div key={k} role="listitem" style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: 600, color: done || cur ? 'var(--navy)' : '#8A94AE' }}>
          <div style={{ position: 'relative', height: 34 }}>{i > 0 && <span style={{ position: 'absolute', left: '-50%', right: '50%', top: 16, height: 2, background: idx >= i ? 'var(--teal)' : 'var(--line)' }} />}
            <span style={{ position: 'relative', width: 34, height: 34, borderRadius: '50%', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? 'var(--teal)' : cur ? 'var(--blue)' : '#E4EAF6', color: '#fff', boxShadow: cur ? '0 0 0 6px rgba(36,107,253,.18)' : undefined }}>{i === 3 ? <Ticks w={18} white /> : <Icon name={['shield', 'box', 'truck'][i]} className="" />}</span></div>
          <div style={{ marginTop: 6 }}>{l}</div></div>; })}
    </div>
  );
}

function PinBox({ label, pin, hint }: { label: string; pin: string; hint: string }) {
  return <div style={{ textAlign: 'center' }}><div className="muted" style={{ fontWeight: 700, letterSpacing: 0.8, fontSize: 11.5 }}>{label}</div>
    <div className="row" style={{ justifyContent: 'center', gap: 8, margin: '8px 0 4px' }} aria-label={`${label}: ${pin.split('').join(' ')}`}>{pin.split('').map((d, i) => <span key={i} style={{ width: 50, height: 60, borderRadius: 14, background: 'var(--cloud)', border: '1.5px solid var(--line)', fontSize: 28, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{d}</span>)}</div>
    <div className="muted sm">{hint}</div></div>;
}

function PinForm({ id, kind, onDone }: { id: string; kind: 'pickup' | 'deliver'; onDone: () => void }) {
  const toast = useToast(); const [pin, setPin] = useState(''); const [photo, setPhoto] = useState<Uploaded[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <form className="col" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await api(`/bookings/${id}/${kind}`, { body: { pin, photo_media_id: photo[0]?.id } }); toast(kind === 'pickup' ? 'Pickup confirmed' : 'Delivery confirmed'); setPin(''); onDone(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); } }}>
      <div className="field"><label htmlFor={`pin-${kind}`}>{kind === 'pickup' ? 'Ask the shipper for the pickup PIN' : 'Ask the receiver for the delivery PIN'}</label>
        <input id={`pin-${kind}`} className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={4} pattern="\d{4}" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} style={{ fontSize: 24, letterSpacing: 12, textAlign: 'center', fontWeight: 800 }} placeholder="••••" /></div>
      <div className="field"><label>Photo evidence (optional)</label><ImageUploader value={photo} onChange={setPhoto} max={1} /></div>
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn teal" disabled={busy || pin.length !== 4}>{kind === 'pickup' ? 'Confirm pickup' : 'Confirm delivery'}</button>
    </form>
  );
}

export function BookingPage() {
  const { id } = useParams(); const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['booking', id], queryFn: () => api(`/bookings/${id}`), refetchInterval: 20_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['bookings'] }); };
  const [cancel, setCancel] = useState(false); const [reason, setReason] = useState(''); const [stars, setStars] = useState(5); const [comment, setComment] = useState('');
  const [upd, setUpd] = useState({ note: '', loc: '' }); const [updPhoto, setUpdPhoto] = useState<Uploaded[]>([]); const [addr, setAddr] = useState<any>(null); const [busy, setBusy] = useState(false);
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="Booking not found" action={<Link className="btn" to="/bookings">My moves</Link>} /></main>;
  const b = q.data; const ship = b.my_role === 'shipper'; const has = (a: string) => b.actions.includes(a); const a = addr ?? b.address;
  const call = async (path: string, body: unknown = {}, ok = 'Updated') => { setBusy(true); try { await api(`/bookings/${id}/${path}`, { body }); toast(ok); refresh(); return true; } catch (e) { toast(errMsg(e), 'err'); return false; } finally { setBusy(false); } };
  return (
    <main className="main"><div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav('/bookings')} aria-label="Back"><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>Your move</h1><span className="sp" /><span className={`pill ${b.status === 'completed' ? 't' : b.status === 'cancelled' ? 'r' : 'b'}`}>{b.status.replace('_', ' ')}</span></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <div className="card pad col" style={{ gap: 8 }}>
          <div className="row"><Link to={`/r/${b.shipment.request_id}`} style={{ fontWeight: 800, fontSize: 17, flex: 1 }}>{b.shipment.title}</Link><b style={{ fontSize: 18 }}>{money(b.agreed_cents)}</b></div>
          <RouteLine from={b.shipment.from.city} to={b.shipment.to.city} />
          <div className="muted sm">{b.shipment.quantity > 1 ? `${b.shipment.quantity} × ` : ''}{b.shipment.weight_kg} kg · pickup {windowText(b.shipment.pickup_from, b.shipment.pickup_to)}{b.carrier?.departure_at ? ` · departs ${fmtDateTime(b.carrier.departure_at)}` : ''}</div>
          <div className="row"><Link to={`/u/${b.counterparty.username}`} className="row" style={{ flex: 1 }}><Avatar user={b.counterparty} size={36} /><div><b className="sm">{b.counterparty.display_name}</b><div className="muted sm">{ship ? 'Your transporter' : 'Shipper'}</div></div></Link><Link className="btn sm soft" to={`/messages/new?to=${b.counterparty.id}&subject_type=${b.carrier?.type ?? 'transport_request'}&subject_id=${b.carrier?.id ?? b.shipment.request_id}`}><Icon name="chat" />Message</Link></div>
        </div>
        {b.status !== 'cancelled' && <div className="card pad"><Stepper status={b.status} /></div>}
        {b.cancel && <div className="card pad" style={{ background: '#FFE9EC' }}><b>Cancelled by {b.cancel.by}</b><div className="sm">{b.cancel.reason}</div></div>}

        {ship && b.pins && ['confirmed', 'pickup_confirmed', 'in_transit'].includes(b.status) && <div className="card pad col">
          {b.status === 'confirmed' ? <PinBox label="YOUR PICKUP PIN" pin={b.pins.pickup} hint="Read this to the driver when they collect your item." /> : <PinBox label="YOUR DELIVERY PIN" pin={b.pins.delivery} hint="Give this to the driver only when your item arrives." />}
          <div className="muted sm" style={{ textAlign: 'center' }}>Never share a PIN before the handover happens.</div></div>}
        {!ship && b.status === 'confirmed' && has('confirm_pickup') && <div className="card pad"><h2 className="sec">Confirm pickup</h2><PinForm id={b.id} kind="pickup" onDone={refresh} />{b.pin_locked_until && <div className="err" style={{ marginTop: 8 }}>PIN entry is locked until {fmtDateTime(b.pin_locked_until)}.</div>}</div>}
        {!ship && has('post_update') && <div className="card pad col"><h2 className="sec" style={{ margin: 0 }}>Share an update</h2>
          <input className="input" aria-label="Where are you?" placeholder="Where are you? e.g. Winnipeg, MB" value={upd.loc} onChange={(e) => setUpd({ ...upd, loc: e.target.value })} />
          <input className="input" aria-label="Note" placeholder="Note for the shipper (optional)" value={upd.note} onChange={(e) => setUpd({ ...upd, note: e.target.value })} />
          <ImageUploader value={updPhoto} onChange={setUpdPhoto} max={1} />
          <button className="btn" disabled={busy} onClick={async () => { if (await call('transit', { note: upd.note || undefined, location_label: upd.loc || undefined, photo_media_id: updPhoto[0]?.id }, b.status === 'pickup_confirmed' ? "You're on the way" : 'Update shared')) { setUpd({ note: '', loc: '' }); setUpdPhoto([]); } }}>{b.status === 'pickup_confirmed' ? 'Start the journey' : 'Post update'}</button></div>}
        {!ship && has('confirm_delivery') && <div className="card pad"><h2 className="sec">Confirm delivery</h2><PinForm id={b.id} kind="deliver" onDone={refresh} />{b.pin_locked_until && <div className="err" style={{ marginTop: 8 }}>PIN entry is locked until {fmtDateTime(b.pin_locked_until)}.</div>}</div>}
        {ship && has('confirm_receipt') && <div className="card pad col"><b>Your item was delivered</b><div className="muted sm">Confirm you received it to complete the move. If you don't, it completes automatically after a few days.</div><button className="btn teal" disabled={busy} onClick={() => call('complete', {}, 'Move completed')}>Confirm I received it</button></div>}

        {b.status !== 'cancelled' && <PaymentPanel kind="booking" id={b.id} status={b.payment_status} buyerSide={ship} canPay={has('pay')} disputeId={b.dispute_id} onChanged={refresh} />}
        {['pickup_confirmed', 'in_transit', 'delivered', 'completed'].includes(b.status) && !b.dispute_id && <ReportProblem subject={{ booking_id: b.id }} onDone={(d) => nav(`/disputes/${d}`)} />}

        {b.status !== 'cancelled' && <div className="card pad col"><h2 className="sec" style={{ margin: 0 }}>Addresses <span className="pill" style={{ verticalAlign: 'middle' }}>private</span></h2>
          {ship && has('set_address') ? <>
            <div className="field"><label htmlFor="pa">Pickup address</label><input id="pa" className="input" value={a.pickup_address ?? ''} onChange={(e) => setAddr({ ...a, pickup_address: e.target.value })} /></div>
            <div className="field"><label htmlFor="pn">Pickup notes</label><input id="pn" className="input" value={a.pickup_notes ?? ''} onChange={(e) => setAddr({ ...a, pickup_notes: e.target.value })} placeholder="Buzzer, parking, who to ask for" /></div>
            <div className="field"><label htmlFor="da">Delivery address</label><input id="da" className="input" value={a.delivery_address ?? ''} onChange={(e) => setAddr({ ...a, delivery_address: e.target.value })} /></div>
            <div className="field"><label htmlFor="dn">Delivery notes</label><input id="dn" className="input" value={a.delivery_notes ?? ''} onChange={(e) => setAddr({ ...a, delivery_notes: e.target.value })} /></div>
            <div className="field"><label htmlFor="cp">Phone for the driver</label><input id="cp" className="input" value={a.contact_phone ?? ''} onChange={(e) => setAddr({ ...a, contact_phone: e.target.value })} /></div>
            <div className="muted sm">Only you and your transporter can see these. They are never shown on listings, requests or feeds.</div>
            <button className="btn" disabled={busy || !addr} onClick={async () => { setBusy(true); try { await api(`/bookings/${id}/address`, { method: 'PUT', body: Object.fromEntries(Object.entries(a).filter(([, v]) => v)) }); toast('Addresses saved'); setAddr(null); refresh(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }}>Save addresses</button></>
            : <div className="col sm" style={{ gap: 6 }}>{a.pickup_address || a.delivery_address ? <>
              <div><b>Pickup:</b> {a.pickup_address ?? '—'}{a.pickup_notes ? ` (${a.pickup_notes})` : ''}</div><div><b>Delivery:</b> {a.delivery_address ?? '—'}{a.delivery_notes ? ` (${a.delivery_notes})` : ''}</div>{a.contact_phone && <div><b>Phone:</b> <a href={`tel:${a.contact_phone}`} style={{ color: 'var(--blue)' }}>{a.contact_phone}</a></div>}</> : <span className="muted">{ship ? 'Add them so your driver can find you.' : 'The shipper has not shared addresses yet.'}</span>}</div>}
        </div>}

        {has('review') && <div className="card pad col"><h2 className="sec" style={{ margin: 0 }}>How was {b.counterparty.display_name}?</h2>
          <div className="row" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setStars(n)} style={{ fontSize: 30, color: n <= stars ? 'var(--amber)' : '#D5DCEC' }}>★</button>)}</div>
          <textarea className="input" aria-label="Review" placeholder="Share a few words (optional)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 70 }} />
          <button className="btn" disabled={busy} onClick={() => call('reviews', { rating: stars, comment: comment || undefined }, 'Thanks for your review')}>Submit review</button></div>}
        {b.review.mine && <div className="card pad sm"><b>Your review:</b> {'★'.repeat(b.review.mine.rating)} {b.review.mine.comment}{b.review.theirs && <div style={{ marginTop: 6 }}><b>Their review of you:</b> {'★'.repeat(b.review.theirs.rating)} {b.review.theirs.comment}</div>}</div>}

        <h2 className="sec" style={{ margin: '6px 0 0' }}>Timeline</h2>
        <div className="card pad col" style={{ gap: 14 }}>{[...b.timeline].reverse().map((e: any) => <div key={e.id} className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: e.kind === 'cancelled' || e.kind === 'pin_locked' ? 'var(--red)' : 'var(--teal)', marginTop: 6, flex: 'none' }} />
          <div style={{ flex: 1 }}><b className="sm" style={{ textTransform: 'capitalize' }}>{e.kind.replace('_', ' ')}</b>{e.location_label && <span className="muted sm"> · {e.location_label}</span>}<div className="sm">{e.note}</div>{e.photo_url && <img src={e.photo_url} alt="Evidence" style={{ width: 120, borderRadius: 12, marginTop: 6 }} />}<div className="muted sm">{e.actor ? `@${e.actor} · ` : ''}{fmtDateTime(e.created_at)}</div></div></div>)}</div>

        {has('cancel') && <button className="btn ghost" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => setCancel(true)}>Cancel this booking</button>}
        <div className="muted sm">Pickup and delivery are verified with PINs and photos. Insurance depends on the transporter's own coverage; twiqo doesn't insure items, and card payments are not held in escrow.</div>
      </div>
      {cancel && <Modal onClose={() => setCancel(false)} title="Cancel this booking?"><div className="col"><div className="muted sm">Cancelling is only possible before pickup. {ship ? 'Your shipment goes back to open.' : 'The space on your journey is released.'}</div>
        <textarea className="input" aria-label="Reason" placeholder="Reason (the other person will see it)" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn danger" disabled={reason.trim().length < 3 || busy} onClick={async () => { if (await call('cancel', { reason }, 'Booking cancelled')) setCancel(false); }}>Cancel booking</button></div></Modal>}
    </main>
  );
}

// ------------------------------------------------------------------------------------------------ orders
export function OrderPage() {
  const { id } = useParams(); const toast = useToast(); const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api(`/orders/${id}`) }); const [stars, setStars] = useState(5); const [comment, setComment] = useState(''); const [busy, setBusy] = useState(false);
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="Order not found" action={<Link className="btn" to="/bookings">My orders</Link>} /></main>;
  const o = q.data; const has = (a: string) => o.actions.includes(a);
  const call = async (path: string, body: unknown = {}, ok = 'Updated') => { setBusy(true); try { await api(`/orders/${id}/${path}`, { body }); toast(ok); qc.invalidateQueries(); q.refetch(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  return (
    <main className="main"><div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav('/bookings')} aria-label="Back"><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>{o.my_role === 'buyer' ? 'Your purchase' : 'Your sale'}</h1><span className="sp" /><span className={`pill ${o.status === 'completed' ? 't' : o.status === 'cancelled' ? 'r' : 'b'}`}>{o.status}</span></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <Link to={`/l/${o.listing.id}`} className="attach"><div className="th">{o.listing.image_url && <img src={o.listing.image_url} alt="" />}</div><div className="tx"><b>{o.listing.title}</b><span className="muted sm">{o.quantity > 1 ? `${o.quantity} × ` : ''}agreed {money(o.total_cents)}</span></div></Link>
        <div className="card pad row"><Link to={`/u/${o.counterparty.username}`} className="row" style={{ flex: 1 }}><Avatar user={o.counterparty} size={42} /><div><b>{o.counterparty.display_name}</b><div className="muted sm">{o.my_role === 'buyer' ? 'Seller' : 'Buyer'}</div></div></Link>{o.my_role === 'buyer' && <Link className="btn sm soft" to={`/messages/new?to=${o.counterparty.id}&listing=${o.listing.id}`}><Icon name="chat" />Message</Link>}</div>
        <div className="card pad sm">Agreed on {fmtDate(o.created_at)}. Arrange pickup or delivery with {o.counterparty.display_name}. You can pay by card here or settle directly. twiqo doesn't hold funds in escrow.</div>
        {o.status !== 'cancelled' && <PaymentPanel kind="order" id={o.id} status={o.payment_status} buyerSide={o.my_role === 'buyer'} canPay={has('pay')} disputeId={o.dispute_id} onChanged={() => q.refetch()} />}
        {['agreed', 'completed'].includes(o.status) && !o.dispute_id && <ReportProblem subject={{ order_id: o.id }} onDone={(d) => nav(`/disputes/${d}`)} />}
        {has('arrange_transport') && <Link className="btn teal" to={`/create/request?listing=${o.listing.id}`}><Icon name="truck" />Arrange transport for this item</Link>}
        {o.transport_request && <Link className="btn ghost" to={`/r/${o.transport_request.id}`}>Transport request: {o.transport_request.status}</Link>}
        {has('complete') && <button className="btn" disabled={busy} onClick={() => call('complete', {}, 'Order completed')}>Mark as completed</button>}
        {has('cancel') && <button className="btn ghost" disabled={busy} onClick={() => confirm('Cancel this order? The item goes back on sale.') && call('cancel', {}, 'Order cancelled')}>Cancel order</button>}
        {has('review') && <div className="card pad col"><h2 className="sec" style={{ margin: 0 }}>Review {o.counterparty.display_name}</h2>
          <div className="row" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={stars === n} aria-label={`${n} stars`} onClick={() => setStars(n)} style={{ fontSize: 30, color: n <= stars ? 'var(--amber)' : '#D5DCEC' }}>★</button>)}</div>
          <textarea className="input" aria-label="Review" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional" style={{ minHeight: 70 }} /><button className="btn" disabled={busy} onClick={() => call('reviews', { rating: stars, comment: comment || undefined }, 'Thanks for your review')}>Submit review</button></div>}
        {o.review.mine && <div className="card pad sm"><b>Your review:</b> {'★'.repeat(o.review.mine.rating)} {o.review.mine.comment}</div>}
      </div>
    </main>
  );
}
void ago;
