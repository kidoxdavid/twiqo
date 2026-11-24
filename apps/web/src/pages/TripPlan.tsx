import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { RequestCard } from '../components/transport';
import { State, cash, errMsg, money } from '../components/ui';

const when = (iso: string) => new Date(iso).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The driver's plan for one trip: every shipment on the vehicle, in the order to do them, plus what else could ride along. */
export function TripPlanPage() {
  const { id } = useParams(); const nav = useNavigate();
  const m = useQuery({ queryKey: ['manifest', id], queryFn: () => api(`/transport/journeys/${id}/manifest`), refetchInterval: 30_000 });
  const canAdd = !!m.data && ['open', 'full'].includes(m.data.journey.status);
  const c = useQuery({ queryKey: ['consolidation', id], queryFn: () => api(`/transport/journeys/${id}/consolidation`), enabled: canAdd });
  if (m.isLoading) return <main className="main"><State kind="loading" /></main>; if (m.isError) return <main className="main"><State kind="empty" title="Trip not found" action={<Link className="btn" to="/move">Back</Link>} /></main>;
  const d = m.data; const s = d.summary;
  return <main className="main"><div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(`/j/${id}`)} aria-label="Back to the journey"><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>Trip plan</h1></div>
    <div className="col" style={{ padding: '0 16px' }}>
      <div className="card pad col" style={{ gap: 6 }}><div className="row"><b style={{ fontSize: 17 }}>{d.journey.from} → {d.journey.to}</b><span className="sp" /><span className="pill b">{d.journey.status}</span></div><div className="muted sm">Departs {when(d.journey.departure_at)} · {d.journey.distance_km} km</div></div>
      <div className="kpis"><div className="kpi"><span>Shipments</span><b>{s.shipments}</b></div><div className="kpi"><span>Agreed</span><b>{cash(s.total_agreed_cents)}</b></div><div className="kpi"><span>Busiest load</span><b>{s.peak_kg} kg</b></div><div className="kpi"><span>Vehicle used</span><b>{s.utilisation_pct}%</b></div></div>
      {d.warnings.length > 0 && <div className="card pad col" style={{ background: '#FFF1D6', gap: 4 }} role="alert"><b>Check before you go</b>{d.warnings.map((w: string) => <div key={w} className="sm">⚠ {w}</div>)}</div>}
      {d.stops.length === 0 ? <State kind="empty" title="No shipments on this trip yet" text="When shippers book space, every pick-up and drop-off appears here in route order." /> : <>
        <h2 className="sec" style={{ margin: '4px 0 0' }}>Stops in order</h2>
        <ol className="col" style={{ listStyle: 'none', padding: 0 }}>{d.stops.map((x: any, i: number) => { const next = d.next_stop && d.next_stop.booking_id === x.booking_id && d.next_stop.type === x.type;
          return <li key={i} className="card pad col" style={{ gap: 6, background: x.done ? '#EEF2F9' : undefined, borderLeft: `4px solid ${x.type === 'pickup' ? 'var(--blue)' : 'var(--teal)'}`, ...(next ? { boxShadow: '0 0 0 3px rgba(29,95,230,.25)' } : {}) }}>
            <div className="row"><span className={`pill ${x.type === 'pickup' ? 'b' : 't'}`}>{i + 1}. {x.type === 'pickup' ? 'Pick up' : 'Drop off'}</span>{next && <span className="pill a">Next</span>}{x.done && <span className="pill t">✓ Done</span>}<span className="sp" /><span className="muted sm">{x.km_along} km · ~{when(x.eta_estimate)}</span></div>
            <div><b>{x.title}</b> <span className="muted sm">· {x.place.city}{x.place.area ? `, ${x.place.area}` : ''}</span></div>
            {x.address && <div className="sm">📍 {x.address}{x.notes ? ` (${x.notes})` : ''}{x.phone && <> · <a href={`tel:${x.phone}`}>{x.phone}</a></>}</div>}
            {!x.address && !x.done && <div className="muted sm">No address yet. The shipper can add it on their booking.</div>}
            <div className="row wrap sm muted"><span>Load after: {x.load_after_kg} kg</span>{x.off_route_km > 0 && <span>{x.off_route_km} km off your route</span>}{x.handling.fragile && <span>Fragile</span>}{x.handling.loading_help && <span>Needs help {x.type === 'pickup' ? 'loading' : 'unloading'}</span>}{x.window_warning && <span style={{ color: 'var(--amber-text)' }}>⚠ outside their dates</span>}</div>
            <Link className="btn sm soft" to={`/bookings/${x.booking_id}`}>Open booking{x.done ? '' : x.type === 'pickup' ? ' to confirm pick-up' : ' to confirm delivery'}</Link></li>; })}</ol>
        <div className="muted sm">{d.note}</div></>}
      {canAdd && <Consolidation id={id!} data={c.data} loading={c.isLoading} />}
    </div></main>;
}

function Consolidation({ id, data, loading }: { id: string; data: any; loading: boolean }) {
  const toast = useToast(); const qc = useQueryClient(); const [sel, setSel] = useState<string[] | null>(null); const [amt, setAmt] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && sel === null) { setSel(data.best_bundle?.request_ids ?? []); setAmt(Object.fromEntries(data.candidates.map((c: any) => [c.id, String(c.value / 100)]))); } }, [data]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (loading) return <State kind="loading" />; if (!data) return null;
  const chosen = data.candidates.filter((c: any) => (sel ?? []).includes(c.id)); const kg = chosen.reduce((a: number, c: any) => a + c.kg, 0); const over = kg > data.remaining.kg;
  const total = chosen.reduce((a: number, c: any) => a + Math.round((Number(amt[c.id]) || 0) * 100), 0);
  async function offer() { setBusy(true); try { await api(`/transport/journeys/${id}/offer-bundle`, { body: { items: chosen.map((c: any) => ({ request_id: c.id, amount_cents: Math.round(Number(amt[c.id]) * 100) })) } }); toast('Bundle offer sent'); qc.invalidateQueries({ queryKey: ['consolidation', id] }); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }
  return <section className="col"><h2 className="sec" style={{ margin: '8px 0 0' }}>Fill the empty space</h2>
    <div className="card pad sm">Space left: <b>{data.remaining.kg} kg</b>{data.remaining.m3 !== null && <> · <b>{data.remaining.m3} m³</b></>}.{data.best_bundle ? <> The best fit is <b>{data.best_bundle.shipments} shipments</b> ({data.best_bundle.total_kg} kg) worth about <b>{cash(data.best_bundle.total_cents)}</b> with {data.best_bundle.extra_detour_km} km of detour{data.best_bundle.includes_estimates ? ' (some amounts estimated from your price)' : ''}. It's pre-selected below.</> : ' Nothing that matches your route fits right now.'}</div>
    {data.candidates.map((c: any) => <label key={c.id} className="card pad col" style={{ gap: 6, cursor: 'pointer', ...(c.in_best_bundle ? { borderLeft: '4px solid var(--teal)' } : {}) }}>
      <div className="row"><input type="checkbox" checked={(sel ?? []).includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...(sel ?? []), c.id] : (sel ?? []).filter((x) => x !== c.id))} /><b style={{ flex: 1 }}>{c.title}</b>{c.in_best_bundle && <span className="pill t">Best fit</span>}<span className="pill b">{c.score}% match</span></div>
      <div className="muted sm">{c.request?.origin.city} → {c.request?.destination.city} · {Math.round(c.kg)} kg · {c.detour_km} km detour{c.estimated_value ? ' · no budget given' : ''}</div>
      {(sel ?? []).includes(c.id) && <div className="row" onClick={(e) => e.preventDefault()}><label htmlFor={`am${c.id}`} className="sm">Your price</label><input id={`am${c.id}`} className="input" style={{ width: 110 }} inputMode="decimal" value={amt[c.id] ?? ''} onChange={(e) => setAmt({ ...amt, [c.id]: e.target.value.replace(/[^\d.]/g, '') })} /></div>}
      {c.warnings.length > 0 && <div className="sm" style={{ color: 'var(--amber-text)' }}>⚠ {c.warnings.join(' · ')}</div>}</label>)}
    {chosen.length >= 2 && <div className="card pad col"><div className="sm">{chosen.length} shipments · {Math.ceil(kg)} kg{over && <span className="err"> — over the space left</span>} · you'd earn <b>{cash(total)}</b> before twiqo fees</div>
      <button className="btn" disabled={busy || over || chosen.some((c: any) => !(Number(amt[c.id]) > 0))} onClick={offer}>Offer to carry all {chosen.length}</button><div className="muted sm">Each shipper gets their own offer and can accept or decline separately. Nothing is booked until they accept.</div></div>}
    {chosen.length === 1 && <div className="muted sm">Select two or more to offer them as a bundle, or open a shipment to make a single offer.</div>}
    <div className="muted sm">{data.note}</div></section>;
}
void RequestCard; void money;
