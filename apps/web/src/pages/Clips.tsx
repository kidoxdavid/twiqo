import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Comments, shareLink, useRequireAuth, useToggle } from '../components/cards';
import { Icon } from '../components/Icon';
import { VideoPlayer } from '../components/media';
import { useToast } from '../components/Toast';
import { Avatar, Modal, ReportDialog, State, Verified, errMsg, money } from '../components/ui';

type Tab = 'for_you' | 'following' | 'nearby';

function ProductTag({ a }: { a: any }) {
  if (!a) return null;
  const l = a.listing, j = a.journey, r = a.request, s = a.service;
  const [to, title, sub] = l ? [`/l/${l.id}`, l.title, `${money(l.price_cents, l.price_type)}${l.price_type === 'negotiable' ? ' · Negotiable' : ''} · ${l.location?.city ?? ''}`]
    : j ? [`/j/${j.id}`, `${j.origin.city} → ${j.destination.city}`, `Journey · ${j.remaining_kg} kg left · from ${money(j.price_cents)}`]
    : r ? [`/r/${r.id}`, r.title, `Needs a driver · ${r.origin.city} → ${r.destination.city}`]
    : s ? [`/s/${s.id}`, s.title, `Delivery service · from ${money(s.price_cents)}`] : [null, '', ''];
  if (!to) return null;
  return <Link to={to} style={{ background: 'rgba(255,255,255,.96)', color: 'var(--navy)', borderRadius: 18, padding: 10, display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
    {l?.images[0] ? <img src={l.images[0].thumb_url} alt="" style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'cover' }} /> : <span style={{ width: 48, height: 48, borderRadius: 12, background: '#E1EBFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--blue)' }}><Icon name={j || r || s ? 'truck' : 'bag'} /></span>}
    <div style={{ flex: 1, minWidth: 0 }}><b style={{ display: 'block', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</b><span className="sm" style={{ color: 'var(--ink2)' }}>{sub}</span></div><span className="btn sm">View</span></Link>;
}

function Clip({ p, active, muted, setMuted }: { p: any; active: boolean; muted: boolean; setMuted: (m: boolean) => void }) {
  const { me } = useAuth(); const guard = useRequireAuth(); const toast = useToast(); const qc = useQueryClient();
  const like = useToggle('reactions', 'post', p.id, p.viewer.liked, p.counts.likes); const save = useToggle('saves', 'post', p.id, p.viewer.saved);
  const [comments, setComments] = useState(false); const [cc, setCc] = useState(p.counts.comments); const [report, setReport] = useState(false); const [following, setFollowing] = useState(false);
  const [el, setEl] = useState<HTMLVideoElement | null>(null); const [paused, setPaused] = useState(false);
  const setRef = useCallback((v: HTMLVideoElement | null) => setEl(v), []);
  useEffect(() => { if (!el) return; if (active) { el.play().then(() => setPaused(false)).catch(() => setPaused(true)); } else { el.pause(); el.currentTime = 0; } }, [active, el]);
  useEffect(() => { if (!active) return; const t = setTimeout(() => { api(`/posts/${p.id}/view`, { method: 'POST', body: {} }).catch(() => {}); }, 2000); return () => clearTimeout(t); }, [active, p.id]);
  const mine = me?.id === p.author.id; const name = p.business?.name ?? p.author.display_name;
  const toggle = () => { if (!el) return; if (el.paused) { el.play(); setPaused(false); } else { el.pause(); setPaused(true); } };
  return (
    <section className="clip" aria-label={`Clip by ${name}`}>
      <div style={{ position: 'absolute', inset: 0 }} onClick={toggle}><VideoPlayer video={p.video} muted={muted} fit="cover" onRef={setRef} /></div>
      {paused && active && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}><span style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="32" height="32" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8V4z" fill="#fff" /></svg></span></div>}
      <div className="clip-shade" />
      <button className="clip-sound" onClick={() => setMuted(!muted)} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Mute'}><svg className="i" viewBox="0 0 24 24">{muted ? <path d="M4 9h4l5-4v14l-5-4H4V9zM17 9l4 6M21 9l-4 6" /> : <path d="M4 9h4l5-4v14l-5-4H4V9zM17 9a4 4 0 010 6" />}</svg>{muted ? 'Sound off' : 'Sound on'}</button>
      <div className="clip-rail">
        <div style={{ position: 'relative' }}><Link to={`/u/${p.author.username}`}><Avatar user={p.author} size={48} /></Link>
          {!mine && !following && <button aria-label={`Follow ${name}`} onClick={() => guard(async () => { try { await api(`/follows/user/${p.author.id}`, { method: 'POST' }); setFollowing(true); toast(`Following ${p.author.display_name}`); qc.invalidateQueries({ queryKey: ['clips'] }); } catch (e) { toast(errMsg(e), 'err'); } })} style={{ position: 'absolute', bottom: -9, left: 14, width: 22, height: 22, borderRadius: '50%', background: 'var(--blue)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" className="" /></button>}</div>
        <button onClick={like.toggle} aria-pressed={like.on} aria-label="Like"><Icon name="heart" fill={like.on} />{like.count}</button>
        <button onClick={() => setComments(true)} aria-label="Comments"><Icon name="chat" />{cc}</button>
        <button onClick={save.toggle} aria-pressed={save.on} aria-label="Save"><Icon name="save" fill={save.on} />Save</button>
        <button onClick={() => shareLink(`/post/${p.id}`, 'twiqo clip', toast)} aria-label="Share"><Icon name="share" />Share</button>
        {!mine && <button onClick={() => guard(() => setReport(true))} aria-label="Report"><Icon name="flag" />Report</button>}
      </div>
      <div className="clip-cap">
        <ProductTag a={p.attachment?.listing || p.attachment?.journey || p.attachment?.request || p.attachment?.service ? p.attachment : null} />
        <Link to={`/u/${p.author.username}`} style={{ fontWeight: 800, fontSize: 15 }}>@{p.author.username} {(p.business?.verified || p.author.verification_level === 'identity') && <Verified />}</Link>
        {p.group && <Link to={`/c/${p.group.slug}`} className="pill" style={{ marginLeft: 8, background: 'rgba(255,255,255,.2)', color: '#fff' }}>{p.group.name}</Link>}
        {p.body && <div style={{ fontSize: 14, marginTop: 4, lineHeight: 1.4 }}>{p.body}</div>}
        <div className="sm" style={{ opacity: 0.75, marginTop: 4 }}>{p.view_count} views</div>
      </div>
      {comments && <Modal onClose={() => setComments(false)} title="Comments"><Comments target={{ type: 'post', id: p.id }} onCount={(d) => setCc((c: number) => Math.max(0, c + d))} /></Modal>}
      {report && <ReportDialog target={{ type: 'post', id: p.id }} onClose={() => setReport(false)} />}
    </section>
  );
}

export function Clips() {
  const { me } = useAuth(); const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('for_you'); const [city, setCity] = useState(''); const [muted, setMuted] = useState(true); const [active, setActive] = useState(0);
  const q = useInfiniteQuery({
    queryKey: ['clips', tab, city, me?.id], initialPageParam: undefined as string | undefined, enabled: !(tab === 'following' && !me),
    queryFn: ({ pageParam }) => api('/clips', { query: { tab, cursor: pageParam, city: tab === 'nearby' && !me ? city : undefined, limit: 6 } }),
    getNextPageParam: (l: any) => l.next_cursor ?? undefined,
  });
  const items: any[] = q.data?.pages.flatMap((p: any) => p.items) ?? [];
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {   // the clip that is mostly on screen is the one that plays
    const r = root.current; if (!r) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting && e.intersectionRatio > 0.7) setActive(Number((e.target as HTMLElement).dataset.i)); }, { root: r, threshold: [0.7] });
    r.querySelectorAll('[data-i]').forEach((n) => io.observe(n)); return () => io.disconnect();
  }, [items.length]);
  useEffect(() => { if (active >= items.length - 2 && q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage(); }, [active, items.length]);   // eslint-disable-line
  useEffect(() => { setActive(0); root.current?.scrollTo({ top: 0 }); }, [tab]);
  return (
    <div className="clips-wrap">
      <div className="clips-top"><button aria-label="Back" onClick={() => nav(-1)}><Icon name="back" /></button>
        {(['for_you', 'following', 'nearby'] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{{ for_you: 'For You', following: 'Following', nearby: 'Nearby' }[t]}</button>)}
        <span className="sp" /><Link to="/create/clip" aria-label="Create a clip" className="iconbtn"><Icon name="plus" /></Link></div>
      {tab === 'nearby' && !me && <div style={{ position: 'absolute', top: 64, left: 16, right: 16, zIndex: 5 }}><input className="input" aria-label="City" placeholder="Enter a city, e.g. Calgary" value={city} onChange={(e) => setCity(e.target.value)} /></div>}
      <div className="clips" ref={root}>
        {q.isLoading ? <div className="clip" style={{ alignItems: 'center', justifyContent: 'center', display: 'flex' }}><span className="skel" style={{ width: 80, height: 80, borderRadius: '50%' }} /></div>
          : tab === 'following' && !me ? <div className="clip"><State kind="empty" title="Sign in to see creators you follow" action={<Link className="btn" to="/login">Sign in</Link>} /></div>
          : q.isError ? <div className="clip" style={{ color: '#fff' }}><State kind="error" title={tab === 'nearby' ? 'Where are you?' : undefined} text={(q.error as Error).message} /></div>
          : items.length === 0 ? <div className="clip" style={{ color: '#fff' }}><State kind="empty" title="No clips here yet" text="Be the first to share one." action={<Link className="btn" to="/create/clip">Create a clip</Link>} /></div>
          : items.map((p, i) => <div key={p.id} data-i={i} className="clip-slot"><Clip p={p} active={i === active} muted={muted} setMuted={setMuted} /></div>)}
      </div>
    </div>
  );
}
