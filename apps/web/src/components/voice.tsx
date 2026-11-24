import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import { errMsg } from './ui';

const MAX_S = 120;
const fmt = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const voiceSupported = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

/** Tap the mic, speak, then send or throw away. The recording goes up as-is and the server checks and converts it, so Chrome (WebM) and Safari (MP4) both work. */
export function VoiceRecorder({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const toast = useToast(); const [state, setState] = useState<'idle' | 'recording' | 'review' | 'sending'>('idle'); const [ms, setMs] = useState(0); const [blob, setBlob] = useState<Blob | null>(null); const [preview, setPreview] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null); const chunks = useRef<Blob[]>([]); const stream = useRef<MediaStream | null>(null); const timer = useRef<number | null>(null); const t0 = useRef(0); const cancelled = useRef(false);
  const cleanup = () => { if (timer.current) window.clearInterval(timer.current); stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  useEffect(() => () => { cleanup(); if (preview) URL.revokeObjectURL(preview); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!voiceSupported()) return null;
  async function start() {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
      rec.current = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined); chunks.current = []; cancelled.current = false;
      rec.current.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      rec.current.onstop = () => { cleanup(); if (cancelled.current) { setState('idle'); return; } const b = new Blob(chunks.current, { type: rec.current?.mimeType || 'audio/webm' }); if (b.size < 800) { toast('That was too short. Hold on a little longer.', 'err'); setState('idle'); return; } setBlob(b); setPreview(URL.createObjectURL(b)); setState('review'); };
      rec.current.start(); t0.current = Date.now(); setMs(0); setState('recording');
      timer.current = window.setInterval(() => { const e = Date.now() - t0.current; setMs(e); if (e >= MAX_S * 1000) stop(); }, 200);
    } catch { cleanup(); toast('twiqo needs microphone access to record. Allow it in your browser settings and try again.', 'err'); }
  }
  function stop() { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); }
  function discard() { cancelled.current = true; if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); else setState('idle'); if (preview) URL.revokeObjectURL(preview); setPreview(null); setBlob(null); setState('idle'); }
  async function send() {
    if (!blob) return; setState('sending');
    try { const fd = new FormData(); fd.append('file', blob, blob.type.includes('mp4') ? 'voice.m4a' : 'voice.webm'); await api(`/conversations/${conversationId}/voice`, { form: fd }); if (preview) URL.revokeObjectURL(preview); setPreview(null); setBlob(null); setState('idle'); onSent(); }
    catch (e) { toast(errMsg(e), 'err'); setState('review'); }
  }
  if (state === 'idle') return <button type="button" className="btn soft" onClick={start} aria-label="Record a voice message" title="Record a voice message">🎤</button>;
  if (state === 'recording') return <div className="row" role="status" aria-live="polite" style={{ gap: 8, flex: 1 }}><span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--red-text)', animation: 'pulse 1s infinite' }} /><b>{fmt(ms)}</b><span className="muted sm">Recording… (up to {MAX_S / 60} min)</span><span className="sp" /><button type="button" className="btn sm ghost" onClick={discard}>Cancel</button><button type="button" className="btn sm" onClick={stop}>Stop</button></div>;
  return <div className="row" style={{ gap: 8, flex: 1, flexWrap: 'wrap' }}>{preview && <audio controls src={preview} style={{ height: 36, flex: 1, minWidth: 140 }} aria-label="Preview your recording" />}<button type="button" className="btn sm ghost" disabled={state === 'sending'} onClick={discard}>Delete</button><button type="button" className="btn sm" disabled={state === 'sending'} onClick={send}>{state === 'sending' ? 'Sending…' : 'Send'}</button></div>;
}

/** Plays a voice message. The link is signed and expires, so it is re-fetched with the thread rather than stored. */
export function VoiceBubble({ voice }: { voice: { url?: string; duration_ms?: number; expired?: boolean } }) {
  const a = useRef<HTMLAudioElement | null>(null); const [playing, setPlaying] = useState(false); const [pos, setPos] = useState(0); const [err, setErr] = useState(false);
  if (voice.expired || !voice.url) return <i>Voice message no longer available</i>;
  const total = voice.duration_ms ?? 0;
  return <div className="row" style={{ gap: 10, minWidth: 190 }}>
    <audio ref={a} src={voice.url} preload="none" onTimeUpdate={(e) => setPos((e.target as HTMLAudioElement).currentTime * 1000)} onEnded={() => { setPlaying(false); setPos(0); }} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} onError={() => setErr(true)} />
    <button type="button" aria-label={playing ? 'Pause voice message' : 'Play voice message'} onClick={() => { const el = a.current; if (!el) return; if (el.paused) el.play().catch(() => setErr(true)); else el.pause(); }} style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(255,255,255,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, border: '1.5px solid currentColor' }}>{playing ? '❚❚' : '▶'}</button>
    <div style={{ flex: 1 }}><div role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={Math.max(1, total)} aria-valuenow={Math.min(pos, total)} style={{ height: 5, borderRadius: 3, background: 'rgba(127,127,127,.35)', overflow: 'hidden' }}><div style={{ width: `${total ? Math.min(100, (pos / total) * 100) : 0}%`, height: '100%', background: 'currentColor' }} /></div>
      <div style={{ fontSize: 11, marginTop: 3 }}>{err ? 'Could not play. Reload the chat.' : `${fmt(playing || pos ? pos : total)}${playing || pos ? ` / ${fmt(total)}` : ''}`}</div></div></div>;
}
