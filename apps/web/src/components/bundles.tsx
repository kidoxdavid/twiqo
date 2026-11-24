import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from './Toast';
import { Modal, State, cash, errMsg, money } from './ui';

/** Split a total across shipments by weight, exactly like the server does, so the preview matches what is sent. */
export function splitByWeight(total: number, weights: number[]) {
  const w = weights.map((x) => Math.max(1, x)); const sw = w.reduce((a, x) => a + x, 0); const out = w.map((x) => Math.floor((total * x) / sw));
  out[w.indexOf(Math.max(...w))] += total - out.reduce((a, x) => a + x, 0); return out;
}

// ------------------------------------------------------------------------------------------------ shipper: book several of my shipments on this journey together
export function BookBundleDialog({ journey, onClose }: { journey: any; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient(); const nav = useNavigate();
  const mine = useQuery({ queryKey: ['my-open-requests'], queryFn: () => api('/transport/requests', { query: { mine: '1', limit: 50 } }) });
  const open = (mine.data?.items ?? []).filter((r: any) => r.status === 'open');
  const [sel, setSel] = useState<string[]>([]); const fixed = journey.price_type === 'fixed';
  const chosen = open.filter((r: any) => sel.includes(r.id)); const kg = chosen.reduce((a: number, r: any) => a + r.weight_kg * r.quantity, 0);
  const [total, setTotal] = useState(''); const totalCents = fixed ? journey.price_cents * chosen.length : Math.round(Number(total) * 100) || 0;
  const split = chosen.length ? splitByWeight(totalCents, chosen.map((r: any) => r.weight_kg * r.quantity)) : []; const over = kg > journey.remaining_kg; const [busy, setBusy] = useState(false);
  async function go() { setBusy(true); try { const r = await api(`/transport/journeys/${journey.id}/book-bundle`, { body: { request_ids: sel, total_cents: totalCents } }); toast(r.offers.every((o: any) => o.booking_id) ? 'All booked' : 'Sent. The driver can accept them together.'); qc.invalidateQueries({ queryKey: ['offers'] }); onClose(); nav('/offers'); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }
  return <Modal onClose={onClose} title="Book several shipments together"><div className="col">
    <div className="sm muted">Send your shipments to this driver as one bundle with one total price. Each shipment still becomes its own booking with its own PINs. Space left on this trip: <b>{journey.remaining_kg} kg</b>.</div>
    {mine.isLoading ? <State kind="loading" /> : open.length < 2 ? <div className="card pad sm">You need at least two open shipments. <a href="/create/request" style={{ color: 'var(--blue)' }}>Post another shipment</a>.</div>
      : <>{open.map((r: any) => <label key={r.id} className="card pad row" style={{ cursor: 'pointer' }}><input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /><div style={{ flex: 1 }}><b>{r.title}</b><div className="muted sm">{r.origin.city} → {r.destination.city} · {r.weight_kg * r.quantity} kg</div></div></label>)}
        {chosen.length >= 2 && <>
          <div className="sm">Together: <b>{Math.ceil(kg)} kg</b>{over && <span className="err"> — more than the space left</span>}</div>
          {fixed ? <div className="card pad sm">This driver charges a fixed <b>{money(journey.price_cents)}</b> per shipment: <b>{cash(totalCents)}</b> in total.</div>
            : <div className="field"><label htmlFor="bt">Total price for all {chosen.length} (CAD)</label><input id="bt" className="input" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value.replace(/[^\d.]/g, ''))} placeholder={String((journey.price_cents * chosen.length) / 100)} /></div>}
          {totalCents > 0 && <div className="muted sm">Split by weight: {chosen.map((r: any, i: number) => `${r.title} ${cash(split[i])}`).join(' · ')}</div>}
          <button className="btn" disabled={busy || over || totalCents < chosen.length} onClick={go}>Send bundle offer</button></>}</>}
  </div></Modal>;
}

// ------------------------------------------------------------------------------------------------ recipients can answer a whole bundle at once
export function BundleActions({ o, onDone }: { o: any; onDone: () => void }) {
  const toast = useToast(); const [busy, setBusy] = useState(false); const b = o.bundle; if (!b) return null;
  const run = async (path: 'accept' | 'reject' | 'withdraw', ok: (r: any) => string) => { setBusy(true); try { const r = await api(`/offers/bundle/${b.id}/${path}`, { body: {} }); toast(ok(r)); onDone(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } };
  return <div className="card pad col" style={{ gap: 6, background: '#EEF3FF', boxShadow: 'none' }}>
    <div className="sm"><b>Part of a bundle of {b.count} shipments</b> · {cash(b.total_cents)} in total{b.open < b.count ? ` · ${b.open} still open` : ''}</div>
    {b.open > 0 && o.can_respond && <div className="row wrap"><button className="btn sm teal" disabled={busy} onClick={() => run('accept', (r) => `${r.accepted.length} confirmed${r.failed.length ? `, ${r.failed.length} could not be` : ''}`)}>Accept all {b.open}</button><button className="btn sm ghost" disabled={busy} onClick={() => run('reject', (r) => `${r.rejected} declined`)}>Decline all</button></div>}
    {b.open > 0 && o.can_withdraw && <button className="btn sm soft" disabled={busy} onClick={() => run('withdraw', (r) => `${r.withdrawn} withdrawn`)}>Withdraw the whole bundle</button>}</div>;
}
