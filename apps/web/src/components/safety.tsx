import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from './Toast';
import { Modal, ago, errMsg } from './ui';

/** One-shot position for PIN confirmations. Optional: if the person declines or it takes too long, we simply confirm without it. */
export const tryPosition = (): Promise<{ lat: number; lng: number } | null> => new Promise((res) => {
  if (!navigator.geolocation) return res(null);
  const done = setTimeout(() => res(null), 3500);
  navigator.geolocation.getCurrentPosition((p) => { clearTimeout(done); res({ lat: p.coords.latitude, lng: p.coords.longitude }); }, () => { clearTimeout(done); res(null); }, { timeout: 3000, maximumAge: 60_000 });
});
const mapsUrl = (lat: number, lng: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;

export function SafetyPanel({ booking, onChanged }: { booking: { id: string; status: string; my_role: 'shipper' | 'transporter' }; onChanged?: () => void }) {
  const toast = useToast(); const qc = useQueryClient(); const [sos, setSos] = useState(false); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const driver = booking.my_role === 'transporter'; const moving = ['pickup_confirmed', 'in_transit'].includes(booking.status); const open = !['cancelled', 'completed'].includes(booking.status);
  const shares = useQuery({ queryKey: ['shares', booking.id], queryFn: () => api(`/bookings/${booking.id}/shares`), enabled: open });
  const loc = useQuery({ queryKey: ['loc', booking.id], queryFn: () => api(`/bookings/${booking.id}/location`), refetchInterval: moving && !driver ? 20_000 : false, enabled: open });
  const watch = useRef<number | null>(null); const lastSent = useRef(0);
  // The driver's phone sends its position while this page is open and sharing is on (browsers can't track in the background).
  useEffect(() => {
    if (!driver || !moving || !loc.data?.sharing || !navigator.geolocation) return;
    watch.current = navigator.geolocation.watchPosition((p) => { if (Date.now() - lastSent.current < 15_000) return; lastSent.current = Date.now(); api(`/bookings/${booking.id}/location`, { body: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) } }).catch(() => undefined); }, () => undefined, { enableHighAccuracy: true, maximumAge: 10_000 });
    return () => { if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); };
  }, [driver, moving, loc.data?.sharing, booking.id]);
  if (!open) return null;
  async function share() { try { const r = await api(`/bookings/${booking.id}/share`, { body: {} }); qc.invalidateQueries({ queryKey: ['shares', booking.id] }); if (navigator.share) { try { await navigator.share({ title: 'Follow my delivery on twiqo', url: r.url }); return; } catch { /* cancelled */ } } await navigator.clipboard?.writeText(r.url).catch(() => undefined); toast('Link copied. Anyone with it can follow progress for 3 days.'); } catch (e) { toast(errMsg(e), 'err'); } }
  async function sendSos() { setBusy(true); try { const p = await tryPosition(); const r = await api(`/bookings/${booking.id}/sos`, { body: { ...(msg.trim() ? { message: msg.trim() } : {}), ...(p ?? {}) } }); toast(`Alert sent${r.contacts_emailed ? ` and ${r.contacts_emailed} contact${r.contacts_emailed > 1 ? 's' : ''} emailed` : ''}`); setSos(false); setMsg(''); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }
  return <div className="card pad col" aria-label="Safety">
    <h2 className="sec" style={{ margin: 0 }}>Safety</h2>
    <div className="row wrap"><button className="btn sm soft" onClick={share}>Share trip with someone</button><button className="btn sm ghost" style={{ color: 'var(--red-text)', borderColor: 'var(--red-text)' }} onClick={() => setSos(true)}>Safety alert</button></div>
    {shares.data?.items.length > 0 && <div className="col sm">{shares.data.items.map((s: any) => <div key={s.token} className="row"><span className="muted" style={{ flex: 1 }}>Link expires {ago(s.expires_at)}</span><button className="btn sm ghost" onClick={async () => { await api(`/bookings/${booking.id}/shares/${s.token}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['shares', booking.id] }); }}>Revoke</button></div>)}</div>}
    {driver && <label className="row sm" style={{ gap: 8 }}><input type="checkbox" checked={!!loc.data?.sharing} onChange={async (e) => { try { await api(`/bookings/${booking.id}/location/consent`, { method: 'PUT', body: { enabled: e.target.checked } }); qc.invalidateQueries({ queryKey: ['loc', booking.id] }); onChanged?.(); } catch (x) { toast(errMsg(x), 'err'); } }} />Share my live location with the shipper and trip links{loc.data?.sharing && moving ? ' (keep this page open)' : ''}</label>}
    {!driver && loc.data?.live && loc.data.latest && <div className="sm"><b>Driver's last location</b> · {ago(loc.data.latest.recorded_at)} ago · <a href={mapsUrl(loc.data.latest.lat, loc.data.latest.lng)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)' }}>Open map</a></div>}
    {!driver && moving && !loc.data?.sharing && <div className="muted sm">The driver hasn't turned on live location.</div>}
    <div className="muted sm">Trip links show progress only, never addresses or PINs. twiqo isn't an emergency service: <b>call 911</b> if you're in danger. <Link to="/settings/safety" style={{ color: 'var(--blue)' }}>Emergency contacts</Link></div>
    {sos && <Modal onClose={() => setSos(false)} title="Send a safety alert"><div className="col"><div className="sm"><b>If you are in danger, call 911 first.</b> This alert tells the other person and twiqo staff, shares your last known location, and emails your emergency contacts.</div>
      <div className="field"><label htmlFor="sosm">What's happening? (optional)</label><textarea id="sosm" className="input" maxLength={500} value={msg} onChange={(e) => setMsg(e.target.value)} /></div>
      <button className="btn danger" disabled={busy} onClick={sendSos}>Send alert</button><a className="btn ghost" href="tel:911">Call 911</a></div></Modal>}
  </div>;
}
