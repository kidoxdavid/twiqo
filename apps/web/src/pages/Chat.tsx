import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon, Ticks } from '../components/Icon';
import { useToast } from '../components/Toast';
import { OfferCard } from '../components/transport';
import { Avatar, ImageUploader, ReportDialog, State, ago, errMsg, type Uploaded } from '../components/ui';

export function Inbox() {
  const [q, setQ] = useState('');
  const c = useQuery({ queryKey: ['convs', q], queryFn: () => api('/conversations', { query: { q } }) });
  return (
    <main className="main"><h1 className="page">Messages</h1>
      <div style={{ padding: '0 16px 12px' }}><input className="input" aria-label="Search conversations" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {c.isLoading ? <State kind="loading" /> : c.isError ? <State kind="error" /> : c.data.items.length === 0 ? <State kind="empty" title={q ? 'No matches' : 'No messages yet'} text={q ? undefined : 'Message a seller from any listing to start a conversation.'} action={!q && <Link className="btn" to="/market">Browse the market</Link>} />
        : <div className="convs">{c.data.items.map((x: any) => (
          <Link key={x.id} to={`/messages/${x.id}`}><Avatar user={x.other} size={48} />
            <div style={{ flex: 1, minWidth: 0 }}><div className="row"><b>{x.other.display_name}</b><span className="sp" /><span className="muted sm">{ago(x.last_message_at)}</span></div>
              {x.subject && <div className="sm" style={{ color: 'var(--blue)', fontWeight: 600 }}>Re: {x.subject.title}</div>}
              <div className="last">{x.last_message ? (x.last_message.kind === 'image' ? '📷 Photo' : x.last_message.body) : 'No messages yet'}</div></div>
            {x.unread > 0 && <span className="unread" aria-label={`${x.unread} unread`}>{x.unread}</span>}</Link>))}</div>}
    </main>
  );
}

export function NewThread() {
  const [sp] = useSearchParams(); const nav = useNavigate(); const toast = useToast(); const to = sp.get('to'); const listing = sp.get('listing'); const subjectType = listing ? 'listing' : sp.get('subject_type'); const subjectId = listing ?? sp.get('subject_id');
  const l = useQuery({ queryKey: ['listing', listing], queryFn: () => api(`/listings/${listing}`), enabled: !!listing });
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (l.data && !msg) setMsg(`Hi! Is "${l.data.title}" still available?`); }, [l.data]); // eslint-disable-line
  if (!to) return <main className="main"><State kind="empty" title="Choose someone to message" /></main>;
  async function start() {
    setBusy(true);
    try { const r = await api('/conversations', { body: { recipient_id: to, subject_type: subjectType ?? undefined, subject_id: subjectId ?? undefined, message: msg.trim() || undefined } }); nav(`/messages/${r.id}`, { replace: true }); }
    catch (e) { toast(errMsg(e), 'err'); setBusy(false); }
  }
  return (
    <main className="main"><h1 className="page">New message</h1>
      <div className="card pad col" style={{ margin: '0 16px' }}>
        {l.data && <div className="attach"><div className="th">{l.data.images[0] && <img src={l.data.images[0].thumb_url} alt="" />}</div><div className="tx"><b>{l.data.title}</b><span className="muted sm">{l.data.seller.display_name}</span></div></div>}
        <div className="field"><label htmlFor="m">Message</label><textarea id="m" className="input" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={4000} /></div>
        <button className="btn" disabled={busy} onClick={start}>{busy ? 'Sending…' : 'Send message'}</button>
      </div>
    </main>
  );
}

export function Thread() {
  const { id } = useParams(); const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); const nav = useNavigate();
  const convs = useQuery({ queryKey: ['convs', ''], queryFn: () => api('/conversations', { query: {} }) });
  const conv = convs.data?.items.find((c: any) => c.id === id);
  const msgs = useQuery({ queryKey: ['thread', id], queryFn: () => api(`/conversations/${id}/messages`), refetchInterval: 20_000 });
  const [body, setBody] = useState(''); const [photo, setPhoto] = useState<Uploaded[]>([]); const [busy, setBusy] = useState(false); const [report, setReport] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.data]);
  useEffect(() => { if (msgs.data) api(`/conversations/${id}/read`, { method: 'POST' }).then(() => { qc.invalidateQueries({ queryKey: ['unread'] }); qc.invalidateQueries({ queryKey: ['convs'] }); }).catch(() => {}); }, [msgs.data?.items.length, id, qc]); // eslint-disable-line
  async function send() {
    setBusy(true);
    try {
      if (photo[0]) await api(`/conversations/${id}/messages`, { body: { kind: 'image', media_id: photo[0].id } });
      if (body.trim()) await api(`/conversations/${id}/messages`, { body: { kind: 'text', body: body.trim() } });
      setBody(''); setPhoto([]); await qc.invalidateQueries({ queryKey: ['thread', id] });
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  if (msgs.isError) return <main className="main"><State kind="empty" title="Conversation not found" action={<Link className="btn" to="/messages">Back to messages</Link>} /></main>;
  return (
    <main className="main" style={{ paddingBottom: 90 }}>
      <div className="row" style={{ padding: '0 16px 10px' }}>
        <button onClick={() => nav('/messages')} aria-label="Back to messages"><Icon name="back" /></button>
        {conv && <Link to={`/u/${conv.other.username}`} className="row"><Avatar user={conv.other} size={40} /><div><b>{conv.other.display_name}</b>{conv.subject && <div className="sm muted">Re: {conv.subject.title}</div>}</div></Link>}
        <span className="sp" />
        {conv?.subject && conv.subject.type === 'listing' && <Link className="btn sm soft" to={`/l/${conv.subject.id}`}>View listing</Link>}{conv?.subject && conv.subject.type === 'journey' && <Link className="btn sm soft" to={`/j/${conv.subject.id}`}>View journey</Link>}{conv?.subject && conv.subject.type === 'transport_request' && <Link className="btn sm soft" to={`/r/${conv.subject.id}`}>View shipment</Link>}{conv?.subject && conv.subject.type === 'service' && <Link className="btn sm soft" to={`/s/${conv.subject.id}`}>View service</Link>}
      </div>
      <div className="thread card" style={{ margin: '0 0 0' }}>
        <div className="msgs" role="log" aria-live="polite">
          {msgs.isLoading ? <State kind="loading" /> : msgs.data.items.length === 0 ? <State kind="empty" title="Say hello" /> : msgs.data.items.map((m: any) => {
            const mine = m.sender_id === me?.id;
            if (m.kind === 'offer' && m.offer) return <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width: '100%', maxWidth: 320 }}>{m.payload.event === 'accepted'
              ? <div className="card pad row" style={{ background: 'linear-gradient(135deg,#E1EBFF,#DDF6F4)', boxShadow: 'none' }}><span style={{ width: 44, height: 44, borderRadius: 14, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ticks w={28} /></span><div><b>Connection confirmed</b><div className="muted sm">{(m.offer.amount_cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })} agreed</div>{m.offer.booking_id ? <Link className="sm" style={{ color: 'var(--blue)', fontWeight: 700 }} to={`/bookings/${m.offer.booking_id}`}>View booking</Link> : m.offer.order_id ? <Link className="sm" style={{ color: 'var(--blue)', fontWeight: 700 }} to={`/orders/${m.offer.order_id}`}>View order</Link> : null}</div></div>
              : <OfferCard o={m.offer} compact />}</div>;
            if (m.kind === 'booking') return <div key={m.id} className="sm muted" style={{ alignSelf: 'center', textAlign: 'center', padding: '4px 10px', background: 'var(--cloud)', borderRadius: 12 }}>{({ pickup_confirmed: 'Pickup confirmed', in_transit: 'On the way', update: 'New update', delivered: 'Delivery confirmed', cancelled: 'Booking cancelled' } as Record<string, string>)[m.payload.event] ?? 'Booking update'} · <Link style={{ color: 'var(--blue)', fontWeight: 700 }} to={`/bookings/${m.payload.booking_id}`}>View</Link></div>;
            return (
              <div key={m.id} className={`msg ${mine ? 'out' : 'in'}`} onContextMenu={(e) => { if (!mine) { e.preventDefault(); setReport(m.id); } }}>
                {m.removed ? <i>Message removed</i> : m.image_url ? <img src={m.image_url} alt="Shared" /> : m.body}{m.warning && <div role="alert" style={{ marginTop: 6, padding: '8px 10px', borderRadius: 10, background: '#FFF1D6', color: '#6B4300', fontSize: 12.5, fontWeight: 600 }}>⚠ {m.warning}</div>}
                <div className="tm">{ago(m.created_at)}{mine && <svg width="16" height="12" viewBox="0 0 70 50" fill="none" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" aria-label={m.read ? 'Read' : 'Sent'}><path d="M5 25L17 37L39 9" stroke={m.read ? '#7FF0E8' : 'rgba(255,255,255,.55)'} />{m.read && <path d="M23 27L35 39L61 9" stroke="#7FF0E8" />}</svg>}</div>
                {!mine && !m.removed && <button className="sm" style={{ opacity: 0.6, fontSize: 11, marginTop: 4 }} onClick={() => setReport(m.id)}>Report</button>}
              </div>);
          })}
          <div ref={end} />
        </div>
        <div className="composer">
          <ImageUploader value={photo} onChange={setPhoto} max={1} />
          <input className="input" aria-label="Message" placeholder="Message…" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (body.trim() || photo[0]) && send()} />
          <button className="btn" disabled={busy || (!body.trim() && !photo[0])} onClick={send} aria-label="Send"><Icon name="share" /></button>
        </div>
      </div>
      {report && <ReportDialog target={{ type: 'message', id: report }} onClose={() => setReport(null)} />}
    </main>
  );
}
