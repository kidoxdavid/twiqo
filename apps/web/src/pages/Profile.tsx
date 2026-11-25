import { t } from '../i18n';
import { Icon } from '../components/Icon';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { FeedListing, ListingCard, PostCard, useRequireAuth } from '../components/cards';
import { useToast } from '../components/Toast';
import { Avatar, ImageUploader, Menu, ReportDialog, State, Verified, ago, errMsg, type Uploaded } from '../components/ui';
import { JourneyCard, ServiceCard, RequestCard, Stars } from '../components/transport';

export function Profile() {
  const { username } = useParams(); const { me, logout } = useAuth(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const guard = useRequireAuth();
  const [tab, setTab] = useState<'posts' | 'listings' | 'transport' | 'reviews'>('posts'); const [report, setReport] = useState(false);
  const p = useQuery({ queryKey: ['profile', username, me?.id], queryFn: () => api(`/users/${username}`) });
  const posts = useQuery({ queryKey: ['uposts', username, me?.id], queryFn: () => api(`/users/${username}/posts`), enabled: tab === 'posts' && p.isSuccess });
  const lists = useQuery({ queryKey: ['ulistings', username, me?.id], queryFn: () => api(`/users/${username}/listings`), enabled: tab === 'listings' && p.isSuccess });
  const biz = useQuery({ queryKey: ['mybiz'], queryFn: () => api('/me/businesses'), enabled: me?.username === username });
  const tr = useQuery({ queryKey: ['utransport', username, me?.id], queryFn: () => api(`/users/${username}/transport`), enabled: p.isSuccess });
  const rv = useQuery({ queryKey: ['ureviews', username], queryFn: () => api(`/users/${username}/reviews`), enabled: p.isSuccess });
  if (p.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (p.isError) return <main className="main"><State h1 kind="empty" title="Profile not found" text="This account doesn't exist or isn't available." action={<Link className="btn" to="/">Back home</Link>} /></main>;
  const u = p.data; const self = u.viewer?.is_self;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['profile'] }); qc.invalidateQueries({ queryKey: ['feed'] }); };
  async function follow() { await guard(async () => { try { await api(`/follows/user/${u.id}`, { method: u.viewer.following ? 'DELETE' : 'POST' }); refresh(); } catch (e) { toast(errMsg(e), 'err'); } }); }
  return (
    <main className="main">
      <div className="cover" style={u.cover_url ? { backgroundImage: `url(${u.cover_url})` } : undefined} />
      <div className="phead">
        <div style={{ border: '4px solid #fff', borderRadius: '50%', width: 92, height: 92, background: '#fff' }}><Avatar user={u} size={84} /></div>
        <div className="row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}><h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.4 }}>{u.display_name} {u.verification_level === 'identity' && <Verified />}</h1><div className="muted sm">@{u.username}{u.location ? ` · ${u.location.city}, ${u.location.province}` : ''}</div>{rv.data?.summary.count > 0 && <div style={{ marginTop: 2 }}><Stars avg={rv.data.summary.average} count={rv.data.summary.count} /></div>}</div>
          {!self && me && <Menu items={[{ label: u.viewer.blocked ? 'Unblock' : 'Block', onClick: async () => { try { await api(`/blocks/${u.id}`, { method: u.viewer.blocked ? 'DELETE' : 'POST' }); toast(u.viewer.blocked ? 'Unblocked' : 'Blocked'); refresh(); if (!u.viewer.blocked) nav('/'); } catch (e) { toast(errMsg(e), 'err'); } } }, { label: 'Report', onClick: () => setReport(true) }]} />}
        </div>
        {u.bio && <p style={{ margin: '10px 0', lineHeight: 1.5 }}>{u.bio}</p>}
        <div className="stats">
          <div className="stat"><b>{u.counts.followers ?? '—'}</b><span>Followers</span></div><div className="stat"><b>{u.counts.following}</b><span>Following</span></div>
          <div className="stat"><b>{u.counts.posts}</b><span>Posts</span></div><div className="stat"><b>{u.counts.listings}</b><span>Listings</span></div>
        </div>
        <div className="row wrap">
          {self ? <><Link className="btn ghost" style={{ flex: 1 }} to="/settings/profile">Edit profile</Link><Link className="btn soft" style={{ flex: 1 }} to="/settings">Settings</Link></>
            : <><button className={`btn ${u.viewer?.following ? 'soft' : ''}`} style={{ flex: 1 }} onClick={follow}>{u.viewer?.following ? 'Following' : 'Follow'}</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => guard(() => nav(`/messages/new?to=${u.id}`))}>Message</button></>}
        </div>
        {self && <nav className="mytiles" aria-label="My activity">
          <Link to="/offers"><Icon name="chat" />Offers</Link><Link to="/bookings"><Icon name="truck" />Moves &amp; orders</Link><Link to="/saved"><Icon name="save" />Saved</Link><Link to="/insights"><Icon name="gear" />{t('me.insights')}</Link>
        </nav>}
        {self && biz.data?.items.length > 0 && <div className="row wrap" style={{ marginTop: 10 }}>{biz.data.items.map((b: any) => <Link key={b.id} to={`/b/${b.slug}`} className="pill b">{b.name} · {b.role.replace('_', ' ')}</Link>)}</div>}
      </div>
      <div className="tabs" style={{ marginTop: 14 }}>{(['posts', 'listings', 'transport', 'reviews'] as const).map((t) => <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{{ posts: 'Posts', listings: 'Listings', transport: 'Transport', reviews: 'Reviews' }[t]}</button>)}</div>
      {tab === 'posts' ? (posts.isLoading ? <State kind="loading" /> : posts.data?.items.length ? posts.data.items.map((x: any) => <PostCard key={x.id} p={x} onRemoved={() => posts.refetch()} />) : <State kind="empty" title="No posts yet" />)
        : tab === 'listings' ? (lists.isLoading ? <State kind="loading" /> : lists.data?.items.length ? <div className="grid">{lists.data.items.map((l: any) => <ListingCard key={l.id} l={l} />)}</div> : <State kind="empty" title="No listings yet" />)
        : tab === 'transport' ? (tr.isLoading ? <State kind="loading" /> : tr.isError ? <State kind="error" /> : <>
            <div className="stats" style={{ padding: '0 16px' }}><div className="stat"><b>{tr.data.stats.rating_avg ?? '—'}</b><span>Transporter rating</span></div><div className="stat"><b>{tr.data.stats.rating_count}</b><span>Reviews</span></div>
              {tr.data.history_visible && <><div className="stat"><b>{tr.data.stats.completed_as_transporter}</b><span>Moves driven</span></div><div className="stat"><b>{tr.data.stats.cancelled_by_them}</b><span>Cancelled</span></div></>}</div>
            {!tr.data.history_visible && <div className="muted sm" style={{ padding: '0 16px 10px' }}>{self ? 'Your move history is hidden. You can show it in Edit profile.' : 'Move history is private.'}</div>}
            {tr.data.upcoming_journeys.length > 0 && <><h2 className="sec" style={{ padding: '0 16px' }}>Upcoming journeys</h2>{tr.data.upcoming_journeys.map((j: any) => <JourneyCard key={j.id} j={j} />)}</>}
            {tr.data.services.length > 0 && <><h2 className="sec" style={{ padding: '0 16px' }}>Services</h2>{tr.data.services.map((x: any) => <ServiceCard key={x.id} s={x} />)}</>}
            {!tr.data.upcoming_journeys.length && !tr.data.services.length && <State kind="empty" title="No journeys or services right now" />}</>)
        : rv.isLoading ? <State kind="loading" /> : rv.data?.items.length ? <div className="card" style={{ margin: '0 16px' }}>{rv.data.items.map((r: any) => <div key={r.id} className="pad" style={{ borderBottom: '1px solid var(--line)' }}><div className="row"><Avatar user={r.reviewer} size={32} /><b className="sm">{r.reviewer.display_name}</b><span style={{ color: 'var(--amber)' }}>{'★'.repeat(r.rating)}</span><span className="sp" /><span className="muted sm">as {r.role} · {ago(r.created_at)}</span></div>{r.comment && <div style={{ marginTop: 6 }}>{r.comment}</div>}</div>)}</div> : <State kind="empty" title="No reviews yet" text="Reviews appear after completed sales and deliveries." />}
      {report && <ReportDialog target={{ type: 'user', id: u.id }} onClose={() => setReport(false)} />}
    </main>
  );
}

export function EditProfile() {
  const { me, reload } = useAuth(); const toast = useToast(); const nav = useNavigate(); const qc = useQueryClient();
  const [f, setF] = useState({ display_name: me?.display_name ?? '', bio: me?.bio ?? '', city: me?.city ?? '' });
  const [pv, setPv] = useState({ show_followers: me?.privacy.show_followers !== false, show_location: me?.privacy.show_location !== false, show_transport_history: me?.privacy.show_transport_history === true, allow_messages: me?.privacy.allow_messages ?? 'everyone' });
  const prefs = useQuery({ queryKey: ['notifprefs'], queryFn: () => api('/me/notification-preferences') });
  const [avatar, setAvatar] = useState<Uploaded[]>([]); const [cover, setCover] = useState<Uploaded[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const blocks = useQuery({ queryKey: ['blocks'], queryFn: () => api('/me/blocks') });
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('/me/profile', { method: 'PATCH', body: { display_name: f.display_name, bio: f.bio || null, city: f.city && f.city !== me?.city ? f.city : undefined, privacy: pv, ...(avatar[0] ? { avatar_media_id: avatar[0].id } : {}), ...(cover[0] ? { cover_media_id: cover[0].id } : {}) } }); await reload(); qc.invalidateQueries({ queryKey: ['profile'] }); toast('Profile saved'); nav(`/u/${me!.username}`); }
    catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <main className="main"><h1 className="page">Edit profile</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={save}>
        <div className="row wrap"><div className="field"><label>Profile photo</label><ImageUploader value={avatar} onChange={setAvatar} max={1} /></div><div className="field"><label>Cover photo</label><ImageUploader value={cover} onChange={setCover} max={1} /></div></div>
        <div className="field"><label htmlFor="dn">Name</label><input id="dn" className="input" value={f.display_name} maxLength={60} onChange={(e) => setF({ ...f, display_name: e.target.value })} required /></div>
        <div className="field"><label htmlFor="bio">Bio</label><textarea id="bio" className="input" maxLength={500} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></div>
        <div className="field"><label htmlFor="ci">City</label><input id="ci" className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></div>
        <h2 className="sec" style={{ marginBottom: 0 }}>Privacy</h2>
        <label className="row"><input type="checkbox" checked={pv.show_followers} onChange={(e) => setPv({ ...pv, show_followers: e.target.checked })} /> Show my follower count and list</label>
        <label className="row"><input type="checkbox" checked={pv.show_location} onChange={(e) => setPv({ ...pv, show_location: e.target.checked })} /> Show my city on my profile</label>
        <label className="row"><input type="checkbox" checked={pv.show_transport_history} onChange={(e) => setPv({ ...pv, show_transport_history: e.target.checked })} /> Show my completed moves on my profile</label>
        <div className="field"><label htmlFor="am">Who can message me?</label><select id="am" className="input" value={pv.allow_messages} onChange={(e) => setPv({ ...pv, allow_messages: e.target.value })}><option value="everyone">Everyone</option><option value="followers">People who follow me</option><option value="nobody">Nobody</option></select></div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
      <h2 className="sec" style={{ padding: '18px 16px 0' }}>Notifications</h2>
      <div className="card" style={{ margin: '0 16px' }}>{prefs.data?.items.map((n: any) => <label key={n.type} className="row pad" style={{ borderBottom: '1px solid var(--line)' }}><span style={{ flex: 1 }}>{n.label}</span><input type="checkbox" aria-label={n.label} checked={n.enabled} onChange={async (e) => { await api('/me/notification-preferences', { method: 'PUT', body: { type: n.type, enabled: e.target.checked } }); prefs.refetch(); }} /></label>) ?? <div className="pad muted">Loading…</div>}</div>
      <h2 className="sec" style={{ padding: '18px 16px 0' }}>Blocked accounts</h2>
      <div className="card" style={{ margin: '0 16px' }}>{blocks.data?.items.length ? blocks.data.items.map((b: any) => <div key={b.id} className="row pad"><b>{b.display_name}</b><span className="muted sm">@{b.username}</span><span className="sp" /><button className="btn sm soft" onClick={async () => { await api(`/blocks/${b.id}`, { method: 'DELETE' }); blocks.refetch(); }}>Unblock</button></div>) : <div className="pad muted">You haven't blocked anyone.</div>}</div>
    </main>
  );
}

export function Saved() {
  const q = useQuery({ queryKey: ['saved'], queryFn: () => api('/me/saved') });
  return <main className="main"><h1 className="page">Saved</h1>{q.isLoading ? <State kind="loading" /> : q.data.items.length === 0 ? <State kind="empty" title="Nothing saved yet" text="Tap the bookmark on posts and listings to keep them here." action={<Link className="btn" to="/market">Browse the market</Link>} /> : q.data.items.map((i: any) => i.type === 'post' ? <PostCard key={i.id} p={i} /> : i.type === 'journey' ? <JourneyCard key={i.id} j={i} /> : i.type === 'transport_request' ? <RequestCard key={i.id} r={i} /> : i.type === 'transport_service' ? <ServiceCard key={i.id} s={i} /> : <FeedListing key={i.id} l={i} />)}</main>;
}

export function SearchPeople() {
  const [q, setQ] = useState('');
  const r = useQuery({ queryKey: ['people', q], queryFn: () => api('/search/people', { query: { q } }), enabled: q.trim().length > 0 });
  const { me } = useAuth(); const toast = useToast(); const guard = useRequireAuth(); const [done, setDone] = useState<Record<string, boolean>>({});
  return (
    <main className="main"><h1 className="page">Find people &amp; businesses</h1>
      <div style={{ padding: '0 16px 12px' }}><input className="input" autoFocus aria-label="Search people" placeholder="Search by name or username" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {!q.trim() ? <State kind="empty" title="Search twiqo" text="Look up neighbours, sellers, drivers and local businesses." />
        : r.isLoading ? <State kind="loading" /> : !r.data?.people.length && !r.data?.businesses.length ? <State kind="empty" title={`No one found for “${q}”`} />
        : <div className="card" style={{ margin: '0 16px' }}>
          {r.data.businesses.map((b: any) => <Link key={b.id} to={`/b/${b.slug}`} className="row pad"><Avatar user={{ display_name: b.name }} /><div><b>{b.name}</b> {b.verification_status === 'verified' && <Verified />}<div className="muted sm">Business{b.city ? ` · ${b.city}` : ''}</div></div></Link>)}
          {r.data.people.map((u: any) => <div key={u.id} className="row pad"><Link to={`/u/${u.username}`} className="row" style={{ flex: 1 }}><Avatar user={u} /><div><b>{u.display_name}</b><div className="muted sm">@{u.username} · {u.followers} followers</div></div></Link>
            {me && me.id !== u.id && <button className="btn sm" disabled={done[u.id]} onClick={() => guard(async () => { try { await api(`/follows/user/${u.id}`, { method: 'POST' }); setDone({ ...done, [u.id]: true }); } catch (e) { toast(errMsg(e), 'err'); } })}>{done[u.id] ? 'Following' : 'Follow'}</button>}</div>)}
        </div>}
    </main>
  );
}
