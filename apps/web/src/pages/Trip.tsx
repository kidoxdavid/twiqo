import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Ticks } from '../components/Icon';
import { State, ago } from '../components/ui';

const LABEL: Record<string, string> = { confirmed: 'Booked, waiting for pickup', pickup_confirmed: 'Picked up', in_transit: 'On the way', delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled' };

/** Public page for a shared trip link: progress only, never addresses, PINs or phone numbers. */
export function TripPage() {
  const { token } = useParams(); const q = useQuery({ queryKey: ['trip', token], queryFn: () => api(`/trip/${token}`), refetchInterval: 30_000, retry: false });
  return <main className="auth"><div className="hero-auth"><Ticks w={56} /><h1 style={{ fontSize: 26 }}>twiqo</h1><div className="muted">A delivery someone is sharing with you</div></div>
    {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="empty" title="This link is no longer active" text="The person may have stopped sharing, or the link expired." /> : <div className="card pad col" style={{ gap: 10 }}>
      <div className="row"><b style={{ fontSize: 18, flex: 1 }}>{q.data.route.from} → {q.data.route.to}</b><span className={`pill ${q.data.status === 'cancelled' ? 'r' : q.data.status === 'delivered' || q.data.status === 'completed' ? 't' : 'b'}`}>{LABEL[q.data.status] ?? q.data.status}</span></div>
      <div className="sm">Moving: <b>{q.data.item}</b></div><div className="sm">Driver: <b>{q.data.driver_first_name}</b>{q.data.vehicle ? ` · ${String(q.data.vehicle).replace('_', ' ')}` : ''}</div>
      {q.data.picked_up_at && <div className="sm muted">Picked up {ago(q.data.picked_up_at)} ago</div>}{q.data.delivered_at && <div className="sm muted">Delivered {ago(q.data.delivered_at)} ago</div>}
      {q.data.location ? <div className="sm"><b>Last known location</b> · {ago(q.data.location.at)} ago · <a href={`https://www.openstreetmap.org/?mlat=${q.data.location.lat}&mlon=${q.data.location.lng}#map=13/${q.data.location.lat}/${q.data.location.lng}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)' }}>Open map</a></div> : <div className="sm muted">Live location isn't being shared.</div>}
      <div className="muted sm">{q.data.note} This page refreshes by itself. If you're worried about someone's safety, call 911.</div></div>}</main>;
}
