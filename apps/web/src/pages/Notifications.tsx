import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { State, ago } from '../components/ui';

const text = (n: any) => {
  const who = n.actor_name ?? 'Someone';
  switch (n.type) {
    case 'follow': return <><b>{who}</b> started following you</>;
    case 'comment': return <><b>{who}</b> commented on your {n.target_type}</>;
    case 'reply': return <><b>{who}</b> replied to a comment</>;
    case 'offer_received': return <><b>{who}</b> sent you an offer</>;
    case 'offer_countered': return <><b>{who}</b> made a counteroffer</>;
    case 'offer_accepted': return <><b>{who}</b> accepted — connection confirmed</>;
    case 'offer_rejected': return <>Your offer was {n.data?.reason === 'expired' ? 'not answered in time' : 'declined or closed'}</>;
    case 'booking_update': return <><b>{who}</b> updated your {n.target_type === 'order' ? 'order' : 'move'}: {String(n.data?.event ?? 'update').replace('_', ' ')}</>;
    case 'match': return <>New match ({n.data?.score}%): <b>{n.data?.title}</b></>;
    case 'journey_posted': return <><b>{who}</b> posted a journey: {n.data?.title}</>;
    case 'review_received': return <><b>{who}</b> left you a {n.data?.rating}★ review</>;
    default: return <>New activity from <b>{who}</b></>;
  }
};
const href = (n: any) => (['offer_received', 'offer_countered', 'offer_rejected'].includes(n.type) ? '/offers' : n.target_type === 'booking' ? `/bookings/${n.target_id}` : n.target_type === 'order' ? `/orders/${n.target_id}` : n.type === 'match' || n.target_type === 'journey' ? (n.data?.request_id ? `/j/${n.target_id}` : `/r/${n.target_id}`) : n.target_type === 'transport_request' ? `/r/${n.target_id}` : n.type === 'review_received' ? '/bookings' : n.type === 'follow' ? `/u/${n.actor_username}` : n.target_type === 'post' ? `/post/${n.target_id}` : n.target_type === 'listing' ? `/l/${n.target_id}` : '/');

export function Notifications() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api('/notifications') });
  useEffect(() => { if (q.data?.items.some((n: any) => !n.read_at)) { const t = setTimeout(() => api('/notifications/read', { method: 'POST' }).then(() => qc.invalidateQueries({ queryKey: ['unread'] })), 1500); return () => clearTimeout(t); } }, [q.data, qc]);
  return (
    <main className="main"><h1 className="page">Notifications</h1>
      {q.isLoading ? <State kind="loading" /> : q.data.items.length === 0 ? <State kind="empty" title="You're all caught up" text="Follows, comments and replies will show up here." />
        : <div className="card" style={{ margin: '0 16px' }}>{q.data.items.map((n: any) => <Link key={n.id} to={href(n)} className="row pad" style={{ background: n.read_at ? undefined : '#EEF4FF', borderBottom: '1px solid var(--line)' }}><div style={{ flex: 1 }}>{text(n)}</div><span className="muted sm">{ago(n.created_at)}</span></Link>)}</div>}
    </main>
  );
}
