import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { UploadVideo } from '../components/media';
import { useToast } from '../components/Toast';
import { ImageUploader, errMsg, money, type Uploaded } from '../components/ui';

/** Things a clip can be tagged with so viewers can buy or book straight from the video. */
function useTaggables() {
  const { me } = useAuth();
  const l = useQuery({ queryKey: ['mine-listings', me?.username], queryFn: () => api('/listings', { query: { seller: me!.username, limit: 30 } }), enabled: !!me });
  const j = useQuery({ queryKey: ['myjourneys'], queryFn: () => api('/transport/journeys', { query: { mine: 1, limit: 30 } }), enabled: !!me });
  const s = useQuery({ queryKey: ['mysvcs'], queryFn: () => api('/transport/services', { query: { mine: 1, limit: 30 } }), enabled: !!me });
  return [
    ...(l.data?.items ?? []).map((x: any) => ({ key: `listing:${x.id}`, label: `Product · ${x.title} (${money(x.price_cents, x.price_type)})` })),
    ...(j.data?.items ?? []).filter((x: any) => x.status === 'open').map((x: any) => ({ key: `journey:${x.id}`, label: `Journey · ${x.origin.city} → ${x.destination.city}` })),
    ...(s.data?.items ?? []).filter((x: any) => x.status === 'active').map((x: any) => ({ key: `transport_service:${x.id}`, label: `Service · ${x.title}` })),
  ];
}

export function CreateClip() {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const [sp] = useSearchParams(); const tags = useTaggables();
  const circles = useQuery({ queryKey: ['mycircles'], queryFn: () => api('/circles', { query: { mine: 1, limit: 50 } }) });
  const [video, setVideo] = useState<{ id: string; phase: string } | null>(null); const [body, setBody] = useState(''); const [tag, setTag] = useState(''); const [circle, setCircle] = useState(sp.get('circle') ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const joined = (circles.data?.items ?? []).filter((c: any) => c.viewer?.status === 'active');
  return (
    <main className="main"><h1 className="page">New clip</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={async (e) => {
        e.preventDefault(); if (!video) return; setBusy(true); setErr(null); const [at, aid] = tag.split(':');
        try { await api('/posts', { body: { kind: 'video', video_id: video.id, body: body.trim() || undefined, attachment_type: at || undefined, attachment_id: aid || undefined, group_id: circle || undefined } }); qc.invalidateQueries({ queryKey: ['clips'] }); qc.invalidateQueries({ queryKey: ['feed'] }); toast(video.phase === 'ready' ? 'Your clip is live!' : 'Posted — it will appear when processing finishes'); nav('/clips'); }
        catch (x) { setErr(errMsg(x)); setBusy(false); }
      }}>
        <UploadVideo onChange={setVideo} />
        <div className="field"><label htmlFor="cap">Caption</label><textarea id="cap" className="input" maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Say something about this clip…" /></div>
        {tags.length > 0 && <div className="field"><label htmlFor="tag">Tag a product, journey or service</label><select id="tag" className="input" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">No tag</option>{tags.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select><span className="muted sm">Viewers can open it straight from the clip.</span></div>}
        {joined.length > 0 && <div className="field"><label htmlFor="cc">Post in a circle (optional)</label><select id="cc" className="input" value={circle} onChange={(e) => setCircle(e.target.value)}><option value="">My profile and feeds</option>{joined.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy || !video}>{busy ? 'Posting…' : 'Post clip'}</button>
        <div className="muted sm">Clips can be up to 90 seconds. Videos that break the community guidelines are removed.</div>
      </form>
    </main>
  );
}

const BGS = ['#246BFD', '#13B9B0', '#14213D', '#8E6CF5', '#F76B6B', '#F5A623'];
export function CreateStory() {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const tags = useTaggables().filter((t) => t.key.startsWith('listing:'));
  const [kind, setKind] = useState<'text' | 'photo' | 'video'>('text'); const [text, setText] = useState(''); const [bg, setBg] = useState(BGS[0]); const [photo, setPhoto] = useState<Uploaded[]>([]); const [video, setVideo] = useState<{ id: string; phase: string } | null>(null);
  const [link, setLink] = useState(''); const [vis, setVis] = useState('public'); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const ready = kind === 'text' ? text.trim().length > 0 : kind === 'photo' ? photo.length > 0 : !!video;
  return (
    <main className="main"><h1 className="page">New story</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await api('/stories', { body: { kind, text_body: kind === 'text' ? text.trim() : undefined, bg: kind === 'text' ? bg : undefined, media_id: kind === 'photo' ? photo[0].id : undefined, video_id: kind === 'video' ? video!.id : undefined, link_type: link ? 'listing' : undefined, link_id: link ? link.split(':')[1] : undefined, visibility: vis } }); qc.invalidateQueries({ queryKey: ['tray'] }); toast('Story posted — it disappears in 24 hours'); nav('/'); }
        catch (x) { setErr(errMsg(x)); setBusy(false); }
      }}>
        <div className="tabs" style={{ padding: 0 }} role="tablist">{(['text', 'photo', 'video'] as const).map((k) => <button type="button" key={k} role="tab" aria-selected={kind === k} className={`tab ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{{ text: 'Text', photo: 'Photo', video: 'Video' }[k]}</button>)}</div>
        {kind === 'text' && <>
          <div style={{ background: bg, color: '#fff', borderRadius: 20, minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 24, fontWeight: 800, letterSpacing: -0.4, wordBreak: 'break-word' }}>{text || 'Type your story'}</div>
          <div className="field"><label htmlFor="st">Your story</label><textarea id="st" className="input" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></div>
          <div className="row" role="radiogroup" aria-label="Background colour">{BGS.map((c) => <button type="button" key={c} role="radio" aria-checked={bg === c} aria-label={`Colour ${c}`} onClick={() => setBg(c)} style={{ width: 34, height: 34, borderRadius: '50%', background: c, border: bg === c ? '3px solid var(--navy)' : '3px solid transparent' }} />)}</div></>}
        {kind === 'photo' && <div className="field"><label>Photo</label><ImageUploader value={photo} onChange={setPhoto} max={1} /></div>}
        {kind === 'video' && <UploadVideo onChange={setVideo} />}
        {tags.length > 0 && <div className="field"><label htmlFor="lk">Link a product (optional)</label><select id="lk" className="input" value={link} onChange={(e) => setLink(e.target.value)}><option value="">No link</option>{tags.map((t) => <option key={t.key} value={t.key}>{t.label.replace('Product · ', '')}</option>)}</select></div>}
        <div className="field"><label htmlFor="sv">Who can see it?</label><select id="sv" className="input" value={vis} onChange={(e) => setVis(e.target.value)}><option value="public">Everyone</option><option value="followers">Followers only</option></select></div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy || !ready}>{busy ? 'Posting…' : 'Share story'}</button>
      </form>
    </main>
  );
}
