import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from './Icon';
import { VideoPlayer } from './media';
import { useToast } from './Toast';
import { Avatar, Modal, ReportDialog, ago, errMsg } from './ui';

export function StoryTray() {
  const { me } = useAuth(); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['tray', me?.id], queryFn: () => api('/stories/tray'), enabled: !!me, staleTime: 30_000 });
  if (!me) return null;
  const items: any[] = q.data?.items ?? []; const mine = items.find((i) => i.is_me);
  return (
    <>
      <div className="chips" aria-label="Stories" style={{ gap: 14, paddingTop: 4 }}>
        <div style={{ textAlign: 'center', width: 64, flex: 'none' }}>
          <Link to="/create/story" aria-label="Add to your story" style={{ position: 'relative', display: 'block' }}>
            <Avatar user={{ display_name: me.display_name, username: me.username }} size={60} />
            <span style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: '50%', background: 'var(--blue)', color: '#fff', border: '2px solid var(--cloud)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" className="" /></span></Link>
          <div className="sm" style={{ marginTop: 4, fontWeight: 600 }}>Your story</div>
          {mine && <button className="sm muted" onClick={() => setOpen(mine.author.username)}>View ({mine.count})</button>}
        </div>
        {items.filter((i) => !i.is_me).map((i) => (
          <button key={i.author.id} onClick={() => setOpen(i.author.username)} style={{ textAlign: 'center', width: 64, flex: 'none' }} aria-label={`${i.author.display_name}'s story${i.all_seen ? '' : ', new'}`}>
            <span style={{ display: 'block', padding: 3, borderRadius: '50%', background: i.all_seen ? '#D5DCEC' : 'conic-gradient(var(--blue),var(--teal),var(--blue))' }}><span style={{ display: 'block', border: '3px solid var(--cloud)', borderRadius: '50%' }}><Avatar user={i.author} size={50} /></span></span>
            <div className="sm" style={{ marginTop: 4, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.author.display_name.split(' ')[0]}</div>
          </button>))}
      </div>
      {open && <StoryViewer username={open} onClose={() => { setOpen(null); q.refetch(); }} />}
    </>
  );
}

export function StoryViewer({ username, onClose }: { username: string; onClose: () => void }) {
  const { me } = useAuth(); const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['story', username], queryFn: () => api(`/stories/user/${username}`) });
  const items: any[] = q.data?.items ?? [];
  const [i, setI] = useState(0); const [paused, setPaused] = useState(false); const [progress, setProgress] = useState(0); const [viewers, setViewers] = useState<any[] | null>(null); const [report, setReport] = useState(false);
  const s = items[i]; const mine = s?.author.id === me?.id;
  const timer = useRef<number | undefined>(undefined);
  const next = useCallback(() => { setProgress(0); setI((n) => { if (n + 1 >= items.length) { onClose(); return n; } return n + 1; }); }, [items.length, onClose]);
  const prev = () => { setProgress(0); setI((n) => Math.max(0, n - 1)); };
  useEffect(() => { if (s) api(`/stories/${s.id}/view`, { method: 'POST', body: {} }).catch(() => {}); }, [s?.id]);   // eslint-disable-line
  useEffect(() => {   // photo and text stories advance after 5s; videos advance when they end
    window.clearInterval(timer.current); setProgress(0);
    if (!s || s.kind === 'video' || paused) return;
    const t0 = Date.now(); timer.current = window.setInterval(() => { const p = (Date.now() - t0) / 5000; if (p >= 1) { window.clearInterval(timer.current); next(); } else setProgress(p); }, 60);
    return () => window.clearInterval(timer.current);
  }, [s?.id, paused]);   // eslint-disable-line
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') prev(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [next, onClose]);
  if (q.isLoading) return <div className="scrim" style={{ alignItems: 'center', color: '#fff' }}>Loading…</div>;
  if (!s) return <div className="scrim" onClick={onClose} style={{ alignItems: 'center' }}><div className="card pad">No active stories. <button className="btn sm" onClick={onClose}>Close</button></div></div>;
  return (
    <div role="dialog" aria-modal="true" aria-label={`${s.author.display_name}'s story`} style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 60, display: 'flex', justifyContent: 'center' }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: 460, height: '100%', background: s.kind === 'text' ? s.bg : '#0B1224', color: '#fff', overflow: 'hidden' }}
        onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)} onPointerLeave={() => setPaused(false)}>
        {s.kind === 'photo' && <img src={s.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
        {s.kind === 'video' && <VideoPlayer video={{ id: s.id, status: 'ready', duration_s: s.video.duration_s, width: null, height: null, urls: s.video.urls }} autoPlay muted={false} loop={false} fit="contain" onPlaying={() => {}} />}
        {s.kind === 'text' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 36, textAlign: 'center', fontSize: 28, fontWeight: 800, lineHeight: 1.25, letterSpacing: -0.5, wordBreak: 'break-word' }}>{s.text}</div>}
        {s.kind === 'video' && <VideoEnd id={s.id} onEnd={next} />}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '10px 12px 24px', background: 'linear-gradient(rgba(0,0,0,.55),transparent)' }}>
          <div className="row" style={{ gap: 4 }}>{items.map((x, k) => <i key={x.id} style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.35)', overflow: 'hidden' }}><b style={{ display: 'block', height: '100%', background: '#fff', width: `${k < i ? 100 : k === i ? progress * 100 : 0}%` }} /></i>)}</div>
          <div className="row" style={{ marginTop: 10 }}><Link to={`/u/${s.author.username}`} onClick={onClose} className="row"><Avatar user={s.author} size={34} /><b className="sm">{s.author.display_name}</b></Link><span className="sm" style={{ opacity: 0.8 }}>{ago(s.created_at)}</span><span className="sp" />
            {mine ? <button aria-label="Delete story" className="iconbtn" onClick={async () => { if (confirm('Delete this story?')) { try { await api(`/stories/${s.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['story', username] }); qc.invalidateQueries({ queryKey: ['tray'] }); toast('Story deleted'); onClose(); } catch (e) { toast(errMsg(e), 'err'); } } }}><Icon name="x" /></button>
              : <button aria-label="Report story" className="iconbtn" onClick={() => setReport(true)}><Icon name="flag" /></button>}
            <button aria-label="Close" className="iconbtn" onClick={onClose}><Icon name="x" /></button></div>
        </div>
        <button aria-label="Previous" onClick={prev} style={{ position: 'absolute', left: 0, top: 90, bottom: 110, width: '32%' }} />
        <button aria-label="Next" onClick={next} style={{ position: 'absolute', right: 0, top: 90, bottom: 110, width: '32%' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '20px 16px 26px', background: 'linear-gradient(transparent,rgba(0,0,0,.6))' }} className="row">
          {s.link && <button className="btn" style={{ background: '#fff', color: 'var(--navy)' }} onClick={() => { onClose(); nav(s.link.type === 'listing' ? `/l/${s.link.id}` : `/b/${s.link.slug}`); }}><Icon name={s.link.type === 'listing' ? 'bag' : 'users'} />{s.link.type === 'listing' ? `View ${s.link.label}` : `Visit ${s.link.label}`}</button>}
          <span className="sp" />
          {mine && <button className="btn sm" style={{ background: 'rgba(255,255,255,.2)' }} onClick={async () => setViewers((await api(`/stories/${s.id}/viewers`)).items)}><Icon name="user" />{s.view_count ?? 0} views</button>}
        </div>
      </div>
      {viewers && <Modal onClose={() => setViewers(null)} title="Viewers">{viewers.length === 0 ? <div className="muted">No views yet.</div> : <div className="col">{viewers.map((v) => <div key={v.username} className="row"><Avatar user={v} size={32} /><b className="sm">{v.display_name}</b><span className="sp" /><span className="muted sm">{ago(v.viewed_at)}</span></div>)}</div>}</Modal>}
      {report && <ReportDialog target={{ type: 'story', id: s.id }} onClose={() => setReport(false)} />}
    </div>
  );
}

function VideoEnd({ onEnd }: { id: string; onEnd: () => void }) {
  useEffect(() => { const v = document.querySelector('[aria-label="Video"]') as HTMLVideoElement | null; if (!v) return; v.addEventListener('ended', onEnd); return () => v.removeEventListener('ended', onEnd); }, [onEnd]);
  return null;
}
