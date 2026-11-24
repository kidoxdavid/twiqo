import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { InlineVideo, PollBox } from './media';
import { BoostFlow } from './payments';
import { Avatar, CONDITIONS, Menu, Modal, ReportDialog, State, Verified, ago, errMsg, money } from './ui';

export function useRequireAuth() {
  const { me } = useAuth(); const nav = useNavigate(); const toast = useToast();
  return (fn: () => void | Promise<void>) => { if (!me) { toast('Sign in to do that', 'err'); nav('/login'); return; } return fn(); };
}

export function useToggle(kind: 'reactions' | 'saves', type: string, id: string, init: boolean, initCount = 0) {
  const [on, setOn] = useState(init); const [count, setCount] = useState(initCount);
  const toast = useToast(); const guard = useRequireAuth();
  const toggle = () => guard(async () => {
    const next = !on; setOn(next); setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    try { const r = await api(`/${kind}/${type}/${id}`, { method: next ? 'PUT' : 'DELETE' }); if (r?.like_count !== undefined) setCount(r.like_count); }
    catch (e) { setOn(!next); setCount((c) => Math.max(0, c + (next ? -1 : 1))); toast(errMsg(e), 'err'); }
  });
  return { on, count, toggle };
}

export async function shareLink(path: string, title: string, toast: (m: string) => void) {
  const url = `${location.origin}${path}`;
  try { if (navigator.share) { await navigator.share({ title, url }); return; } await navigator.clipboard.writeText(url); toast('Link copied'); } catch { /* user cancelled */ }
}

export function Comments({ target, onCount }: { target: { type: 'post' | 'listing'; id: string }; onCount?: (d: number) => void }) {
  const qc = useQueryClient(); const toast = useToast(); const guard = useRequireAuth(); const { me } = useAuth();
  const [body, setBody] = useState(''); const [reply, setReply] = useState<{ id: string; name: string } | null>(null); const [busy, setBusy] = useState(false);
  const key = ['comments', target.type, target.id];
  const q = useQuery({ queryKey: key, queryFn: () => api('/comments', { query: { target_type: target.type, target_id: target.id } }) });
  async function send() {
    setBusy(true);
    try { await api('/comments', { body: { target_type: target.type, target_id: target.id, parent_id: reply?.id, body } }); setBody(''); setReply(null); onCount?.(1); await qc.invalidateQueries({ queryKey: key }); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const one = (c: any, nested = false) => (
    <div key={c.id} style={{ marginLeft: nested ? 36 : 0, display: 'flex', gap: 10 }}>
      <Avatar user={c.author} size={nested ? 28 : 34} />
      <div style={{ flex: 1 }}>
        <div style={{ background: 'var(--cloud)', borderRadius: 16, padding: '8px 12px' }}>
          <Link to={`/u/${c.author.username}`} style={{ fontWeight: 700, fontSize: 13 }}>{c.author.display_name}</Link>
          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} className={c.removed ? 'muted' : ''}>{c.removed ? 'Comment removed' : c.body}</div>
        </div>
        <div className="row sm muted" style={{ padding: '2px 8px', gap: 14 }}>
          <span>{ago(c.created_at)}</span>
          {!nested && !c.removed && <button className="sm" style={{ fontWeight: 700 }} onClick={() => setReply({ id: c.id, name: c.author.display_name })}>Reply</button>}
          {me && c.author.id === me.id && !c.removed && <button className="sm" style={{ fontWeight: 700 }} onClick={async () => { try { await api(`/comments/${c.id}`, { method: 'DELETE' }); onCount?.(-1); qc.invalidateQueries({ queryKey: key }); } catch (e) { toast(errMsg(e), 'err'); } }}>Delete</button>}
        </div>
        {c.replies?.map((r: any) => one(r, true))}
      </div>
    </div>
  );
  return (
    <div className="col">
      <div className="col" style={{ minHeight: 120 }}>
        {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="error" text="We couldn't load comments." /> : q.data.items.length === 0 ? <State kind="empty" title="No comments yet" text="Be the first to say something." /> : q.data.items.map((c: any) => one(c))}
      </div>
      {reply && <div className="row sm muted">Replying to {reply.name} <button className="sm" style={{ fontWeight: 700 }} onClick={() => setReply(null)}>Cancel</button></div>}
      <div className="row">
        <input className="input" aria-label="Write a comment" placeholder="Write a comment…" value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && body.trim() && guard(send)} />
        <button className="btn" disabled={busy || !body.trim()} onClick={() => guard(send)}>Post</button>
      </div>
    </div>
  );
}

export function ListingMini({ l }: { l: any }) {
  return (
    <Link to={`/l/${l.id}`} className="attach">
      <div className="th">{l.images[0] ? <img src={l.images[0].thumb_url} alt="" loading="lazy" /> : <div className="noimg"><Icon name="bag" /></div>}</div>
      <div className="tx"><b>{l.title}</b><span className="muted sm">{money(l.price_cents, l.price_type)}{l.price_type === 'negotiable' ? ' · Negotiable' : ''} · {l.location?.city}</span></div>
      <Icon name="back" className="muted" />
    </Link>
  );
}

export function PostCard({ p, onRemoved }: { p: any; onRemoved?: () => void }) {
  const { me } = useAuth(); const toast = useToast(); const guard = useRequireAuth(); const nav = useNavigate();
  const like = useToggle('reactions', 'post', p.id, p.viewer.liked, p.counts.likes);
  const save = useToggle('saves', 'post', p.id, p.viewer.saved);
  const [comments, setComments] = useState(false); const [cc, setCc] = useState(p.counts.comments); const [report, setReport] = useState(false); const [boost, setBoost] = useState(false);
  const mine = me?.id === p.author.id;
  const name = p.business ? p.business.name : p.author.display_name;
  const g = Math.min(p.media.length, 4);
  return (
    <article className="post">
      <div className="who">
        <Link to={p.business ? `/b/${p.business.slug}` : `/u/${p.author.username}`}><Avatar user={p.author} /></Link>
        <div><b><Link to={p.business ? `/b/${p.business.slug}` : `/u/${p.author.username}`}>{name}</Link> {p.sponsored && <span className="pill" style={{ padding: '2px 8px' }}>Sponsored</span>} {(p.business?.verified || (!p.business && p.author.verification_level === 'identity')) && <Verified />}</b>
          <div className="muted sm">{ago(p.created_at)}{p.location ? ` · ${p.location.city}, ${p.location.province}` : ''}{p.visibility === 'followers' ? ' · Followers' : p.visibility === 'private' ? ' · Only me' : ''}{p.status === 'pending' ? ' · Under review' : ''}{p.group && <> · in <Link to={`/c/${p.group.slug}`} style={{ color: 'var(--blue)', fontWeight: 700 }}>{p.group.name}</Link></>}</div></div>
        <span className="sp" />
        <Menu items={[...(mine && p.visibility === 'public' && !p.group ? [{ label: 'Boost this post', onClick: () => setBoost(true) }] : []), ...(mine ? [{ label: 'Delete post', onClick: async () => { if (!confirm('Delete this post?')) return; try { await api(`/posts/${p.id}`, { method: 'DELETE' }); toast('Post deleted'); onRemoved?.(); } catch (e) { toast(errMsg(e), 'err'); } } }] : [{ label: 'Report post', onClick: () => guard(() => setReport(true)) }]),
          ...(!mine ? [{ label: `Go to ${p.author.display_name}`, onClick: () => nav(`/u/${p.author.username}`) }] : [])]} />
      </div>
      {p.body && <div className="body">{p.body}</div>}
      {p.poll && <PollBox post={p} />}
      {p.video && <InlineVideo video={p.video} />}
      {g > 0 && <div className={`gallery g${g}`}>{p.media.slice(0, 4).map((m: any) => <img key={m.id} src={g === 1 ? m.url : m.thumb_url} alt="" loading="lazy" />)}</div>}
      {p.attachment?.listing && <ListingMini l={p.attachment.listing} />}
      {p.attachment?.request && <Link to={`/r/${p.attachment.id}`} className="attach"><div className="tx"><b>{p.attachment.request.title}</b><span className="muted sm">{p.attachment.request.origin.city} → {p.attachment.request.destination.city} · needs a driver</span></div><Icon name="back" className="muted" /></Link>}
      {p.attachment?.journey && <Link to={`/j/${p.attachment.id}`} className="attach"><div className="tx"><b>{p.attachment.journey.origin.city} → {p.attachment.journey.destination.city}</b><span className="muted sm">Journey · {p.attachment.journey.remaining_kg} kg of space left</span></div><Icon name="back" className="muted" /></Link>}
      {p.attachment?.service && <Link to={`/s/${p.attachment.id}`} className="attach"><div className="tx"><b>{p.attachment.service.title}</b><span className="muted sm">Delivery service · {p.attachment.service.area.city}</span></div><Icon name="back" className="muted" /></Link>}
      {p.attachment?.type === 'listing' && !p.attachment.listing && <div className="attach muted sm">This listing is no longer available.</div>}
      <div className="actions">
        <button className={`act ${like.on ? 'on' : ''}`} onClick={like.toggle} aria-pressed={like.on} aria-label="Like"><Icon name="heart" />{like.count}</button>
        <button className="act" onClick={() => setComments(true)} aria-label="Comments"><Icon name="chat" />{cc}</button>
        <button className="act" onClick={() => shareLink(`/post/${p.id}`, 'twiqo post', toast)} aria-label="Share"><Icon name="share" />Share</button>
        <span className="sp" />
        <button className={`act ${save.on ? 'saved' : ''}`} onClick={save.toggle} aria-pressed={save.on} aria-label="Save"><Icon name="save" /></button>
      </div>
      {comments && <Modal onClose={() => setComments(false)} title="Comments"><Comments target={{ type: 'post', id: p.id }} onCount={(d) => setCc((c: number) => Math.max(0, c + d))} /></Modal>}
      {boost && <BoostFlow targetType="post" targetId={p.id} onClose={() => setBoost(false)} />}
      {report && <ReportDialog target={{ type: 'post', id: p.id }} onClose={() => setReport(false)} />}
    </article>
  );
}

export function ListingCard({ l }: { l: any }) {
  const save = useToggle('saves', 'listing', l.id, l.viewer.saved);
  return (
    <div className="pc">
      <div className="img">
        <Link to={`/l/${l.id}`} aria-label={l.title} style={{ display: 'block', height: '100%' }}>
          {l.images[0] ? <img src={l.images[0].thumb_url} alt="" loading="lazy" /> : <div className="noimg"><Icon name="bag" /></div>}
        </Link>
        {l.featured && <span className="tagover" style={{ left: 8, top: 8, bottom: 'auto', background: 'var(--amber)', color: 'var(--navy)' }}>Featured</span>}
        {l.fulfillment?.delivery && <span className="tagover">🚚 Delivery</span>}
        {l.status !== 'active' && <span className="tagover" style={{ background: 'var(--navy)', color: '#fff' }}>{l.status === 'sold' ? 'Sold' : 'Reserved'}</span>}
        <button className={`heart ${save.on ? 'on' : ''}`} onClick={save.toggle} aria-pressed={save.on} aria-label="Save listing"><Icon name="save" /></button>
      </div>
      <Link to={`/l/${l.id}`}>
        <div className="p">{money(l.price_cents, l.price_type)}{l.price_type === 'negotiable' && <small>Negotiable</small>}</div>
        <div className="t">{l.title}</div>
        <div className="m">{l.location?.city}{l.distance_km !== null && l.distance_km !== undefined ? (l.distance_km < 1 ? ' · Nearby' : ` · ${l.distance_km} km`) : ''} · {ago(l.created_at)}</div>
      </Link>
    </div>
  );
}

export function FeedListing({ l }: { l: any }) {
  const { me } = useAuth(); const guard = useRequireAuth(); const nav = useNavigate();
  const like = useToggle('reactions', 'listing', l.id, l.viewer.liked, l.counts.likes);
  const save = useToggle('saves', 'listing', l.id, l.viewer.saved);
  return (
    <article className="post">
      <div className="who">
        <Link to={`/u/${l.seller.username}`}><Avatar user={l.seller} /></Link>
        <div><b><Link to={l.business ? `/b/${l.business.slug}` : `/u/${l.seller.username}`}>{l.business?.name ?? l.seller.display_name}</Link> <span className="pill t" style={{ padding: '2px 8px' }}>For sale</span> {l.sponsored && <span className="pill" style={{ padding: '2px 8px' }}>Sponsored</span>}</b>
          <div className="muted sm">{ago(l.created_at)} · {l.location?.city}{l.distance_km != null ? (l.distance_km < 1 ? ' · Nearby' : ` · ${l.distance_km} km away`) : ''}</div></div>
      </div>
      <Link to={`/l/${l.id}`}>
        {l.images[0] && <div className="gallery g1" style={{ position: 'relative' }}><img src={l.images[0].url} alt="" loading="lazy" /><span className="tagover" style={{ left: 12, bottom: 12, fontSize: 13 }}>{money(l.price_cents, l.price_type)}{l.price_type === 'negotiable' ? ' · Negotiable' : ''}</span></div>}
        <div style={{ margin: '10px 0 2px', fontWeight: 800, fontSize: 17 }}>{l.title}</div>
        <div className="muted sm">{CONDITIONS[l.condition]}{l.fulfillment?.delivery ? ' · Delivery available' : ''}</div>
      </Link>
      <div className="actions">
        <button className={`act ${like.on ? 'on' : ''}`} onClick={like.toggle} aria-pressed={like.on} aria-label="Like"><Icon name="heart" />{like.count}</button>
        <Link className="act" to={`/l/${l.id}`}><Icon name="chat" />{l.counts.comments}</Link>
        {me?.id !== l.seller.id && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => guard(() => nav(`/messages/new?to=${l.seller.id}&listing=${l.id}`))}>Message seller</button>}
        <span className="sp" />
        <button className={`act ${save.on ? 'saved' : ''}`} onClick={save.toggle} aria-pressed={save.on} aria-label="Save"><Icon name="save" /></button>
      </div>
    </article>
  );
}
