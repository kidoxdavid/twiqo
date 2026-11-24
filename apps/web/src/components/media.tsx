import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getAccessToken } from '../api';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { errMsg } from './ui';

export interface VideoInfo { id: string; status: string; duration_s: number | null; width: number | null; height: number | null; urls: { hls: string | null; mp4: string | null; poster: string | null } | null; error?: string }

/** Plays HLS (Bunny) through hls.js or natively on Safari, and falls back to MP4 (local provider). */
export function VideoPlayer({ video, autoPlay, muted = true, loop = true, controls = false, fit = 'cover', onRef, onPlaying }: {
  video: VideoInfo; autoPlay?: boolean; muted?: boolean; loop?: boolean; controls?: boolean; fit?: 'cover' | 'contain'; onRef?: (el: HTMLVideoElement | null) => void; onPlaying?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current; const u = video.urls; if (!el || !u) return;
    let hls: { destroy: () => void } | null = null; let cancelled = false;
    if (u.hls && el.canPlayType('application/vnd.apple.mpegurl')) el.src = u.hls;          // Safari plays HLS natively
    else if (u.hls) {                                                                      // everyone else: load hls.js only when needed
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) { if (u.mp4) el.src = u.mp4; return; }
        const h = new Hls({ maxBufferLength: 8 }); hls = h; h.loadSource(u.hls!); h.attachMedia(el);
        h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && u.mp4) { h.destroy(); el.src = u.mp4; } });
      });
    } else if (u.mp4) el.src = u.mp4;
    return () => { cancelled = true; hls?.destroy(); };
  }, [video.urls?.hls, video.urls?.mp4]);   // eslint-disable-line
  useEffect(() => { onRef?.(ref.current); return () => onRef?.(null); }, [onRef]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  if (!video.urls) return <div className="state" style={{ background: 'var(--cloud)', borderRadius: 18 }}><b>{video.status === 'ready' ? 'Video unavailable' : 'Processing video…'}</b>{video.status !== 'ready' && 'It will appear here as soon as it is ready.'}</div>;
  return <video ref={ref} poster={video.urls.poster ?? undefined} playsInline muted={muted} loop={loop} controls={controls} autoPlay={autoPlay} preload="metadata" onPlaying={onPlaying}
    style={{ width: '100%', height: '100%', objectFit: fit, background: '#0B1224', display: 'block' }} aria-label="Video" />;
}

/** Inline player for feeds: poster with a play button, plays on tap. */
export function InlineVideo({ video }: { video: VideoInfo }) {
  const [playing, setPlaying] = useState(false);
  if (!video.urls) return <div className="state" style={{ background: 'var(--cloud)', borderRadius: 18 }}><b>{video.status === 'rejected' || video.status === 'failed' ? 'Video unavailable' : 'Processing video…'}</b><span className="sm">{video.status === 'rejected' ? video.error : 'It will appear in feeds when it is ready.'}</span></div>;
  const portrait = (video.height ?? 1) > (video.width ?? 1);
  return (
    <div style={{ position: 'relative', borderRadius: 18, overflow: 'hidden', background: '#0B1224', aspectRatio: portrait ? '9/12' : '16/9', maxHeight: 560 }}>
      {playing ? <VideoPlayer video={video} autoPlay muted={false} controls fit="contain" /> : <>
        {video.urls.poster && <img src={video.urls.poster} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />}
        <button onClick={() => setPlaying(true)} aria-label="Play video" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(255,255,255,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--navy)' }}><svg width="28" height="28" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8V4z" fill="currentColor" /></svg></span></button>
        {video.duration_s != null && <span className="pill" style={{ position: 'absolute', right: 10, bottom: 10, background: 'rgba(0,0,0,.6)', color: '#fff' }}>{Math.round(video.duration_s)}s</span>}</>}
    </div>
  );
}

export function PollBox({ post }: { post: any }) {
  const qc = useQueryClient(); const toast = useToast(); const [poll, setPoll] = useState(post.poll); const [busy, setBusy] = useState(false);
  const voted = !!poll.my_vote; const show = voted || poll.closed;
  async function vote(id: string) { setBusy(true); try { setPoll((await api(`/posts/${post.id}/vote`, { body: { option_id: id } })).poll); qc.invalidateQueries({ queryKey: ['feed'] }); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }
  return (
    <div className="col" style={{ gap: 8, marginBottom: 6 }} role="group" aria-label="Poll">
      {poll.options.map((o: any) => show
        ? <div key={o.id} style={{ position: 'relative', borderRadius: 14, border: `1.5px solid ${poll.my_vote === o.id ? 'var(--blue)' : 'var(--line)'}`, overflow: 'hidden', padding: '11px 14px' }}>
          <i style={{ position: 'absolute', inset: 0, width: `${o.pct}%`, background: poll.my_vote === o.id ? '#E1EBFF' : 'var(--cloud)' }} />
          <div className="row" style={{ position: 'relative' }}><span style={{ fontWeight: poll.my_vote === o.id ? 700 : 500 }}>{o.text}{poll.my_vote === o.id && ' ✓'}</span><span className="sp" /><b>{o.pct}%</b></div></div>
        : <button key={o.id} className="btn ghost" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => vote(o.id)}>{o.text}</button>)}
      <div className="muted sm">{poll.total_votes} vote{poll.total_votes === 1 ? '' : 's'}{poll.closed ? ' · closed' : poll.closes_at ? ` · closes ${new Date(poll.closes_at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric' })}` : ''}</div>
    </div>
  );
}

type Phase = 'idle' | 'uploading' | 'processing' | 'ready' | 'rejected';
/** Upload a video from the device. Works with both providers: direct PUT (local) or resumable TUS straight to Bunny. */
export function UploadVideo({ onChange }: { onChange: (v: { id: string; phase: Phase } | null) => void }) {
  const [phase, setPhase] = useState<Phase>('idle'); const [pct, setPct] = useState(0); const [err, setErr] = useState<string | null>(null); const [info, setInfo] = useState<VideoInfo | null>(null);
  const input = useRef<HTMLInputElement>(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const set = (p: Phase, id?: string) => { setPhase(p); onChange(id ? { id, phase: p } : null); };

  async function poll(id: string) {
    for (let i = 0; i < 240 && alive.current; i++) {
      const v: VideoInfo = await api(`/videos/${id}`); setInfo(v);
      if (v.status === 'ready') return set('ready', id);
      if (['rejected', 'failed'].includes(v.status)) { setErr(v.error ?? 'We could not process that video'); onChange(null); return setPhase('rejected'); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  async function pick(file: File | undefined) {
    if (!file) return; setErr(null); setInfo(null); setPct(0);
    if (!file.type.startsWith('video/')) { setErr('Choose a video file'); return; }
    try {
      const created = await api('/videos', { body: { title: file.name.slice(0, 100), bytes: file.size } });
      setPhase('uploading'); onChange(null);
      if (created.upload.type === 'direct') {
        await new Promise<void>((resolve, reject) => {
          const x = new XMLHttpRequest(); x.open('PUT', created.upload.url); x.setRequestHeader('Authorization', `Bearer ${getAccessToken()}`); x.setRequestHeader('Content-Type', file.type || 'video/mp4');
          x.upload.onprogress = (e) => e.lengthComputable && setPct(Math.round((e.loaded / e.total) * 100));
          x.onload = () => (x.status < 300 ? resolve() : reject(new ApiError(x.status, (JSON.parse(x.responseText || '{}')?.error?.message) ?? 'Upload failed')));
          x.onerror = () => reject(new Error('Network error')); x.send(file);
        });
      } else {
        const tus = await import('tus-js-client');
        await new Promise<void>((resolve, reject) => {
          const up = new tus.Upload(file, { endpoint: created.upload.endpoint, headers: created.upload.headers, retryDelays: [0, 3000, 5000, 10000], metadata: { filetype: file.type, title: file.name },
            onProgress: (a, b) => setPct(Math.round((a / b) * 100)), onError: reject, onSuccess: () => resolve() });
          up.start();
        });
        await api(`/videos/${created.id}/uploaded`, { method: 'POST', body: {} });
      }
      setPhase('processing'); onChange({ id: created.id, phase: 'processing' }); await poll(created.id);
    } catch (e) { setErr(errMsg(e)); setPhase('rejected'); onChange(null); }
  }
  return (
    <div className="col" style={{ gap: 10 }}>
      <input ref={input} type="file" accept="video/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {phase === 'idle' || phase === 'rejected' ? <button type="button" className="btn soft" onClick={() => input.current?.click()} style={{ padding: 28, borderStyle: 'dashed' }}><Icon name="film" />Choose a video from your device</button> : null}
      {phase === 'uploading' && <div><div className="row sm"><b>Uploading…</b><span className="sp" />{pct}%</div><div style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden', marginTop: 6 }}><i style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--blue)', transition: 'width .2s' }} /></div></div>}
      {phase === 'processing' && <div className="card pad row" role="status"><span className="skel" style={{ width: 22, height: 22, borderRadius: '50%' }} /><div><b>Optimising your video…</b><div className="muted sm">You can post now. It appears in feeds as soon as it is ready.</div></div></div>}
      {phase === 'ready' && info && <div style={{ maxWidth: 220, aspectRatio: '9/16', borderRadius: 18, overflow: 'hidden' }}><VideoPlayer video={info} controls fit="contain" /></div>}
      {phase === 'ready' && <button type="button" className="btn soft sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setPhase('idle'); setInfo(null); onChange(null); }}>Choose a different video</button>}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}
