import { PriceHint } from '../components/tools';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { CATEGORIES, CityInput, VEHICLES } from '../components/transport';
import { ImageUploader, errMsg, type Uploaded } from '../components/ui';

const ymd = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
const cents = (s: string) => (s.trim() === '' ? undefined : Math.round(parseFloat(s) * 100));

function Check({ label, v, on }: { label: string; v: boolean; on: (b: boolean) => void }) {
  return <label className="chip" style={{ cursor: 'pointer', ...(v ? { background: 'var(--navy)', color: '#fff' } : {}) }}><input type="checkbox" hidden checked={v} onChange={(e) => on(e.target.checked)} />{label}</label>;
}
function useSubmit(path: string, onDone: (r: any) => string) {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [fe, setFe] = useState<Record<string, string>>({});
  return { busy, err, fe, run: async (body: unknown, ok: string) => {
    setBusy(true); setErr(null); setFe({});
    try { const r = await api(path, { body }); qc.invalidateQueries(); toast(ok); nav(onDone(r)); }
    catch (x) { if (x instanceof ApiError && x.details) setFe(Object.fromEntries(x.details.map((d) => [d.path, d.message]))); setErr(errMsg(x)); setBusy(false); }
  } };
}

export function CreateRequest() {
  const { me } = useAuth(); const [sp] = useSearchParams(); const listingId = sp.get('listing');
  const listing = useQuery({ queryKey: ['listing', listingId], queryFn: () => api(`/listings/${listingId}`), enabled: !!listingId });
  const [f, setF] = useState({ title: '', description: '', category: 'furniture', quantity: '1', weight: '', length: '', width: '', height: '', fragile: false, help: false, unhelp: false, special: '', from: me?.city ?? '', fromArea: '', to: '', toArea: '', pf: ymd(2), pt: ymd(5), by: '', budget: '', ptype: 'negotiable', vis: 'public' });
  const [vehicles, setVehicles] = useState<string[]>([]); const [media, setMedia] = useState<Uploaded[]>([]);
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  useEffect(() => { if (listing.data) setF((p) => ({ ...p, title: p.title || `Move: ${listing.data.title}`, from: listing.data.location.city ?? p.from, to: p.to || me?.city || '' })); }, [listing.data]); // eslint-disable-line
  const s = useSubmit('/transport/requests', (r) => `/r/${r.id}`);
  return (
    <main className="main"><h1 className="page">Find someone to move it</h1>
      {listing.data && <div className="attach" style={{ margin: '0 16px 12px' }}><div className="tx"><b>Moving a purchase</b><span className="muted sm">{listing.data.title}</span></div></div>}
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={(e) => { e.preventDefault(); s.run({
        title: f.title.trim(), description: f.description, item_category: f.category, quantity: Math.max(1, parseInt(f.quantity) || 1), weight_kg: num(f.weight), length_cm: num(f.length), width_cm: num(f.width), height_cm: num(f.height),
        fragile: f.fragile, special_handling: f.special || undefined, needs_loading_help: f.help, needs_unloading_help: f.unhelp,
        origin_city: f.from, pickup_area: f.fromArea || undefined, dest_city: f.to, delivery_area: f.toArea || undefined, pickup_from: f.pf, pickup_to: f.pt, deliver_by: f.by || undefined,
        budget_cents: cents(f.budget), price_type: f.ptype, preferred_vehicles: vehicles, visibility: f.vis, media_ids: media.map((m) => m.id), linked_listing_id: listingId || undefined }, 'Request posted'); }}>
        <div className="field"><label htmlFor="t">What needs moving?</label><input id="t" className="input" value={f.title} onChange={(e) => set('title', e.target.value)} required minLength={3} placeholder="e.g. Four winter tires" />{s.fe.title && <span className="err">{s.fe.title}</span>}</div>
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="c">Category</label><select id="c" className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field" style={{ width: 90 }}><label htmlFor="q">Quantity</label><input id="q" className="input" inputMode="numeric" value={f.quantity} onChange={(e) => set('quantity', e.target.value.replace(/\D/g, ''))} /></div>
          <div className="field" style={{ width: 130 }}><label htmlFor="w">Weight each (kg)</label><input id="w" className="input" inputMode="decimal" value={f.weight} onChange={(e) => set('weight', e.target.value.replace(/[^\d.]/g, ''))} required />{s.fe.weight_kg && <span className="err">{s.fe.weight_kg}</span>}</div></div>
        <div className="field"><label>Size in cm (length × width × height)</label><div className="row">{(['length', 'width', 'height'] as const).map((k) => <input key={k} className="input" aria-label={k} placeholder={k} inputMode="numeric" value={f[k]} onChange={(e) => set(k, e.target.value.replace(/\D/g, ''))} />)}</div><span className="muted sm">Optional, but drivers can only match you confidently if they know it fits.</span></div>
        <div className="row wrap"><Check label="Fragile" v={f.fragile} on={(b) => set('fragile', b)} /><Check label="Need help loading" v={f.help} on={(b) => set('help', b)} /><Check label="Need help unloading" v={f.unhelp} on={(b) => set('unhelp', b)} /></div>
        <div className="field"><label htmlFor="sp">Special handling</label><input id="sp" className="input" value={f.special} onChange={(e) => set('special', e.target.value)} placeholder="Keep upright, stairs, etc." /></div>
        <div className="row wrap"><div style={{ flex: 1, minWidth: 150 }}><CityInput id="from" label="Pickup city" value={f.from} onChange={(v) => set('from', v)} required /></div><div style={{ flex: 1, minWidth: 150 }}><CityInput id="to" label="Delivery city" value={f.to} onChange={(v) => set('to', v)} required /></div></div>
        {s.fe.origin_city && <span className="err">{s.fe.origin_city}</span>}
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="fa">Pickup area (public)</label><input id="fa" className="input" value={f.fromArea} onChange={(e) => set('fromArea', e.target.value)} placeholder="Neighbourhood, not address" /></div><div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="ta">Delivery area (public)</label><input id="ta" className="input" value={f.toArea} onChange={(e) => set('toArea', e.target.value)} placeholder="Neighbourhood, not address" /></div></div>
        <div className="muted sm">Exact addresses are shared privately with your transporter after you agree on a booking.</div>
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="pf">Pickup from</label><input id="pf" type="date" className="input" value={f.pf} min={ymd(0)} onChange={(e) => set('pf', e.target.value)} required /></div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="pt">Pickup until</label><input id="pt" type="date" className="input" value={f.pt} min={f.pf} onChange={(e) => set('pt', e.target.value)} required /></div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="by">Deliver by (optional)</label><input id="by" type="date" className="input" value={f.by} min={f.pf} onChange={(e) => set('by', e.target.value)} /></div></div>
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="bg">Budget (CAD)</label><input id="bg" className="input" inputMode="decimal" value={f.budget} onChange={(e) => set('budget', e.target.value.replace(/[^\d.]/g, ''))} placeholder="Optional" /></div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="pt2">Price</label><select id="pt2" className="input" value={f.ptype} onChange={(e) => set('ptype', e.target.value)}><option value="negotiable">Negotiable</option><option value="fixed" disabled={!f.budget}>Fixed budget</option></select></div></div>
        <div className="field"><label>Preferred vehicles (optional)</label><div className="row wrap">{Object.entries(VEHICLES).map(([k, v]) => <Check key={k} label={v} v={vehicles.includes(k)} on={(b) => setVehicles(b ? [...vehicles, k] : vehicles.filter((x) => x !== k))} />)}</div></div>
        <div className="field"><label htmlFor="d">Details</label><textarea id="d" className="input" value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="field"><label>Photos</label><ImageUploader value={media} onChange={setMedia} max={6} /></div>
        <div className="field"><label htmlFor="v">Who can see this?</label><select id="v" className="input" value={f.vis} onChange={(e) => set('vis', e.target.value)}><option value="public">Everyone — drivers can find and offer</option><option value="private">Only me — I'll pick drivers myself</option></select></div>
        {s.err && <div className="err" role="alert">{s.err}</div>}
        <button className="btn teal" disabled={s.busy}>{s.busy ? 'Posting…' : 'Post request'}</button>
      </form>
    </main>
  );
}

export function CreateJourney() {
  const { me } = useAuth();
  const [f, setF] = useState({ from: me?.city ?? '', to: '', depart: '', arrive: '', vehicle: 'pickup_truck', kg: '', m3: '', len: '', wid: '', hei: '', price: '', ptype: 'negotiable', instant: false, detour: '20', loading: false, pref: '', dpref: '', desc: '' });
  const [via, setVia] = useState<string[]>([]); const [restr, setRestr] = useState<string[]>([]);
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const s = useSubmit('/transport/journeys', (r) => `/j/${r.id}`);
  const local = (v: string) => (v ? new Date(v).toISOString() : undefined);
  return (
    <main className="main"><h1 className="page">Offer a journey</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={(e) => { e.preventDefault(); s.run({
        origin_city: f.from, dest_city: f.to, waypoints: via.filter(Boolean).map((city) => ({ city })), max_detour_km: parseInt(f.detour) || 0, departure_at: local(f.depart), arrival_at: local(f.arrive),
        vehicle_type: f.vehicle, capacity_kg: num(f.kg), capacity_m3: num(f.m3), max_length_cm: num(f.len), max_width_cm: num(f.wid), max_height_cm: num(f.hei), item_restrictions: restr,
        price_cents: cents(f.price), price_type: f.ptype, pickup_preferences: f.pref || undefined, delivery_preferences: f.dpref || undefined, helps_loading: f.loading, description: f.desc, instant_book: f.instant && f.ptype === 'fixed' }, 'Journey published'); }}>
        <div className="row wrap"><div style={{ flex: 1, minWidth: 150 }}><CityInput id="jf" label="Leaving from" value={f.from} onChange={(v) => set('from', v)} required /></div><div style={{ flex: 1, minWidth: 150 }}><CityInput id="jt" label="Going to" value={f.to} onChange={(v) => set('to', v)} required /></div></div>
        <div className="field"><label>Stops along the way (so people on your route can find you)</label>
          {via.map((v, i) => <div key={i} className="row" style={{ marginBottom: 6 }}><div style={{ flex: 1 }}><CityInput id={`via${i}`} value={v} onChange={(x) => setVia(via.map((y, k) => (k === i ? x : y)))} placeholder={`Stop ${i + 1}`} /></div><button type="button" className="btn soft sm" onClick={() => setVia(via.filter((_, k) => k !== i))} aria-label="Remove stop">✕</button></div>)}
          {via.length < 8 && <button type="button" className="btn soft sm" style={{ alignSelf: 'flex-start' }} onClick={() => setVia([...via, ''])}>+ Add a stop</button>}</div>
        {s.fe.origin_city && <span className="err">{s.fe.origin_city}</span>}
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 180 }}><label htmlFor="dp">Departure</label><input id="dp" type="datetime-local" className="input" value={f.depart} onChange={(e) => set('depart', e.target.value)} required /></div><div className="field" style={{ flex: 1, minWidth: 180 }}><label htmlFor="ar">Estimated arrival (optional)</label><input id="ar" type="datetime-local" className="input" value={f.arrive} onChange={(e) => set('arrive', e.target.value)} /></div></div>
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="vh">Vehicle</label><select id="vh" className="input" value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)}>{Object.entries(VEHICLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field" style={{ width: 130 }}><label htmlFor="kg">Capacity (kg)</label><input id="kg" className="input" inputMode="numeric" value={f.kg} onChange={(e) => set('kg', e.target.value.replace(/\D/g, ''))} required /></div>
          <div className="field" style={{ width: 130 }}><label htmlFor="m3">Volume (m³)</label><input id="m3" className="input" inputMode="decimal" value={f.m3} onChange={(e) => set('m3', e.target.value.replace(/[^\d.]/g, ''))} /></div></div>
        <div className="field"><label>Largest item that fits, cm (optional)</label><div className="row">{[['len', 'length'], ['wid', 'width'], ['hei', 'height']].map(([k, l]) => <input key={k} className="input" aria-label={l} placeholder={l} inputMode="numeric" value={(f as any)[k]} onChange={(e) => set(k, e.target.value.replace(/\D/g, ''))} />)}</div></div>
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="pr">Starting price (CAD)</label><input id="pr" className="input" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} required /></div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}><label htmlFor="pt">Price type</label><select id="pt" className="input" value={f.ptype} onChange={(e) => set('ptype', e.target.value)}><option value="negotiable">Negotiable</option><option value="fixed">Fixed</option></select></div>
          <div className="field" style={{ width: 150 }}><label htmlFor="dt">Max detour (km)</label><input id="dt" className="input" inputMode="numeric" value={f.detour} onChange={(e) => set('detour', e.target.value.replace(/\D/g, ''))} /></div></div>
        <PriceHint path="/transport/price-guidance" query={{ from: f.from, to: f.to, weight_kg: f.kg || undefined }} />
        {f.ptype === 'fixed' && <label className="row sm" style={{ alignItems: 'flex-start', gap: 8 }}><input type="checkbox" checked={f.instant} onChange={(e) => set('instant', e.target.checked)} style={{ marginTop: 3 }} /><span><b>Instant book</b> — confirm bookings automatically at your fixed price for shippers with a verified email. Available once your identity is verified or after a few successful deliveries.{s.fe.instant_book && <span className="err"> {s.fe.instant_book}</span>}</span></label>}
        <div className="field"><label>I can't carry…</label><div className="row wrap">{[['fragile', 'Fragile items'], ['appliances', 'Appliances'], ['furniture', 'Furniture'], ['tires', 'Tires'], ['bikes', 'Bikes'], ['building_materials', 'Building materials']].map(([k, l]) => <label key={k} className="chip" style={{ cursor: 'pointer', ...(restr.includes(k) ? { background: 'var(--navy)', color: '#fff' } : {}) }}><input type="checkbox" hidden checked={restr.includes(k)} onChange={(e) => setRestr(e.target.checked ? [...restr, k] : restr.filter((x) => x !== k))} />{l}</label>)}</div></div>
        <Check label="I can help load and unload" v={f.loading} on={(b) => set('loading', b)} />
        <div className="field"><label htmlFor="pp">Pickup preferences</label><input id="pp" className="input" value={f.pref} onChange={(e) => set('pref', e.target.value)} placeholder="Evenings, weekends…" /></div>
        <div className="field"><label htmlFor="dpf">Delivery preferences</label><input id="dpf" className="input" value={f.dpref} onChange={(e) => set('dpref', e.target.value)} /></div>
        <div className="field"><label htmlFor="ds">About this trip</label><textarea id="ds" className="input" value={f.desc} onChange={(e) => set('desc', e.target.value)} /></div>
        {s.err && <div className="err" role="alert">{s.err}</div>}
        <button className="btn" disabled={s.busy}>{s.busy ? 'Publishing…' : 'Publish journey'}</button>
      </form>
    </main>
  );
}

export function CreateService() {
  const { me } = useAuth();
  const [f, setF] = useState({ title: '', city: me?.city ?? '', radius: '30', intercity: false, vehicle: 'pickup_truck', kg: '', len: '', wid: '', hei: '', loading: false, model: 'flat', price: '', ptype: 'negotiable', desc: '' });
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const s = useSubmit('/transport/services', (r) => `/s/${r.id}`);
  return (
    <main className="main"><h1 className="page">Offer a delivery service</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={(e) => { e.preventDefault(); s.run({ title: f.title.trim(), description: f.desc, vehicle_type: f.vehicle, service_city: f.city, service_radius_km: parseInt(f.radius) || 1, intercity: f.intercity, capacity_kg: num(f.kg),
        max_length_cm: num(f.len), max_width_cm: num(f.wid), max_height_cm: num(f.hei), helps_loading: f.loading, pricing_model: f.model, price_cents: cents(f.price), price_type: f.ptype }, 'Service published'); }}>
        <div className="field"><label htmlFor="t">Service name</label><input id="t" className="input" value={f.title} onChange={(e) => set('title', e.target.value)} required minLength={3} placeholder="e.g. Pickup truck furniture delivery" /></div>
        <div className="row wrap"><div style={{ flex: 1, minWidth: 150 }}><CityInput id="sc" label="Based in" value={f.city} onChange={(v) => set('city', v)} required /></div><div className="field" style={{ width: 150 }}><label htmlFor="rd">Service radius (km)</label><input id="rd" className="input" inputMode="numeric" value={f.radius} onChange={(e) => set('radius', e.target.value.replace(/\D/g, ''))} required /></div></div>
        <Check label="I also deliver beyond this area" v={f.intercity} on={(b) => set('intercity', b)} />
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="vh">Vehicle</label><select id="vh" className="input" value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)}>{Object.entries(VEHICLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div><div className="field" style={{ width: 140 }}><label htmlFor="kg">Max load (kg)</label><input id="kg" className="input" inputMode="numeric" value={f.kg} onChange={(e) => set('kg', e.target.value.replace(/\D/g, ''))} required /></div></div>
        <div className="field"><label>Largest item, cm (optional)</label><div className="row">{[['len', 'length'], ['wid', 'width'], ['hei', 'height']].map(([k, l]) => <input key={k} className="input" aria-label={l} placeholder={l} inputMode="numeric" value={(f as any)[k]} onChange={(e) => set(k, e.target.value.replace(/\D/g, ''))} />)}</div></div>
        <Check label="I help load and unload" v={f.loading} on={(b) => set('loading', b)} />
        <div className="row wrap"><div className="field" style={{ flex: 1, minWidth: 130 }}><label htmlFor="pm">Pricing</label><select id="pm" className="input" value={f.model} onChange={(e) => set('model', e.target.value)}><option value="flat">Flat price</option><option value="hourly">Per hour</option><option value="per_km">Per km</option></select></div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}><label htmlFor="pr">Price (CAD)</label><input id="pr" className="input" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} required /></div>
          <div className="field" style={{ flex: 1, minWidth: 130 }}><label htmlFor="pt">Type</label><select id="pt" className="input" value={f.ptype} onChange={(e) => set('ptype', e.target.value)}><option value="negotiable">Negotiable</option><option value="fixed">Fixed</option></select></div></div>
        <div className="field"><label htmlFor="ds">About your service</label><textarea id="ds" className="input" value={f.desc} onChange={(e) => set('desc', e.target.value)} /></div>
        {s.err && <div className="err" role="alert">{s.err}</div>}
        <button className="btn" disabled={s.busy}>{s.busy ? 'Publishing…' : 'Publish service'}</button>
      </form>
    </main>
  );
}
