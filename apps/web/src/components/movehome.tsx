import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from './Icon';
import { CityInput, RouteLine, fmtDate } from './transport';
import { Verified, money } from './ui';
import { t } from '../i18n';

/** Where am I sending something? Sends the visitor to Move with the route filled in. */
export function MoveHero({ guest }: { guest?: boolean }) {
  const nav = useNavigate(); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const go = (e: React.FormEvent) => { e.preventDefault(); const p = new URLSearchParams(); if (from.trim()) p.set('from', from.trim()); if (to.trim()) p.set('to', to.trim()); nav(`/move${p.toString() ? `?${p}` : ''}`); };
  return (
    <section className="mv-hero" aria-labelledby="mvh">
      {guest && <span className="mv-badge"><Icon name="truck" />{t('hero.badge')}</span>}
      <h1 id="mvh">{guest ? t('hero.guest_title') : t('hero.title')}</h1>
      <p>{guest ? t('hero.guest_text') : t('hero.text')}</p>
      <form className="col" style={{ gap: 10, marginTop: 14 }} onSubmit={go}>
        <CityInput id="hf" value={from} onChange={setFrom} placeholder={t('hero.from')} label={t('hero.from')} />
        <CityInput id="ht" value={to} onChange={setTo} placeholder={t('hero.to')} label={t('hero.to')} />
        <button className="btn mv-white">{t('hero.find')}<Icon name="back" className="flip" /></button>
        <Link className="btn mv-out" to="/create/journey">{guest ? t('hero.driving_long') : t('hero.driving')}</Link>
      </form>
    </section>
  );
}

export function HowItWorks() {
  const steps = [[t('how.1'), t('how.1d')], [t('how.2'), t('how.2d')], [t('how.3'), t('how.3d')]];
  return (
    <section style={{ padding: '0 16px' }} aria-labelledby="hiw">
      <h2 className="sec" id="hiw" style={{ marginTop: 22 }}>{t('how.title')}</h2>
      <ol className="steps">{steps.map(([a, b], i) => <li key={i}><span className="n">{i + 1}</span><div><b>{a}</b><small>{b}</small></div></li>)}</ol>
      <div className="card pad row" style={{ marginTop: 18, gap: 12 }}><span className="trust"><Icon name="shield" /></span><div><b>{t('how.paid')}</b><div className="muted sm">{t('how.paid_d')}</div></div></div>
    </section>
  );
}

/** The person's live moves, so "where is my stuff?" is answered on the first screen. */
export function ActiveMoves() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['bookings', 'active'], queryFn: () => api('/bookings', { query: { state: 'active' } }), enabled: !!me, staleTime: 30_000 });
  const items: any[] = q.data?.items ?? []; if (!items.length) return null;
  const b = items[0]; const label = (s: string) => ({ confirmed: 'Confirmed', pickup_confirmed: 'Picked up', in_transit: 'In transit', delivered: 'Delivered' } as Record<string, string>)[s] ?? s.replace('_', ' ');
  const pct = ({ confirmed: 15, pickup_confirmed: 35, in_transit: 65, delivered: 95 } as Record<string, number>)[b.status] ?? 20;
  return (
    <section style={{ padding: '14px 16px 0' }} aria-label={t('moves.active')}>
      <Link to={`/bookings/${b.id}`} className="card pad col" style={{ gap: 8 }}>
        <div className="row"><span className={`pill ${b.status === 'delivered' ? 't' : 'a'}`}><Icon name="truck" className="xs" />{label(b.status)}</span><span className="sp" />{items.length > 1 && <span className="muted sm">+{items.length - 1} more</span>}</div>
        <b style={{ fontSize: 16 }}>{b.shipment.title}</b>
        <RouteLine from={b.shipment.from.city} to={b.shipment.to.city} />
        <div className="meter" role="progressbar" aria-label="Progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><b style={{ width: `${pct}%` }} /></div>
        <div className="row sm muted"><span>{b.my_role === 'shipper' ? 'Carried by' : 'Shipping for'} {b.counterparty.display_name}</span><span className="sp" /><span className="link">{t('moves.track')}</span></div>
      </Link>
    </section>
  );
}

export function DriverCard({ j }: { j: any }) {
  const pct = Math.max(6, Math.min(100, Math.round((j.remaining_kg / Math.max(1, j.capacity_kg ?? j.remaining_kg)) * 100)));
  return (
    <Link to={`/j/${j.id}`} className="card pad col mv-driver" style={{ gap: 10 }}>
      <div className="row"><b className="sp" style={{ fontSize: 14 }}>{j.business?.name ?? j.driver.display_name} {j.driver.verification_level === 'identity' && <Verified />}</b></div>
      <RouteLine from={j.origin.city} to={j.destination.city} />
      <div className="sm muted">{fmtDate(j.departure_at)} · {j.remaining_kg} kg {t('move.space_left')}</div>
      <div className="meter" aria-hidden="true"><b style={{ width: `${pct}%` }} /></div>
      <div className="row"><b style={{ fontSize: 19 }}>{j.price_type === 'fixed' ? '' : `${t('move.from')} `}{money(j.price_cents)}</b></div>
    </Link>
  );
}

export function DriversNearYou() {
  const q = useQuery({ queryKey: ['home-journeys'], queryFn: () => api('/transport/journeys', { query: { limit: 6 } }), staleTime: 60_000 });
  const items: any[] = q.data?.items ?? [];
  return (
    <section aria-labelledby="dgy">
      <div className="secrow"><h2 className="sec" id="dgy">{t('home.drivers')}</h2><Link to="/move" className="more">{t('common.see_all')}</Link></div>
      {q.isLoading ? <div className="muted sm" style={{ padding: '0 16px' }}>{t('common.loading')}</div>
        : items.length === 0 ? <div className="card pad" style={{ margin: '0 16px' }}><b>{t('home.no_drivers')}</b><div className="muted sm" style={{ margin: '4px 0 12px' }}>{t('home.no_drivers_d')}</div><Link className="btn mv-btn sm" to="/create/request">{t('hero.post_request')}</Link></div>
        : <div className="hscroll">{items.map((j) => <DriverCard key={j.id} j={j} />)}</div>}
    </section>
  );
}

/** Market stays one tap away on Home, as a quieter second row. */
export function ShopStrip() {
  const q = useQuery({ queryKey: ['home-shop'], queryFn: () => api('/listings', { query: { limit: 8 } }), staleTime: 60_000 });
  const items: any[] = q.data?.items ?? []; if (!items.length) return null;
  return (
    <section aria-labelledby="shn">
      <div className="secrow"><h2 className="sec" id="shn">{t('home.shop')}</h2><Link to="/market" className="more">{t('nav.market')}</Link></div>
      <div className="hscroll">{items.map((l) => (
        <Link key={l.id} to={`/l/${l.id}`} className="shop-tile">
          <div className="th">{l.images[0] ? <img src={l.images[0].thumb_url} alt="" loading="lazy" /> : <div className="noimg"><Icon name="bag" /></div>}{l.fulfillment?.delivery && <span className="tagover"><Icon name="truck" className="xs" />{t('market.delivery')}</span>}</div>
          <b>{money(l.price_cents, l.price_type)}</b><span className="t">{l.title}</span>
        </Link>))}</div>
    </section>
  );
}

/** "Get it delivered": the Market to Move hand-off on a listing. */
export function DeliveryCard({ l }: { l: any }) {
  const city = l.location?.city as string | undefined;
  const q = useQuery({ queryKey: ['deliv-drivers', city], queryFn: () => api('/transport/journeys', { query: { from: city, radius_km: 80, limit: 20 } }), enabled: !!city, staleTime: 60_000 });
  const items: any[] = q.data?.items ?? [];
  const cheapest = items.length ? Math.min(...items.map((j) => j.price_cents)) : null;
  return (
    <div className="card pad mv-deliver">
      <div className="row"><span className="trust"><Icon name="truck" /></span>
        <div className="sp"><b>{t('deliver.title')}</b><div className="muted sm">{items.length ? t('deliver.drivers', { n: items.length, city: city ?? '' }) : t('deliver.none')}</div></div></div>
      <div className="row" style={{ marginTop: 12 }}>{cheapest !== null ? <b style={{ fontSize: 20 }}>{t('move.from')} {money(cheapest)}</b> : <span className="muted sm">{t('deliver.post')}</span>}<span className="sp" />
        <Link className="btn mv-btn sm" to={items.length ? `/move?from=${encodeURIComponent(city ?? '')}` : `/create/request?listing=${l.id}`}>{items.length ? t('deliver.see') : t('deliver.cta')}</Link></div>
    </div>
  );
}
