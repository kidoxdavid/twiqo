import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { PostCard, useRequireAuth } from '../components/cards';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { CityInput, fmtDateTime } from '../components/transport';
import { Avatar, ImageUploader, Menu, Modal, ReportDialog, State, errMsg, type Uploaded } from '../components/ui';

const cover = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 50) % 360} 70% 55%))`; };
const roleRank: Record<string, number> = { member: 1, moderator: 2, admin: 3, owner: 4 };

export function CircleCard({ c }: { c: any }) {
  return (
    <Link to={`/c/${c.slug}`} className="card" style={{ display: 'block', margin: '0 16px 12px', overflow: 'hidden' }}>
      <div style={{ height: 70, background: c.cover_url ? `center/cover url(${c.cover_url})` : cover(c.name) }} />
      <div className="pad col" style={{ gap: 6 }}>
        <div className="row"><b style={{ fontSize: 16 }}>{c.name}</b><span className="sp" />{c.viewer?.status === 'active' ? <span className="pill t">Joined</span> : c.viewer?.status === 'pending' ? <span className="pill a">Requested</span> : c.viewer?.status === 'invited' ? <span className="pill b">Invited</span> : null}</div>
        {c.description && <div className="muted sm" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{c.description}</div>}
        <div className="row wrap sm"><span className="pill">{c.member_count} member{c.member_count === 1 ? '' : 's'}</span>{c.category && <span className="pill b">{c.category}</span>}{c.location && <span className="pill">{c.location.city}</span>}<span className="pill">{c.visibility === 'private' ? 'Private' : c.join_policy === 'approval' ? 'Approval needed' : 'Open'}</span></div>
      </div>
    </Link>
  );
}

export function Circles() {
  const { me } = useAuth(); const [tab, setTab] = useState<'discover' | 'mine'>(me ? 'mine' : 'discover'); const [q, setQ] = useState(''); const [city, setCity] = useState(''); const [applied, setApplied] = useState({ q: '', city: '' });
  const list = useQuery({ queryKey: ['circles', tab, applied, me?.id], queryFn: () => api('/circles', { query: tab === 'mine' ? { mine: 1 } : { q: applied.q || undefined, city: applied.city || undefined } }) });
  const events = useQuery({ queryKey: ['events-upcoming', applied.city], queryFn: () => api('/events/upcoming', { query: { city: applied.city || undefined } }), enabled: tab === 'discover' });
  return (
    <main className="main"><div className="row" style={{ padding: '0 16px' }}><h1 className="page" style={{ padding: '6px 0 12px', flex: 1 }}>Circles</h1><Link className="btn sm" to="/create/circle"><Icon name="plus" />Start a circle</Link></div>
      <div className="tabs" role="tablist">{me && <button role="tab" aria-selected={tab === 'mine'} className={`tab ${tab === 'mine' ? 'on' : ''}`} onClick={() => setTab('mine')}>My circles</button>}<button role="tab" aria-selected={tab === 'discover'} className={`tab ${tab === 'discover' ? 'on' : ''}`} onClick={() => setTab('discover')}>Discover</button></div>
      {tab === 'discover' && <form className="card pad row wrap" style={{ margin: '0 16px 12px', alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); setApplied({ q: q.trim(), city: city.trim() }); }}>
        <div className="field" style={{ flex: 2, minWidth: 160 }}><label htmlFor="cq">Search</label><input id="cq" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Furniture, cars, small business…" /></div>
        <div style={{ flex: 1, minWidth: 130 }}><CityInput id="cc" label="Near" value={city} onChange={setCity} /></div><button className="btn">Search</button></form>}
      {list.isLoading ? <State kind="loading" /> : list.isError ? <State kind="error" text={(list.error as Error).message} /> : list.data.items.length === 0
        ? <State kind="empty" title={tab === 'mine' ? "You haven't joined any circles" : 'No circles found'} text={tab === 'mine' ? 'Join communities around what you love, or start your own.' : 'Try another search — or start the circle people are looking for.'} action={<div className="row" style={{ justifyContent: 'center' }}>{tab === 'mine' && <button className="btn" onClick={() => setTab('discover')}>Discover circles</button>}<Link className="btn ghost" to="/create/circle">Start a circle</Link></div>} />
        : list.data.items.map((c: any) => <CircleCard key={c.id} c={c} />)}
      {tab === 'discover' && events.data?.items.length > 0 && <><h2 className="sec" style={{ padding: '10px 16px 0' }}>Upcoming events</h2>{events.data.items.map((e: any) => <EventRow key={e.id} e={e} showGroup />)}</>}
    </main>
  );
}

export function CreateCircle() {
  const { me } = useAuth(); const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = useState({ name: '', description: '', category: '', city: me?.city ?? '', visibility: 'public', join_policy: 'open', who_can_post: 'members', allow_commerce: true, rules: '' });
  const [cov, setCov] = useState<Uploaded[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  return (
    <main className="main"><h1 className="page">Start a circle</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null);
        try { const c = await api('/circles', { body: { ...f, name: f.name.trim(), category: f.category || undefined, city: f.city || undefined, cover_media_id: cov[0]?.id } }); qc.invalidateQueries({ queryKey: ['circles'] }); qc.invalidateQueries({ queryKey: ['mycircles'] }); toast('Your circle is live'); nav(`/c/${c.slug}`); } catch (x) { setErr(errMsg(x)); setBusy(false); } }}>
        <div className="field"><label htmlFor="n">Name</label><input id="n" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} minLength={3} maxLength={80} required placeholder="e.g. Calgary Furniture Marketplace" /></div>
        <div className="field"><label htmlFor="d">What is it about?</label><textarea id="d" className="input" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} /></div>
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="cat">Category</label><input id="cat" className="input" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Furniture, Cars, Business…" /></div><div style={{ flex: 1, minWidth: 140 }}><CityInput id="city" label="Where?" value={f.city} onChange={(v) => set('city', v)} placeholder="Optional" /></div></div>
        <div className="field"><label>Cover photo (optional)</label><ImageUploader value={cov} onChange={setCov} max={1} /></div>
        <div className="field"><label htmlFor="v">Who can see it?</label><select id="v" className="input" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}><option value="public">Public — anyone can find and read it</option><option value="private">Private — invitation only, invisible to everyone else</option></select></div>
        {f.visibility === 'public' && <div className="field"><label htmlFor="j">How do people join?</label><select id="j" className="input" value={f.join_policy} onChange={(e) => set('join_policy', e.target.value)}><option value="open">Anyone can join</option><option value="approval">Admins approve each request</option></select></div>}
        <div className="field"><label htmlFor="w">Who can post?</label><select id="w" className="input" value={f.who_can_post} onChange={(e) => set('who_can_post', e.target.value)}><option value="members">All members</option><option value="moderators">Only moderators and admins</option></select></div>
        <label className="row"><input type="checkbox" checked={f.allow_commerce} onChange={(e) => set('allow_commerce', e.target.checked)} /> Members can share listings, journeys and services here</label>
        <div className="field"><label htmlFor="r">Rules</label><textarea id="r" className="input" value={f.rules} onChange={(e) => set('rules', e.target.value)} maxLength={3000} placeholder="Be kind. No spam. Prohibited items are not allowed." /></div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create circle'}</button>
      </form>
    </main>
  );
}

export function EventRow({ e, showGroup, onChange }: { e: any; showGroup?: boolean; onChange?: () => void }) {
  const toast = useToast(); const guard = useRequireAuth(); const qc = useQueryClient();
  const rsvp = (status?: string) => guard(async () => { try { await api(`/events/${e.id}/rsvp`, { method: status ? 'POST' : 'DELETE', body: status ? { status } : undefined }); qc.invalidateQueries({ queryKey: ['events-upcoming'] }); qc.invalidateQueries({ queryKey: ['cevents'] }); onChange?.(); } catch (x) { toast(errMsg(x), 'err'); } });
  const going = e.viewer.rsvp === 'going';
  return (
    <div className="card pad col" style={{ margin: '0 16px 10px', gap: 6 }}>
      <div className="row"><span style={{ width: 52, textAlign: 'center', background: '#E1EBFF', color: 'var(--blue)', borderRadius: 12, padding: '6px 0', fontWeight: 800, lineHeight: 1.1 }}><span className="sm" style={{ display: 'block', fontWeight: 700 }}>{new Date(e.starts_at).toLocaleDateString('en-CA', { month: 'short' })}</span>{new Date(e.starts_at).getDate()}</span>
        <div style={{ flex: 1, minWidth: 0 }}><b>{e.title}</b><div className="muted sm">{fmtDateTime(e.starts_at)}{e.venue ? ` · ${e.venue}` : ''}{e.location ? ` · ${e.location.city}` : ''}</div>{showGroup && e.group && <Link className="sm" style={{ color: 'var(--blue)', fontWeight: 700 }} to={`/c/${e.group.slug}`}>{e.group.name}</Link>}</div></div>
      {e.description && <div className="sm">{e.description}</div>}
      <div className="row"><span className="muted sm">{e.going_count} going</span><span className="sp" />{e.status === 'cancelled' ? <span className="pill r">Cancelled</span> : going ? <button className="btn sm soft" onClick={() => rsvp()}>Going ✓</button> : <><button className="btn sm" onClick={() => rsvp('going')}>I'm going</button><button className="btn sm ghost" onClick={() => rsvp('interested')}>{e.viewer.rsvp === 'interested' ? 'Interested ✓' : 'Interested'}</button></>}</div>
    </div>
  );
}

export function CirclePage() {
  const { slug } = useParams(); const { me } = useAuth(); const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const guard = useRequireAuth();
  const [tab, setTab] = useState<'posts' | 'events' | 'members' | 'about'>('posts'); const [report, setReport] = useState(false); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['circle', slug, me?.id], queryFn: () => api(`/circles/${slug}`) });
  const c = q.data; const role = c?.viewer?.status === 'active' ? c.viewer.role : null; const isMod = !!role && roleRank[role] >= 2; const isAdmin = !!role && roleRank[role] >= 3;
  const posts = useQuery({ queryKey: ['cposts', slug, me?.id], queryFn: () => api(`/circles/${slug}/posts`), enabled: !!c && (c.visibility === 'public' || !!role) && tab === 'posts' });
  const events = useQuery({ queryKey: ['cevents', slug, me?.id], queryFn: () => api(`/circles/${slug}/events`), enabled: !!c && (c.visibility === 'public' || !!role) && tab === 'events' });
  const members = useQuery({ queryKey: ['cmembers', slug], queryFn: () => api(`/circles/${slug}/members`), enabled: !!c && (c.visibility === 'public' || !!role) && tab === 'members' });
  const pending = useQuery({ queryKey: ['cpending', slug], queryFn: () => api(`/circles/${slug}/members`, { query: { status: 'pending' } }), enabled: isMod && tab === 'members' });
  const [invite, setInvite] = useState(''); const [ev, setEv] = useState({ title: '', starts: '', venue: '', description: '' }); const [edit, setEdit] = useState<any>(null);
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="Circle not found" text="It may be private or no longer exist." action={<Link className="btn" to="/circles">Browse circles</Link>} /></main>;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['circle'] }); qc.invalidateQueries({ queryKey: ['cposts'] }); qc.invalidateQueries({ queryKey: ['cmembers'] }); qc.invalidateQueries({ queryKey: ['cpending'] }); qc.invalidateQueries({ queryKey: ['circles'] }); qc.invalidateQueries({ queryKey: ['mycircles'] }); qc.invalidateQueries({ queryKey: ['feed'] }); };
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) toast(ok); refresh(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  const st = c.viewer?.status;
  return (
    <main className="main">
      <div style={{ height: 130, background: c.cover_url ? `center/cover url(${c.cover_url})` : cover(c.name) }} />
      <div className="col" style={{ padding: '14px 16px 0' }}>
        <div className="row"><h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, flex: 1 }}>{c.name}</h1>
          {me && st !== 'banned' && <Menu items={[...(st === 'active' && role !== 'owner' ? [{ label: 'Leave circle', onClick: () => act(() => api(`/circles/${slug}/leave`, { method: 'POST', body: {} }), 'You left the circle') }] : []), { label: 'Report circle', onClick: () => setReport(true) }]} />}</div>
        <div className="row wrap sm"><span className="pill">{c.member_count} member{c.member_count === 1 ? '' : 's'}</span>{c.category && <span className="pill b">{c.category}</span>}{c.location && <span className="pill">{c.location.city}, {c.location.province}</span>}<span className="pill">{c.visibility === 'private' ? 'Private' : 'Public'}</span>{role && <span className="pill t">You are {role}</span>}</div>
        {c.description && <p style={{ lineHeight: 1.5 }}>{c.description}</p>}
        {st === 'active' ? <div className="row wrap"><Link className="btn" style={{ flex: 1 }} to={`/create/post?circle=${c.id}`}><Icon name="plus" />Post in this circle</Link><Link className="btn ghost" to={`/create/clip?circle=${c.id}`}><Icon name="film" />Clip</Link></div>
          : st === 'invited' ? <button className="btn" disabled={busy} onClick={() => act(() => api(`/circles/${slug}/join`, { method: 'POST', body: {} }), 'Welcome to the circle')}>Accept invitation</button>
          : st === 'pending' ? <button className="btn soft" disabled>Request sent — waiting for approval</button>
          : <button className="btn" disabled={busy} onClick={() => guard(() => act(async () => { const r = await api(`/circles/${slug}/join`, { method: 'POST', body: {} }); toast(r.status === 'pending' ? 'Request sent' : 'Welcome to the circle'); }))}>{c.join_policy === 'approval' ? 'Request to join' : 'Join circle'}</button>}
      </div>
      <div className="tabs" role="tablist" style={{ marginTop: 14 }}>{(['posts', 'events', 'members', 'about'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{{ posts: 'Posts', events: 'Events', members: `Members${c.pending_requests ? ` (${c.pending_requests})` : ''}`, about: 'About' }[t]}</button>)}</div>

      {c.visibility === 'private' && !role && tab !== 'about' && <State kind="empty" title="Members only" text="Accept the invitation to see what's inside." />}
      {tab === 'posts' && (c.visibility === 'public' || role) && (posts.isLoading ? <State kind="loading" /> : <>
        {posts.data?.pinned.map((p: any) => <div key={p.id}><div className="sm muted" style={{ padding: '6px 16px 0' }}>📌 Pinned</div><PostCard p={p} onRemoved={refresh} />{isAdmin && <ModBar slug={slug!} p={p} pinned act={act} />}</div>)}
        {posts.data?.items.length || posts.data?.pinned.length ? posts.data.items.map((p: any) => <div key={p.id}><PostCard p={p} onRemoved={refresh} />{isMod && p.author.id !== me?.id && <ModBar slug={slug!} p={p} isAdmin={isAdmin} act={act} />}</div>)
          : <State kind="empty" title="No posts yet" text={st === 'active' ? 'Start the conversation.' : 'Join to start the conversation.'} />}</>)}

      {tab === 'events' && (c.visibility === 'public' || role) && <>
        {isMod && <form className="card pad col" style={{ margin: '0 16px 12px' }} onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`/circles/${slug}/events`, { body: { title: ev.title, starts_at: new Date(ev.starts).toISOString(), venue: ev.venue || undefined, description: ev.description } }); setEv({ title: '', starts: '', venue: '', description: '' }); qc.invalidateQueries({ queryKey: ['cevents'] }); }, 'Event created'); }}>
          <b>Create an event</b><input className="input" aria-label="Event title" placeholder="Title" value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} required minLength={3} />
          <div className="row wrap"><input className="input" style={{ flex: 1 }} type="datetime-local" aria-label="Starts" value={ev.starts} onChange={(e) => setEv({ ...ev, starts: e.target.value })} required /><input className="input" style={{ flex: 1 }} aria-label="Venue" placeholder="Venue (optional)" value={ev.venue} onChange={(e) => setEv({ ...ev, venue: e.target.value })} /></div>
          <textarea className="input" style={{ minHeight: 70 }} aria-label="Details" placeholder="Details" value={ev.description} onChange={(e) => setEv({ ...ev, description: e.target.value })} /><button className="btn" disabled={busy}>Create event</button></form>}
        {events.isLoading ? <State kind="loading" /> : events.data?.items.length ? events.data.items.map((e: any) => <div key={e.id}><EventRow e={e} onChange={() => events.refetch()} />{(isAdmin || e.host.username === me?.username) && <div style={{ padding: '0 16px 10px' }}><button className="btn sm ghost" onClick={() => confirm('Cancel this event?') && act(async () => { await api(`/events/${e.id}`, { method: 'DELETE' }); events.refetch(); }, 'Event cancelled')}>Cancel event</button></div>}</div>) : <State kind="empty" title="No upcoming events" />}</>}

      {tab === 'members' && (c.visibility === 'public' || role) && <div className="col" style={{ padding: '0 16px' }}>
        {isMod && pending.data?.items.length > 0 && <div className="card pad col"><b>Join requests</b>{pending.data.items.map((m: any) => <div key={m.id} className="row"><Avatar user={m} size={34} /><b className="sm">{m.display_name}</b><span className="sp" /><button className="btn sm teal" disabled={busy} onClick={() => act(() => api(`/circles/${slug}/requests/${m.username}/approve`, { method: 'POST', body: {} }), 'Approved')}>Approve</button><button className="btn sm soft" disabled={busy} onClick={() => act(() => api(`/circles/${slug}/requests/${m.username}/reject`, { method: 'POST', body: {} }), 'Declined')}>Decline</button></div>)}</div>}
        {isMod && <form className="row" onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`/circles/${slug}/invites`, { body: { username: invite.replace(/^@/, '') } }); setInvite(''); }, 'Invitation sent'); }}><input className="input" aria-label="Invite by username" placeholder="Invite by username" value={invite} onChange={(e) => setInvite(e.target.value)} required /><button className="btn" disabled={busy}>Invite</button></form>}
        <div className="card">{members.isLoading ? <State kind="loading" /> : members.data?.items.map((m: any) => (
          <div key={m.id} className="row pad" style={{ borderBottom: '1px solid var(--line)' }}><Link to={`/u/${m.username}`} className="row" style={{ flex: 1 }}><Avatar user={m} size={36} /><div><b className="sm">{m.display_name}</b><div className="muted sm">@{m.username}</div></div></Link>
            {m.role !== 'member' && <span className={`pill ${m.role === 'owner' ? 'a' : 'b'}`}>{m.role}</span>}
            {isAdmin && m.role !== 'owner' && roleRank[m.role] < roleRank[role!] && <select aria-label={`Role for ${m.display_name}`} className="input" style={{ width: 'auto', padding: '6px 8px' }} value={m.role} onChange={(e) => act(() => api(`/circles/${slug}/members/${m.username}/role`, { method: 'PUT', body: { role: e.target.value } }), 'Role updated')}><option value="member">Member</option><option value="moderator">Moderator</option>{role === 'owner' && <option value="admin">Admin</option>}</select>}
            {isMod && m.username !== me?.username && roleRank[m.role] < roleRank[role!] && <Menu items={[{ label: 'Remove from circle', onClick: () => act(() => api(`/circles/${slug}/members/${m.username}`, { method: 'DELETE', body: {} }), 'Removed') }, { label: 'Ban from circle', onClick: () => confirm('Ban this person?') && act(() => api(`/circles/${slug}/members/${m.username}`, { method: 'DELETE', body: { ban: true } }), 'Banned') }]} />}</div>))}</div></div>}

      {tab === 'about' && <div className="col" style={{ padding: '0 16px' }}>
        <div className="card pad col"><b>Rules</b><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{c.rules || <span className="muted">The admins haven't set rules yet.</span>}</div></div>
        <div className="card pad col sm" style={{ gap: 4 }}><div><b>Who can post:</b> {c.who_can_post === 'members' ? 'All members' : 'Moderators and admins'}</div><div><b>Joining:</b> {c.visibility === 'private' ? 'Invitation only' : c.join_policy === 'open' ? 'Open to everyone' : 'Admins approve requests'}</div><div><b>Listings and services from members:</b> {c.allow_commerce ? 'Allowed' : 'Not allowed'}</div></div>
        {isAdmin && !edit && <button className="btn ghost" onClick={() => setEdit({ name: c.name, description: c.description, rules: c.rules, who_can_post: c.who_can_post, join_policy: c.join_policy, allow_commerce: c.allow_commerce })}>Edit circle settings</button>}
        {edit && <form className="card pad col" onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`/circles/${slug}`, { method: 'PATCH', body: edit }); setEdit(null); }, 'Settings saved'); }}>
          <div className="field"><label htmlFor="en">Name</label><input id="en" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="ed">Description</label><textarea id="ed" className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          <div className="field"><label htmlFor="er">Rules</label><textarea id="er" className="input" value={edit.rules} onChange={(e) => setEdit({ ...edit, rules: e.target.value })} /></div>
          <div className="row wrap"><select aria-label="Who can post" className="input" style={{ flex: 1 }} value={edit.who_can_post} onChange={(e) => setEdit({ ...edit, who_can_post: e.target.value })}><option value="members">All members can post</option><option value="moderators">Only moderators</option></select>
            {c.visibility === 'public' && <select aria-label="Join policy" className="input" style={{ flex: 1 }} value={edit.join_policy} onChange={(e) => setEdit({ ...edit, join_policy: e.target.value })}><option value="open">Open</option><option value="approval">Approval needed</option></select>}</div>
          <label className="row"><input type="checkbox" checked={edit.allow_commerce} onChange={(e) => setEdit({ ...edit, allow_commerce: e.target.checked })} /> Members can share listings, journeys and services</label>
          <div className="row"><button className="btn" disabled={busy}>Save</button><button type="button" className="btn soft" onClick={() => setEdit(null)}>Cancel</button></div></form>}
        {role === 'owner' && <div className="card pad col"><b>Owner tools</b><TransferOwner slug={slug!} act={act} /><button className="btn ghost" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => confirm('Delete this circle for everyone? This cannot be undone.') && act(async () => { await api(`/circles/${slug}`, { method: 'DELETE' }); nav('/circles'); }, 'Circle deleted')}>Delete circle</button></div>}
      </div>}
      {report && <ReportDialog target={{ type: 'group', id: c.id }} onClose={() => setReport(false)} />}
    </main>
  );
}

function ModBar({ slug, p, pinned, isAdmin = true, act }: { slug: string; p: any; pinned?: boolean; isAdmin?: boolean; act: (fn: () => Promise<unknown>, ok?: string) => void }) {
  const [reason, setReason] = useState<string | null>(null);
  return (
    <div className="row wrap sm" style={{ padding: '2px 16px 10px', background: '#fff', gap: 8 }}><span className="muted">Moderation:</span>
      {isAdmin && <button className="btn sm soft" onClick={() => act(() => api(`/circles/${slug}/posts/${p.id}/pin`, { method: pinned ? 'DELETE' : 'POST', body: pinned ? undefined : {} }), pinned ? 'Unpinned' : 'Pinned')}>{pinned ? 'Unpin' : 'Pin'}</button>}
      <button className="btn sm soft" onClick={() => setReason('')}>Remove post</button>
      {reason !== null && <Modal onClose={() => setReason(null)} title="Remove this post"><div className="col"><textarea className="input" aria-label="Reason" placeholder="Reason (recorded for admins)" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn danger" disabled={reason.trim().length < 3} onClick={() => { act(() => api(`/circles/${slug}/posts/${p.id}`, { method: 'DELETE', body: { reason } }), 'Post removed'); setReason(null); }}>Remove post</button></div></Modal>}
    </div>
  );
}

function TransferOwner({ slug, act }: { slug: string; act: (fn: () => Promise<unknown>, ok?: string) => void }) {
  const [u, setU] = useState(''); const nav = useNavigate();
  return <form className="row" onSubmit={(e) => { e.preventDefault(); if (confirm(`Make @${u} the owner? You will become an admin.`)) act(async () => { await api(`/circles/${slug}/transfer`, { body: { username: u.replace(/^@/, '') } }); nav(`/c/${slug}`); }, 'Ownership transferred'); }}><input className="input" aria-label="New owner username" placeholder="Transfer ownership to @username" value={u} onChange={(e) => setU(e.target.value)} /><button className="btn soft">Transfer</button></form>;
}
