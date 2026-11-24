import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { Avatar, Modal, State, Verified, ago, errMsg, money } from './ui';

export const VEHICLES: Record<string, string> = { car: 'Car', suv: 'SUV', pickup_truck: 'Pickup truck', cargo_van: 'Cargo van', box_truck: 'Box truck', trailer: 'Trailer', other: 'Other' };
export const CATEGORIES: Record<string, string> = { furniture: 'Furniture', appliances: 'Appliances', boxes: 'Boxes', tires: 'Tires', bikes: 'Bikes', equipment: 'Equipment', building_materials: 'Building materials', vehicle_parts: 'Vehicle parts', electronics: 'Electronics', other: 'Other' };
export const fmtDate = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00` : s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
export const fmtDateTime = (s: string) => new Date(s).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const windowText = (a: string, b: string) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);

export function CityInput({ id, label, value, onChange, placeholder, required }: { id: string; label?: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  const q = useQuery({ queryKey: ['places', value], queryFn: () => api('/places', { query: { q: value } }), enabled: value.trim().length >= 2, staleTime: 300_000 });
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <input id={id} className="input" list={`${id}-dl`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'City'} required={required} autoComplete="off" />
      <datalist id={`${id}-dl`}>{q.data?.items.map((p: any) => <option key={`${p.city}${p.province}`} value={p.city}>{p.city}, {p.province}</option>)}</datalist>
    </div>
  );
}

export function Stars({ avg, count, completed }: { avg: number | null; count: number; completed?: number }) {
  if (!count) return <span className="muted sm">{completed ? `${completed} completed move${completed === 1 ? '' : 's'}` : 'New'}</span>;
  return <span className="sm"><b style={{ color: 'var(--amber)' }}>★</b> {avg?.toFixed(1)} <span className="muted">({count}){completed ? ` · ${completed} move${completed === 1 ? '' : 's'}` : ''}</span></span>;
}

/** Schematic route preview (not a street map): projects city coordinates onto a small canvas. */
export function RouteMap({ points, height = 150 }: { points: { lat: number; lng: number; label?: string }[]; height?: number }) {
  const W = 340, H = height, pad = 26;
  const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
  const [a, b, c, d] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  const sx = (W - pad * 2) / Math.max(b - a, 0.3), sy = (H - pad * 2) / Math.max(d - c, 0.3);
  const k = Math.min(sx, sy * 1.0);
  const ox = (W - (b - a) * k) / 2, oy = (H - (d - c) * k) / 2;
  const P = points.map((p) => [ox + (p.lng - a) * k, H - (oy + (p.lat - c) * k)] as const);
  const line = P.map((p) => p.join(',')).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Route from ${points[0]?.label} to ${points[points.length - 1]?.label}`} style={{ width: '100%', borderRadius: 18, background: '#DCE8F7', display: 'block' }}>
      <g stroke="#fff" strokeWidth="2" opacity=".7" fill="none"><path d={`M0 ${H * 0.7}C${W * 0.3} ${H * 0.55} ${W * 0.6} ${H * 0.85} ${W} ${H * 0.6}`} /><path d={`M${W * 0.25} 0C${W * 0.3} ${H * 0.5} ${W * 0.2} ${H * 0.8} ${W * 0.28} ${H}`} /></g>
      <polyline points={line} fill="none" stroke="#246BFD" strokeOpacity=".25" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={line} fill="none" stroke="#246BFD" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 8" />
      {P.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === 0 || i === P.length - 1 ? 8 : 5} fill={i === 0 ? '#246BFD' : i === P.length - 1 ? '#13B9B0' : '#F5A623'} stroke="#fff" strokeWidth="2.5" />)}
      {[0, P.length - 1].map((i) => <text key={i} x={Math.min(Math.max(P[i][0], 36), W - 36)} y={P[i][1] + (P[i][1] > H - 30 ? -14 : 22)} textAnchor="middle" fontSize="12" fontWeight="700" fill="#14213D">{points[i].label}</text>)}
    </svg>
  );
}

export function RouteLine({ from, to }: { from: string; to: string }) {
  return <div className="row" style={{ fontWeight: 800, fontSize: 16, gap: 8 }}><span>{from}</span><span style={{ flex: 1, height: 2, background: 'repeating-linear-gradient(90deg,var(--blue) 0 6px,transparent 6px 11px)', position: 'relative' }}><span style={{ position: 'absolute', right: -1, top: -4, borderLeft: '8px solid var(--blue)', borderTop: '5px solid transparent', borderBottom: '5px solid transparent' }} /></span><span>{to}</span></div>;
}

export interface Match { score: number; level: string; reasons: string[]; warnings: string[]; metrics: { pickup_off_km: number; drop_off_km: number; coverage_pct: number } }
export function MatchBox({ m }: { m: Match }) {
  const tone = m.level === 'great' ? 't' : m.level === 'good' ? 'b' : 'a';
  return (
    <div style={{ background: m.level === 'possible' ? '#FEF6E4' : '#EAF8F7', borderRadius: 12, padding: '9px 11px', marginTop: 10, fontSize: 12.5, lineHeight: 1.5 }} aria-label={`Match score ${m.score}`}>
      <div className="row"><b>Why this match</b><span className="sp" /><span className={`pill ${tone}`}>{m.score}% match</span></div>
      <div style={{ height: 6, borderRadius: 4, background: 'rgba(0,0,0,.08)', margin: '6px 0', overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${m.score}%`, background: m.level === 'possible' ? 'var(--amber)' : 'var(--teal)' }} /></div>
      <ul style={{ paddingLeft: 16, color: '#0B6F69' }}>{m.reasons.slice(0, 5).map((r) => <li key={r}>{r}</li>)}</ul>
      {m.warnings.length > 0 && <ul style={{ paddingLeft: 16, color: '#8A5A05', marginTop: 4 }}>{m.warnings.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

export function JourneyCard({ j, match, to }: { j: any; match?: Match; to?: string }) {
  return (
    <Link to={to ?? `/j/${j.id}`} className="card pad" style={{ display: 'block', margin: '0 16px 12px' }}>
      <div className="row"><Avatar user={{ display_name: j.driver.display_name, avatar_url: j.driver.avatar_url }} size={42} />
        <div><div style={{ fontWeight: 700, fontSize: 14 }}>{j.business?.name ?? j.driver.display_name} {j.driver.verification_level === 'identity' && <Verified />}</div><div className="row sm muted" style={{ gap: 6 }}><Stars avg={j.driver.rating_avg} count={j.driver.rating_count} completed={j.driver.completed} /><span>· {VEHICLES[j.vehicle_type]}</span></div></div>
        <span className="sp" />{match ? <span className={`pill ${match.level === 'great' ? 't' : match.level === 'good' ? 'b' : 'a'}`}>{match.score}%</span> : j.status === 'full' ? <span className="pill a">Full</span> : null}</div>
      <div style={{ margin: '12px 0 6px' }}><RouteLine from={j.origin.city} to={j.destination.city} /></div>
      <div className="row sm muted"><span>Departs {fmtDate(j.departure_at)}</span><span className="sp" /><span>{j.arrival_at ? `Arrives ${fmtDate(j.arrival_at)} · ` : ''}{j.distance_km.toLocaleString()} km</span></div>
      {j.waypoints.length > 0 && <div className="sm muted" style={{ marginTop: 4 }}>Via {j.waypoints.map((w: any) => w.city).join(', ')}</div>}
      {match && <MatchBox m={match} />}
      <div className="row" style={{ marginTop: 12 }}><div><div style={{ fontWeight: 800, fontSize: 18 }}>{j.price_type === 'fixed' ? '' : 'From '}{money(j.price_cents)}</div><span className="muted sm">{j.price_type === 'fixed' ? 'Fixed price' : 'Negotiable'} · {j.remaining_kg} kg left</span></div><span className="sp" /><span className="btn sm">View</span></div>
    </Link>
  );
}

export function RequestCard({ r, match, to }: { r: any; match?: Match; to?: string }) {
  return (
    <Link to={to ?? `/r/${r.id}`} className="card pad" style={{ display: 'block', margin: '0 16px 12px' }}>
      <div className="row"><Avatar user={{ display_name: r.requester.display_name, avatar_url: r.requester.avatar_url }} size={38} /><div><b style={{ fontSize: 14 }}>{r.title}</b><div className="muted sm">{r.requester.display_name} · {ago(r.created_at)}</div></div><span className="sp" />
        {match ? <span className={`pill ${match.level === 'great' ? 't' : match.level === 'good' ? 'b' : 'a'}`}>{match.score}%</span> : r.status !== 'open' ? <span className="pill">{r.status}</span> : null}</div>
      <div style={{ margin: '12px 0 6px' }}><RouteLine from={r.origin.city} to={r.destination.city} /></div>
      <div className="row wrap sm"><span className="pill b">{CATEGORIES[r.item_category]}{r.quantity > 1 ? ` ×${r.quantity}` : ''}</span><span className="pill">{r.weight_kg * r.quantity} kg</span>{r.fragile && <span className="pill a">Fragile</span>}{r.needs_loading_help && <span className="pill">Needs help loading</span>}{r.visibility === 'private' && <span className="pill">Private</span>}</div>
      <div className="row sm muted" style={{ marginTop: 8 }}><span>Pickup {windowText(r.pickup_from, r.pickup_to)}</span><span className="sp" />{r.budget_cents !== null && <b style={{ color: 'var(--navy)' }}>Budget {money(r.budget_cents)}</b>}</div>
      {match && <MatchBox m={match} />}
    </Link>
  );
}

export function ServiceCard({ s, match, to }: { s: any; match?: Match; to?: string }) {
  const unit = { flat: '', hourly: '/hr', per_km: '/km' }[s.pricing_model as string];
  return (
    <Link to={to ?? `/s/${s.id}`} className="card pad" style={{ display: 'block', margin: '0 16px 12px' }}>
      <div className="row"><Avatar user={{ display_name: s.provider.display_name, avatar_url: s.provider.avatar_url }} size={42} /><div><div style={{ fontWeight: 700, fontSize: 14 }}>{s.title}</div><div className="row sm muted" style={{ gap: 6 }}>{s.business?.name ?? s.provider.display_name} · <Stars avg={s.provider.rating_avg} count={s.provider.rating_count} completed={s.provider.completed} /></div></div><span className="sp" />{match && <span className={`pill ${match.level === 'great' ? 't' : 'b'}`}>{match.score}%</span>}</div>
      <div className="row wrap sm" style={{ marginTop: 10 }}><span className="pill b">{VEHICLES[s.vehicle_type]}</span><span className="pill t">{s.area.city} · {s.service_radius_km} km{s.intercity ? ' + beyond' : ''}</span><span className="pill">up to {s.capacity_kg} kg</span>{s.helps_loading && <span className="pill">Helps load</span>}</div>
      {match && <MatchBox m={match} />}
      <div className="row" style={{ marginTop: 12 }}><div><b style={{ fontSize: 18 }}>{s.price_type === 'fixed' ? '' : 'From '}{money(s.price_cents)}{unit}</b><div className="muted sm">{s.price_type === 'fixed' ? 'Fixed price' : 'Negotiable'}</div></div><span className="sp" /><span className="btn sm">View</span></div>
    </Link>
  );
}

// ---------------------------------------------------------------------------------------------- offers
export function OfferDialog({ target, onClose }: {
  target: { kind: 'goods'; listing: any } | { kind: 'journey'; journey: any } | { kind: 'service'; service: any } | { kind: 'request'; request: any };
  onClose: () => void;
}) {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const goods = target.kind === 'goods' ? target.listing : null; const jr = target.kind === 'journey' ? target.journey : null; const sv = target.kind === 'service' ? target.service : null; const rq = target.kind === 'request' ? target.request : null;
  const asShipper = !!(jr || sv);
  const mineReq = useQuery({ queryKey: ['myopenreq'], queryFn: () => api('/transport/requests', { query: { mine: 1, limit: 50 } }), enabled: asShipper });
  const mineJ = useQuery({ queryKey: ['myjourneys'], queryFn: () => api('/transport/journeys', { query: { mine: 1, limit: 50 } }), enabled: !!rq });
  const mineS = useQuery({ queryKey: ['mysvcs'], queryFn: () => api('/transport/services', { query: { mine: 1, limit: 50 } }), enabled: !!rq });
  const openReqs = (mineReq.data?.items ?? []).filter((r: any) => r.status === 'open');
  const [sp] = useSearchParams(); const [requestId, setRequestId] = useState(''); const [carrier, setCarrier] = useState('');
  const fixed: number | null = goods ? (goods.price_type === 'fixed' ? goods.price_cents : goods.price_type === 'free' ? 0 : null) : jr ? (jr.price_type === 'fixed' ? jr.price_cents : null) : sv ? (sv.price_type === 'fixed' && sv.pricing_model === 'flat' ? sv.price_cents : null) : rq ? (rq.price_type === 'fixed' && rq.budget_cents !== null ? rq.budget_cents : null) : null;
  const ask = goods ? goods.price_cents : jr ? jr.price_cents : sv ? sv.price_cents : rq?.budget_cents ?? 0;
  const [qty, setQty] = useState(1);
  const [amount, setAmount] = useState(fixed !== null ? String((fixed * (goods ? qty : 1)) / 100) : ask ? String(Math.round((ask * 0.9 * (goods ? qty : 1)) / 100)) : '');
  const [message, setMessage] = useState(goods ? '' : ''); const [hours, setHours] = useState(48); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (asShipper && !requestId && openReqs[0]) setRequestId(openReqs.find((r: any) => r.id === sp.get('request'))?.id ?? openReqs[0].id); }, [asShipper, requestId, openReqs, sp]);
  useEffect(() => { if (fixed !== null) setAmount(String((fixed * (goods ? qty : 1)) / 100)); }, [qty]); // eslint-disable-line
  async function send() {
    setBusy(true); setErr(null);
    try {
      const body: any = goods ? { kind: 'goods', listing_id: goods.id, quantity: qty } : { kind: 'transport', request_id: rq ? rq.id : requestId, journey_id: jr?.id ?? (carrier.startsWith('j:') ? carrier.slice(2) : undefined), service_id: sv?.id ?? (carrier.startsWith('s:') ? carrier.slice(2) : undefined) };
      body.amount_cents = Math.round(parseFloat(amount || '0') * 100); body.message = message || undefined; body.expires_in_hours = hours;
      await api('/offers', { body }); qc.invalidateQueries({ queryKey: ['offers'] }); toast('Offer sent'); onClose(); nav('/offers');
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  }
  const title = goods ? `Make an offer on ${goods.title}` : jr ? `Book space: ${jr.origin.city} → ${jr.destination.city}` : sv ? `Book ${sv.title}` : `Offer to carry: ${rq.title}`;
  return (
    <Modal onClose={onClose} title={title}>
      <div className="col">
        {asShipper && (mineReq.isLoading ? <State kind="loading" /> : openReqs.length === 0
          ? <div className="card pad" style={{ background: 'var(--cloud)' }}><b>Describe what you need moved first</b><div className="muted sm" style={{ margin: '4px 0 10px' }}>Drivers need the size and weight of your item to say yes.</div><Link className="btn sm" to="/create/request" onClick={onClose}>Create a transport request</Link></div>
          : <div className="field"><label htmlFor="rq">Which shipment?</label><select id="rq" className="input" value={requestId} onChange={(e) => setRequestId(e.target.value)}>{openReqs.map((r: any) => <option key={r.id} value={r.id}>{r.title} · {r.origin.city} → {r.destination.city} · {r.weight_kg * r.quantity} kg</option>)}</select></div>)}
        {rq && <div className="field"><label htmlFor="cr">Carry it on…</label><select id="cr" className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)}><option value="">I'll arrange this separately</option>{mineJ.data?.items.filter((j: any) => j.status === 'open').map((j: any) => <option key={j.id} value={`j:${j.id}`}>Journey {j.origin.city} → {j.destination.city} ({fmtDate(j.departure_at)})</option>)}{mineS.data?.items.filter((s: any) => s.status === 'active').map((s: any) => <option key={s.id} value={`s:${s.id}`}>Service: {s.title}</option>)}</select></div>}
        {goods && goods.quantity > 1 && <div className="field"><label htmlFor="qt">Quantity (of {goods.quantity})</label><input id="qt" type="number" min={1} max={goods.quantity} className="input" value={qty} onChange={(e) => setQty(Math.min(goods.quantity, Math.max(1, +e.target.value || 1)))} /></div>}
        <div className="field"><label htmlFor="am">{fixed !== null ? 'Price (fixed)' : 'Your offer (CAD)'}</label><input id="am" className="input" inputMode="decimal" value={amount} readOnly={fixed !== null} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          <span className="muted sm">{fixed !== null ? 'This one has a fixed price, so you can accept it as-is.' : ask ? `Asking ${money(ask * (goods ? qty : 1))}. ${goods ? 'Item price only — transport is negotiated separately.' : ''}` : ''}</span></div>
        <div className="field"><label htmlFor="ms">Message (optional)</label><textarea id="ms" className="input" style={{ minHeight: 70 }} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
        <div className="field"><label htmlFor="ex">Offer expires after</label><select id="ex" className="input" value={hours} onChange={(e) => setHours(+e.target.value)}>{[[24, '24 hours'], [48, '2 days'], [72, '3 days'], [168, '7 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy || !amount || (asShipper && !requestId)} onClick={send}>{busy ? 'Sending…' : fixed !== null ? 'Send request' : 'Send offer'}</button>
        <div className="muted sm">No money changes hands on TWIQO yet — payments arrive in a later release. Agree payment directly with the other person.</div>
      </div>
    </Modal>
  );
}

const STATUS_PILL: Record<string, string> = { pending: 'b', accepted: 't', countered: '', rejected: 'r', withdrawn: '', expired: 'a' };
export function OfferCard({ o, compact, onChanged }: { o: any; compact?: boolean; onChanged?: () => void }) {
  const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); const [counter, setCounter] = useState(false); const [amt, setAmt] = useState(String(o.amount_cents / 100)); const [busy, setBusy] = useState(false);
  const done = () => { qc.invalidateQueries({ queryKey: ['offers'] }); qc.invalidateQueries({ queryKey: ['thread'] }); qc.invalidateQueries({ queryKey: ['bookings'] }); onChanged?.(); };
  const act = async (path: string, body?: unknown, ok?: string) => { setBusy(true); try { const r = await api(`/offers/${o.id}/${path}`, { method: 'POST', body: body ?? {} }); toast(ok ?? 'Done'); done(); return r; } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  const sub = o.subject; const who = o.counterparty;
  const mine = o.proposer_id === me?.id;
  const nav = useNavigate();
  return (
    <div className="card pad col" style={{ gap: 8, ...(compact ? { boxShadow: 'none', border: '1.5px solid var(--line)', maxWidth: 300 } : {}) }}>
      <div className="row"><span className="muted sm" style={{ fontWeight: 700, letterSpacing: 0.5 }}>{mine ? 'YOUR OFFER' : `OFFER FROM ${who.display_name.toUpperCase()}`}</span><span className="sp" /><span className={`pill ${STATUS_PILL[o.status]}`}>{o.status}</span></div>
      <div className="row">
        {sub.type === 'listing' && <div className="av" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--cloud)' }}>{sub.image_url && <img src={sub.image_url} alt="" />}</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{sub.type === 'listing' ? sub.title : sub.request.title}</div>
          <div className="muted sm">{sub.type === 'listing' ? `${o.quantity > 1 ? `${o.quantity} × ` : ''}asking ${money(sub.asking_cents * o.quantity)}` : `${sub.request.from} → ${sub.request.to} · ${sub.request.weight_kg * sub.request.quantity} kg${sub.journey ? ' · journey' : sub.service ? ` · ${sub.service.title}` : ''}`}</div>
        </div>
      </div>
      <div className="row"><div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.6 }}>{money(o.amount_cents)}</div><span className="sp" />{o.status === 'pending' && <span className="muted sm">expires {ago(o.expires_at) === 'now' ? 'soon' : new Date(o.expires_at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric' })}</span>}</div>
      {o.message && <div className="sm" style={{ background: 'var(--cloud)', borderRadius: 12, padding: '8px 10px' }}>“{o.message}”</div>}
      {o.can_respond && !counter && <div className="row"><button className="btn teal" style={{ flex: 1 }} disabled={busy} onClick={async () => { const r = await act('accept', {}, 'Connection confirmed'); if (r?.booking_id) nav(`/bookings/${r.booking_id}`); else if (r?.order_id) nav(`/orders/${r.order_id}`); }}>Accept</button><button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => setCounter(true)}>Counter</button><button className="btn soft" disabled={busy} aria-label="Decline" onClick={() => act('reject', {}, 'Declined')}><Icon name="x" /></button></div>}
      {o.can_respond && counter && <div className="row"><input className="input" aria-label="Counter amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} /><button className="btn" disabled={busy} onClick={async () => { await act('counter', { amount_cents: Math.round(parseFloat(amt) * 100) }, 'Counteroffer sent'); setCounter(false); }}>Send</button><button className="btn soft" onClick={() => setCounter(false)}>Cancel</button></div>}
      {o.can_withdraw && <button className="btn soft sm" disabled={busy} onClick={() => act('withdraw', {}, 'Withdrawn')}>Withdraw offer</button>}
      {o.status === 'accepted' && (o.booking_id ? <Link className="btn sm" to={`/bookings/${o.booking_id}`}>View booking</Link> : o.order_id ? <Link className="btn sm" to={`/orders/${o.order_id}`}>View order</Link> : null)}
      {!compact && <Link className="sm" style={{ color: 'var(--blue)', fontWeight: 700 }} to={sub.type === 'listing' ? `/l/${sub.id}` : `/r/${sub.request.id}`}>View {sub.type === 'listing' ? 'listing' : 'shipment'}</Link>}
    </div>
  );
}
