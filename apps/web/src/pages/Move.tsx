import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Comments, shareLink, useRequireAuth, useToggle } from '../components/cards';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { CATEGORIES, CityInput, JourneyCard, OfferCard, OfferDialog, RequestCard, RouteMap, ServiceCard, Stars, VEHICLES, fmtDate, fmtDateTime, windowText, type Match } from '../components/transport';
import { BoostButton } from '../components/payments';
import { Avatar, Menu, ReportDialog, State, Verified, errMsg, money } from '../components/ui';

type Tab = 'journeys' | 'requests' | 'services';

export function Move() {
  const [sp, setSp] = useSearchParams(); const { me } = useAuth();
  const tab = (sp.get('tab') as Tab) || 'journeys';
  const [from, setFrom] = useState(sp.get('from') ?? ''); const [to, setTo] = useState(sp.get('to') ?? ''); const [date, setDate] = useState(sp.get('date') ?? '');
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const params = { from: sp.get('from') || undefined, to: sp.get('to') || undefined, city: tab === 'services' ? sp.get('from') || undefined : undefined, date_from: sp.get('date') || undefined, radius_km: 80, limit: 20 };
  const q = useInfiniteQuery({
    queryKey: ['move', tab, params], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api(`/transport/${tab}`, { query: { ...(tab === 'services' ? { city: params.city } : { from: params.from, to: params.to, date_from: params.date_from, radius_km: params.radius_km }), cursor: pageParam, limit: 20 } }),
    getNextPageParam: (l: any) => l.next_cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p: any) => p.items) ?? [];
  const search = (e: React.FormEvent) => { e.preventDefault(); const n = new URLSearchParams(sp); for (const [k, v] of [['from', from], ['to', to], ['date', date]]) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  return (
    <main className="main">
      <div className="row" style={{ padding: '0 16px' }}><h1 className="page" style={{ padding: '6px 0 12px', flex: 1 }}>Move</h1>{me && <><Link className="btn sm soft" to="/bookings">My moves</Link><Link className="btn sm soft" to="/offers">Offers</Link></>}</div>
      <div className="seg" role="tablist" style={{ display: 'flex', margin: '0 16px 12px', background: '#fff', borderRadius: 16, padding: 4 }}>
        {(['journeys', 'requests', 'services'] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} style={{ flex: 1 }} onClick={() => set('tab', t === 'journeys' ? '' : t)}>{t === 'journeys' ? 'Journeys' : t === 'requests' ? 'Requests' : 'Services'}</button>)}
      </div>
      <form className="card pad col" style={{ margin: '0 16px 12px', gap: 10 }} onSubmit={search}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}><div style={{ flex: 1, minWidth: 130 }}><CityInput id="mf" label={tab === 'services' ? 'Your city' : 'From'} value={from} onChange={setFrom} /></div>
          {tab !== 'services' && <div style={{ flex: 1, minWidth: 130 }}><CityInput id="mt" label="To" value={to} onChange={setTo} /></div>}
          {tab !== 'services' && <div className="field" style={{ minWidth: 140 }}><label htmlFor="md">{tab === 'journeys' ? 'Departing after' : 'Pickup after'}</label><input id="md" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>}
          <button className="btn">Search</button></div>
        {tab === 'journeys' && <div className="muted sm">We look for drivers who pass through your pickup and drop-off, not only drivers with the exact same start and end.</div>}
      </form>
      <div className="row wrap" style={{ padding: '0 16px 12px' }}>
        <Link className="btn teal sm" to="/create/request"><Icon name="box" />Find someone to move it</Link><Link className="btn ghost sm" to="/create/journey"><Icon name="route" />Offer a journey</Link><Link className="btn ghost sm" to="/create/service"><Icon name="truck" />Offer a service</Link>
      </div>
      {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="error" text={(q.error as Error).message} /> : items.length === 0
        ? <State kind="empty" title={tab === 'journeys' ? 'No journeys match' : tab === 'requests' ? 'No requests match' : 'No services here yet'} text="Try a wider search, or post what you need and let drivers come to you." action={<Link className="btn" to={tab === 'journeys' ? '/create/request' : tab === 'requests' ? '/create/journey' : '/create/service'}>{tab === 'journeys' ? 'Post a request' : tab === 'requests' ? 'Post a journey' : 'Offer a service'}</Link>} />
        : <>{items.map((x: any) => tab === 'journeys' ? <JourneyCard key={x.id} j={x} /> : tab === 'requests' ? <RequestCard key={x.id} r={x} /> : <ServiceCard key={x.id} s={x} />)}
          {q.hasNextPage && <div style={{ textAlign: 'center', padding: 12 }}><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</button></div>}</>}
    </main>
  );
}

function Actions({ type, id, liked, likes, saved, title, owner, path, onReport }: { type: string; id: string; liked: boolean; likes: number; saved: boolean; title: string; owner: boolean; path: string; onReport: () => void }) {
  const like = useToggle('reactions', type, id, liked, likes); const save = useToggle('saves', type, id, saved); const toast = useToast(); const guard = useRequireAuth();
  return <div className="row wrap">
    <button className="btn soft" onClick={like.toggle} aria-pressed={like.on} aria-label="Like"><Icon name="heart" fill={like.on} />{like.count}</button>
    <button className="btn soft" onClick={save.toggle} aria-pressed={save.on} aria-label="Save"><Icon name="save" fill={save.on} /></button>
    <button className="btn soft" onClick={() => shareLink(path, title, toast)} aria-label="Share"><Icon name="share" /></button>
    {!owner && <Menu items={[{ label: 'Report', onClick: () => guard(onReport) }]} />}
  </div>;
}

function Person({ u, role }: { u: any; role: string }) {
  return <Link to={`/u/${u.username}`} className="card pad row"><Avatar user={u} size={46} /><div><b>{u.display_name} {u.verification_level === 'identity' && <Verified />}</b><div className="row sm muted" style={{ gap: 6 }}>{role} · <Stars avg={u.rating_avg} count={u.rating_count} completed={u.completed} /></div></div></Link>;
}

export function JourneyPage() {
  const { id } = useParams(); const nav = useNavigate(); const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); const guard = useRequireAuth();
  const [offer, setOffer] = useState(false); const [report, setReport] = useState(false);
  const q = useQuery({ queryKey: ['journey', id, me?.id], queryFn: () => api(`/transport/journeys/${id}`) });
  const j = q.data; const owner = j?.viewer.is_owner;
  const matches = useQuery({ queryKey: ['jmatches', id], queryFn: () => api(`/transport/journeys/${id}/matches`), enabled: !!owner && j?.status === 'open' });
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="This journey isn't available" action={<Link className="btn" to="/move">Browse journeys</Link>} /></main>;
  const pts = [j.origin, ...j.waypoints, j.destination].map((p: any) => ({ lat: p.lat, lng: p.lng, label: p.city }));
  const act = async (path: string, method = 'POST') => { try { await api(`/transport/journeys/${id}${path}`, { method }); toast('Updated'); qc.invalidateQueries(); } catch (e) { toast(errMsg(e), 'err'); } };
  return (
    <main className="main"><div style={{ padding: '0 16px 8px' }}><button className="row muted" onClick={() => nav(-1)}><Icon name="back" />Back</button></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <RouteMap points={pts} height={170} />
        <div><div className="row wrap"><span className={`pill ${j.status === 'open' ? 't' : 'a'}`}>{j.status}</span><span className="pill b">{VEHICLES[j.vehicle_type]}</span></div>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, margin: '8px 0 2px' }}>{j.origin.city} → {j.destination.city}</h1>
          <div className="muted sm">Departs {fmtDateTime(j.departure_at)}{j.arrival_at ? ` · arrives about ${fmtDate(j.arrival_at)}` : ''} · {j.distance_km.toLocaleString()} km{j.waypoints.length ? ` · via ${j.waypoints.map((w: any) => w.city).join(', ')}` : ''}</div></div>
        <div className="row"><div className="price" style={{ fontSize: 28 }}>{j.price_type === 'fixed' ? '' : 'From '}{money(j.price_cents)}</div><span className={`pill ${j.price_type === 'fixed' ? '' : 't'}`}>{j.price_type === 'fixed' ? 'Fixed price' : 'Negotiable'}</span></div>
        <Person u={j.driver} role={j.business ? j.business.name : 'Driver'} />
        <div className="card pad col" style={{ gap: 6 }}>
          <div className="row"><b>Space available</b><span className="sp" /><span>{j.remaining_kg} of {j.capacity_kg} kg</span></div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}><i style={{ display: 'block', height: '100%', width: `${(j.remaining_kg / j.capacity_kg) * 100}%`, background: 'var(--teal)' }} /></div>
          <div className="muted sm">{j.max_dimensions_cm.length ? `Largest item ${j.max_dimensions_cm.length}×${j.max_dimensions_cm.width ?? '?'}×${j.max_dimensions_cm.height ?? '?'} cm · ` : ''}Detour up to {j.max_detour_km} km{j.helps_loading ? ' · helps with loading' : ''}</div>
          {j.item_restrictions.length > 0 && <div className="row wrap">{j.item_restrictions.map((r: string) => <span key={r} className="pill a">No {r.replace('_', ' ')}</span>)}</div>}
        </div>
        {j.description && <p style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{j.description}</p>}
        {(j.pickup_preferences || j.delivery_preferences) && <div className="card pad sm col" style={{ gap: 4 }}>{j.pickup_preferences && <div><b>Pickup:</b> {j.pickup_preferences}</div>}{j.delivery_preferences && <div><b>Delivery:</b> {j.delivery_preferences}</div>}</div>}
        <div className="row wrap">
          {!owner && j.status === 'open' && <button className="btn" style={{ flex: 1 }} onClick={() => guard(() => setOffer(true))}>Book space / make offer</button>}
          {!owner && <button className="btn ghost" onClick={() => guard(() => nav(`/messages/new?to=${j.driver.id}&subject_type=journey&subject_id=${j.id}`))}><Icon name="chat" />Message</button>}
          {owner && ['open', 'full'].includes(j.status) && <><button className="btn soft" onClick={() => confirm('Mark this journey as departed? New offers will be closed.') && act('/depart')}>Mark departed</button><button className="btn ghost" onClick={() => confirm('Cancel this journey?') && act('', 'DELETE').then(() => nav('/move'))}>Cancel journey</button></>}
        </div>
        <Actions type="journey" id={j.id} liked={j.viewer.liked} likes={j.counts.likes} saved={j.viewer.saved} title="twiqo journey" owner={!!owner} path={`/j/${j.id}`} onReport={() => setReport(true)} />
        {!owner && <div className="muted sm">Agree payment directly with the driver. twiqo doesn't hold funds yet, and insurance depends on the driver's own coverage.</div>}
        {owner && j.status === 'open' && <><h2 className="sec">Requests that could fit this trip</h2>{matches.isLoading ? <State kind="loading" /> : matches.data?.requests.length ? matches.data.requests.map((m: any) => <div key={m.request.id} style={{ margin: '0 -16px' }}><RequestCard r={m.request} match={m.match as Match} /></div>) : <div className="muted">No matching requests yet. We'll notify you when one appears.</div>}</>}
        <h2 className="sec">Questions</h2><Comments target={{ type: 'journey' as any, id: j.id }} />
      </div>
      {offer && <OfferDialog target={{ kind: 'journey', journey: j }} onClose={() => setOffer(false)} />}
      {report && <ReportDialog target={{ type: 'journey', id: j.id }} onClose={() => setReport(false)} />}
    </main>
  );
}

export function RequestPage() {
  const { id } = useParams(); const nav = useNavigate(); const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); const guard = useRequireAuth();
  const [offer, setOffer] = useState(false); const [report, setReport] = useState(false);
  const q = useQuery({ queryKey: ['request', id, me?.id], queryFn: () => api(`/transport/requests/${id}`) });
  const r = q.data; const owner = r?.viewer.is_owner;
  const matches = useQuery({ queryKey: ['rmatches', id], queryFn: () => api(`/transport/requests/${id}/matches`), enabled: !!owner && r?.status === 'open' });
  const offers = useQuery({ queryKey: ['offers', 'request', id], queryFn: () => api('/offers', { query: { request_id: id, state: 'active' } }), enabled: !!me && r?.status === 'open' });
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="This request isn't available" text="It may have been booked or cancelled." action={<Link className="btn" to="/move?tab=requests">Browse requests</Link>} /></main>;
  const pts = [r.origin, r.destination].map((p: any) => ({ lat: p.lat, lng: p.lng, label: p.city }));
  const d = r.dimensions_cm;
  return (
    <main className="main"><div style={{ padding: '0 16px 8px' }}><button className="row muted" onClick={() => nav(-1)}><Icon name="back" />Back</button></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <RouteMap points={pts} height={140} />
        <div><div className="row wrap"><span className={`pill ${r.status === 'open' ? 't' : 'a'}`}>{r.status}</span><span className="pill b">{CATEGORIES[r.item_category]}</span>{r.visibility === 'private' && <span className="pill">Private</span>}</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, margin: '8px 0 2px' }}>{r.title}</h1>
          <div className="muted sm">{r.origin.city}{r.origin.area ? ` (${r.origin.area})` : ''} → {r.destination.city}{r.destination.area ? ` (${r.destination.area})` : ''}</div></div>
        <div className="card pad col" style={{ gap: 6 }}>
          <div className="row"><b>Pickup window</b><span className="sp" />{windowText(r.pickup_from, r.pickup_to)}</div>
          {r.deliver_by && <div className="row"><b>Deliver by</b><span className="sp" />{fmtDate(r.deliver_by)}</div>}
          <div className="row"><b>Size &amp; weight</b><span className="sp" />{r.quantity > 1 ? `${r.quantity} × ` : ''}{r.weight_kg} kg{d.length ? ` · ${d.length}×${d.width}×${d.height} cm` : ''}</div>
          <div className="row"><b>Budget</b><span className="sp" />{r.budget_cents !== null ? `${money(r.budget_cents)} · ${r.price_type === 'fixed' ? 'fixed' : 'negotiable'}` : 'Open to offers'}</div>
          <div className="row wrap">{r.fragile && <span className="pill a">Fragile</span>}{r.needs_loading_help && <span className="pill">Help loading</span>}{r.needs_unloading_help && <span className="pill">Help unloading</span>}{r.preferred_vehicles.map((v: string) => <span key={v} className="pill b">{VEHICLES[v]}</span>)}</div>
          {r.special_handling && <div className="sm"><b>Handling:</b> {r.special_handling}</div>}
        </div>
        {r.description && <p style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{r.description}</p>}
        {r.images.length > 0 && <div className="row" style={{ overflowX: 'auto' }}>{r.images.map((m: any) => <img key={m.id} src={m.thumb_url} alt="" style={{ width: 96, height: 96, borderRadius: 14, objectFit: 'cover' }} />)}</div>}
        {r.linked_listing && <Link className="attach" to={`/l/${r.linked_listing.id}`}><div className="tx"><b>Moving a purchase</b><span className="muted sm">{r.linked_listing.title}</span></div><Icon name="back" /></Link>}
        <Person u={r.requester} role="Shipper" />
        <div className="row wrap">
          {!owner && r.status === 'open' && <button className="btn" style={{ flex: 1 }} onClick={() => guard(() => setOffer(true))}>Offer to carry this</button>}
          {!owner && <button className="btn ghost" onClick={() => guard(() => nav(`/messages/new?to=${r.requester.id}&subject_type=transport_request&subject_id=${r.id}`))}><Icon name="chat" />Message</button>}
          {owner && r.status === 'open' && <button className="btn ghost" onClick={async () => { if (confirm('Cancel this request?')) { try { await api(`/transport/requests/${id}`, { method: 'DELETE' }); toast('Request cancelled'); qc.invalidateQueries(); nav('/move'); } catch (e) { toast(errMsg(e), 'err'); } } }}>Cancel request</button>}
        </div>
        <Actions type="transport_request" id={r.id} liked={r.viewer.liked} likes={r.counts.likes} saved={r.viewer.saved} title={r.title} owner={!!owner} path={`/r/${r.id}`} onReport={() => setReport(true)} />
        {me && offers.data?.items.length > 0 && <><h2 className="sec">Offers</h2>{offers.data.items.map((o: any) => <OfferCard key={o.id} o={o} />)}</>}
        {owner && r.status === 'open' && <>
          <h2 className="sec">Best matches for your shipment</h2>
          {matches.isLoading ? <State kind="loading" /> : !matches.data?.journeys.length && !matches.data?.services.length ? <div className="muted">No matching drivers yet. We'll notify you when a matching journey is posted.</div>
            : <>{matches.data.journeys.map((m: any) => <div key={m.journey.id} style={{ margin: '0 -16px' }}><JourneyCard j={m.journey} match={m.match} to={`/j/${m.journey.id}?request=${r.id}`} /></div>)}
              {matches.data.services.map((m: any) => <div key={m.service.id} style={{ margin: '0 -16px' }}><ServiceCard s={m.service} match={m.match} to={`/s/${m.service.id}?request=${r.id}`} /></div>)}</>}</>}
        <h2 className="sec">Questions</h2><Comments target={{ type: 'transport_request' as any, id: r.id }} />
      </div>
      {offer && <OfferDialog target={{ kind: 'request', request: r }} onClose={() => setOffer(false)} />}
      {report && <ReportDialog target={{ type: 'transport_request', id: r.id }} onClose={() => setReport(false)} />}
    </main>
  );
}

export function ServicePage() {
  const { id } = useParams(); const nav = useNavigate(); const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); const guard = useRequireAuth();
  const [offer, setOffer] = useState(false); const [report, setReport] = useState(false);
  const q = useQuery({ queryKey: ['service', id, me?.id], queryFn: () => api(`/transport/services/${id}`) });
  const s = q.data; const owner = s?.viewer.is_owner;
  if (q.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (q.isError) return <main className="main"><State kind="empty" title="This service isn't available" action={<Link className="btn" to="/move?tab=services">Browse services</Link>} /></main>;
  const unit = { flat: ' flat', hourly: ' per hour', per_km: ' per km' }[s.pricing_model as string];
  return (
    <main className="main"><div style={{ padding: '0 16px 8px' }}><button className="row muted" onClick={() => nav(-1)}><Icon name="back" />Back</button></div>
      <div className="col" style={{ padding: '0 16px' }}>
        <div><div className="row wrap"><span className={`pill ${s.status === 'active' ? 't' : 'a'}`}>{s.status}</span>{s.featured && <span className="pill a">Featured</span>}<span className="pill b">{VEHICLES[s.vehicle_type]}</span></div><h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5, margin: '8px 0 2px' }}>{s.title}</h1>
          <div className="muted sm">Serves {s.area.city} and {s.service_radius_km} km around{s.intercity ? ', and can deliver beyond' : ''}</div></div>
        <div className="row"><div className="price" style={{ fontSize: 28 }}>{s.price_type === 'fixed' ? '' : 'From '}{money(s.price_cents)}</div><span className="muted sm">{unit} · {s.price_type === 'fixed' ? 'fixed' : 'negotiable'}</span></div>
        <Person u={s.provider} role={s.business ? s.business.name : 'Provider'} />
        <div className="card pad row wrap sm"><span className="pill">up to {s.capacity_kg} kg</span>{s.max_dimensions_cm.length && <span className="pill">{s.max_dimensions_cm.length}×{s.max_dimensions_cm.width}×{s.max_dimensions_cm.height} cm</span>}{s.helps_loading && <span className="pill t">Helps load &amp; unload</span>}{s.item_restrictions.map((r: string) => <span key={r} className="pill a">No {r.replace('_', ' ')}</span>)}</div>
        {s.description && <p style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{s.description}</p>}
        <div className="row wrap">
          {!owner && s.status === 'active' && <button className="btn" style={{ flex: 1 }} onClick={() => guard(() => setOffer(true))}>Request a booking</button>}
          {!owner && <button className="btn ghost" onClick={() => guard(() => nav(`/messages/new?to=${s.provider.id}&subject_type=service&subject_id=${s.id}`))}><Icon name="chat" />Message</button>}
          {owner && s.status === 'active' && !s.featured && <BoostButton targetType="transport_service" targetId={s.id} />}
          {owner && <><button className="btn soft" onClick={async () => { try { await api(`/transport/services/${id}`, { method: 'PATCH', body: { status: s.status === 'active' ? 'paused' : 'active' } }); qc.invalidateQueries(); } catch (e) { toast(errMsg(e), 'err'); } }}>{s.status === 'active' ? 'Pause service' : 'Resume service'}</button>
            <button className="btn ghost" onClick={async () => { if (confirm('Remove this service?')) { try { await api(`/transport/services/${id}`, { method: 'DELETE' }); nav('/move?tab=services'); } catch (e) { toast(errMsg(e), 'err'); } } }}>Remove</button></>}
        </div>
        <Actions type="transport_service" id={s.id} liked={s.viewer.liked} likes={s.counts.likes} saved={s.viewer.saved} title={s.title} owner={!!owner} path={`/s/${s.id}`} onReport={() => setReport(true)} />
        <h2 className="sec">Questions</h2><Comments target={{ type: 'transport_service' as any, id: s.id }} />
      </div>
      {offer && <OfferDialog target={{ kind: 'service', service: s }} onClose={() => setOffer(false)} />}
      {report && <ReportDialog target={{ type: 'transport_service', id: s.id }} onClose={() => setReport(false)} />}
    </main>
  );
}
