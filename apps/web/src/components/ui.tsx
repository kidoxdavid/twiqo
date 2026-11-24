import { t, numberLocale } from '../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Icon } from './Icon';
import { useToast } from './Toast';

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

export function Avatar({ user, size = 40 }: { user: { display_name?: string; username?: string; avatar_url?: string | null }; size?: number }) {
  const initial = (user.display_name || user.username || '?').trim()[0]?.toUpperCase();
  return <div className="av" style={{ width: size, height: size, fontSize: size * 0.4 }}>{user.avatar_url ? <img src={user.avatar_url} alt="" loading="lazy" /> : initial}</div>;
}
export const Verified = () => <Icon name="shield" className="vf" />;

export function State({ kind, title, text, action }: { kind: 'loading' | 'empty' | 'error'; title?: string; text?: string; action?: ReactNode }) {
  if (kind === 'loading') return <div className="col" style={{ padding: 16 }} aria-busy="true"><div className="skel" style={{ height: 120 }} /><div className="skel" style={{ height: 120 }} /><div className="skel" style={{ height: 120 }} /></div>;
  return <div className="state"><b>{title ?? (kind === 'error' ? 'Something went wrong' : 'Nothing here yet')}</b>{text}{action && <div style={{ marginTop: 14 }}>{action}</div>}</div>;
}

export function Modal({ onClose, children, title }: { onClose: () => void; children: ReactNode; title?: string }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return <div className="scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}><div className="sheet" onClick={(e) => e.stopPropagation()}><div className="grab" />{title && <h2 className="sec">{title}</h2>}{children}</div></div>;
}

const REASONS: [string, string][] = [['spam', 'Spam'], ['prohibited_item', 'Prohibited item'], ['fraud', 'Scam or fraud'], ['harassment', 'Harassment'], ['nudity', 'Nudity'], ['violence', 'Violence'], ['misleading', 'Misleading'], ['other', 'Something else']];
export function ReportDialog({ target, onClose }: { target: { type: string; id: string }; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('spam'); const [details, setDetails] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose} title="Report">
      <div className="col">
        <div className="field"><label htmlFor="rr">Reason</label><select id="rr" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="rd">Details (optional)</label><textarea id="rd" className="input" maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} /></div>
        <button className="btn danger" disabled={busy} onClick={async () => { setBusy(true); try { await api('/reports', { body: { target_type: target.type, target_id: target.id, reason, details: details || undefined } }); toast('Thanks — our team will review this.'); onClose(); } catch (e) { toast(errMsg(e), 'err'); setBusy(false); } }}>Send report</button>
      </div>
    </Modal>
  );
}

export function Menu({ items }: { items: { label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  return <div ref={ref} style={{ position: 'relative' }}><button className="iconbtn" aria-label="More options" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" /></button>{open && <div className="menu">{items.map((i) => <button key={i.label} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>)}</div>}</div>;
}

export interface Uploaded { id: string; url: string; thumb_url: string }
export function ImageUploader({ value, onChange, max = 10 }: { value: Uploaded[]; onChange: (v: Uploaded[]) => void; max?: number }) {
  const toast = useToast(); const [busy, setBusy] = useState(false); const input = useRef<HTMLInputElement>(null);
  async function pick(files: FileList | null) {
    if (!files) return; setBusy(true);
    const added: Uploaded[] = [];
    for (const f of Array.from(files).slice(0, max - value.length)) {
      try { const fd = new FormData(); fd.append('file', f); added.push(await api('/media', { form: fd })); } catch (e) { toast(errMsg(e), 'err'); }
    }
    onChange([...value, ...added]); setBusy(false); if (input.current) input.current.value = '';
  }
  return (
    <div className="upl">
      {value.map((m) => <div className="tile" key={m.id}><img src={m.thumb_url} alt="" /><button type="button" aria-label="Remove photo" onClick={() => onChange(value.filter((x) => x.id !== m.id))}>✕</button></div>)}
      {value.length < max && <button type="button" className="tile" onClick={() => input.current?.click()} disabled={busy} aria-label="Add photos">{busy ? '…' : <Icon name="camera" />}</button>}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={(e) => pick(e.target.files)} />
    </div>
  );
}

export const money = (cents: number, type?: string) => (type === 'free' || cents === 0 ? t('common.free') : new Intl.NumberFormat(numberLocale(), { style: 'currency', currency: 'CAD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100));
/** Plain currency amount: zero is "$0", never "Free" (use `money` for prices). */
export const cash = (cents: number) => new Intl.NumberFormat(numberLocale(), { style: 'currency', currency: 'CAD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return t('common.now'); if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}
export const CONDITIONS: Record<string, string> = { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair', for_parts: 'For parts' };
export const UserLink = ({ u, children }: { u: { username: string }; children: ReactNode }) => <Link to={`/u/${u.username}`}>{children}</Link>;
