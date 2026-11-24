import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Comments, ListingCard, shareLink, useRequireAuth, useToggle } from '../components/cards';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { OfferDialog } from '../components/transport';
import { BoostButton } from '../components/payments';
import { Avatar, CONDITIONS, Menu, ReportDialog, State, Verified, ago, errMsg, money } from '../components/ui';

export function Market() {
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const [showFilters, setShowFilters] = useState(false);
  const cats = useQuery({ queryKey: ['cats'], queryFn: () => api('/categories'), staleTime: 300_000 });
  const params = { q: get('q'), category: get('category'), min_price: get('min') ? Math.round(Number(get('min')) * 100) : undefined, max_price: get('max') ? Math.round(Number(get('max')) * 100) : undefined, condition: get('condition'), city: get('city'), radius_km: get('city') ? get('radius') || 25 : undefined, sort: get('sort') || 'newest' };
  const q = useInfiniteQuery({ queryKey: ['listings', params], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => api('/listings', { query: { ...params, cursor: pageParam, limit: 24 } }), getNextPageParam: (l) => l.next_cursor ?? undefined });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <main className="main wide">
      <h1 className="page">Market</h1>
      <form className="row" style={{ padding: '0 16px 12px' }} role="search" onSubmit={(e) => { e.preventDefault(); set('q', (new FormData(e.currentTarget).get('q') as string).trim()); }}>
        <div className="searchbox" style={{ display: 'flex', maxWidth: 'none' }}><Icon name="search" /><input name="q" aria-label="Search listings" placeholder="Search furniture, bikes, tires…" defaultValue={get('q')} key={get('q')} /></div>
        <button type="button" className="btn soft" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}><Icon name="filter" />Filters</button>
      </form>
      <div className="chips" role="group" aria-label="Categories">
        <button className={`chip ${!get('category') ? 'on' : ''}`} onClick={() => set('category', '')}>All</button>
        {cats.data?.items.map((c: any) => <button key={c.id} className={`chip ${get('category') === c.slug ? 'on' : ''}`} onClick={() => set('category', c.slug)}>{c.name}</button>)}
      </div>
      {showFilters && (
        <div className="filters">
          <div className="field"><label htmlFor="mn">Min $</label><input id="mn" className="input" inputMode="numeric" value={get('min')} onChange={(e) => set('min', e.target.value.replace(/\D/g, ''))} /></div>
          <div className="field"><label htmlFor="mx">Max $</label><input id="mx" className="input" inputMode="numeric" value={get('max')} onChange={(e) => set('max', e.target.value.replace(/\D/g, ''))} /></div>
          <div className="field"><label htmlFor="cd">Condition</label><select id="cd" className="input" value={get('condition')} onChange={(e) => set('condition', e.target.value)}><option value="">Any</option>{Object.entries(CONDITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="ci">Near city</label><input id="ci" className="input" placeholder="e.g. Calgary" defaultValue={get('city')} onBlur={(e) => set('city', e.target.value.trim())} /></div>
          <div className="field"><label htmlFor="rd">Radius</label><select id="rd" className="input" value={get('radius') || '25'} onChange={(e) => set('radius', e.target.value)}>{[10, 25, 50, 100, 250, 1000].map((r) => <option key={r} value={r}>{r} km</option>)}</select></div>
          <div className="field"><label htmlFor="so">Sort</label><select id="so" className="input" value={get('sort') || 'newest'} onChange={(e) => set('sort', e.target.value)}><option value="newest">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option><option value="distance" disabled={!get('city')}>Nearest{!get('city') ? ' (pick a city)' : ''}</option></select></div>
        </div>
      )}
      {q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="error" text={(q.error as Error).message} /> : items.length === 0
        ? <State kind="empty" title="No listings match" text="Try a different search or clear some filters." action={<div className="row" style={{ justifyContent: 'center' }}><button className="btn ghost" onClick={() => setSp({}, { replace: true })}>Clear filters</button><Link className="btn" to="/create/listing">Sell something</Link></div>} />
        : <><div className="grid">{items.map((l: any) => <ListingCard key={l.id} l={l} />)}</div>
          {q.hasNextPage && <div style={{ textAlign: 'center', padding: 20 }}><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>}</>}
    </main>
  );
}

export function ListingDetail() {
  const { id } = useParams(); const nav = useNavigate(); const { me } = useAuth(); const toast = useToast(); const guard = useRequireAuth();
  const [img, setImg] = useState(0); const [report, setReport] = useState(false); const [offer, setOffer] = useState(false);
  const q = useQuery({ queryKey: ['listing', id], queryFn: () => api(`/listings/${id}`) });
  const l = q.data;
  const like = useToggle('reactions', 'listing', id!, l?.viewer.liked ?? false, l?.counts.likes ?? 0);
  const save = useToggle('saves', 'listing', id!, l?.viewer.saved ?? false);
  if (q.isLoading) return <main className="main wide"><State kind="loading" /></main>;
  if (q.isError) return <main className="main wide"><State kind="empty" title="This listing isn't available" text="It may have been sold, removed, or is private." action={<Link className="btn" to="/market">Browse the market</Link>} /></main>;
  const mine = l.viewer.is_owner;
  async function setStatus(status: string) { try { await api(`/listings/${id}`, { method: 'PATCH', body: { status } }); toast('Updated'); q.refetch(); } catch (e) { toast(errMsg(e), 'err'); } }
  return (
    <main className="main wide">
      <div style={{ padding: '0 16px 8px' }}><button className="row muted" onClick={() => nav(-1)}><Icon name="back" />Back</button></div>
      <div className="detail">
        <div>
          <div className="hero">{l.images[img] ? <img src={l.images[img].url} alt={l.title} /> : <div className="noimg"><Icon name="bag" /></div>}</div>
          {l.images.length > 1 && <div className="thumbs">{l.images.map((m: any, i: number) => <img key={m.id} src={m.thumb_url} alt={`Photo ${i + 1}`} className={i === img ? 'on' : ''} onClick={() => setImg(i)} />)}</div>}
        </div>
        <div className="col">
          <div className="row wrap"><span className="pill b">{l.category.name}</span>{l.featured && <span className="pill a">Featured</span>}{l.status !== 'active' && <span className="pill a">{l.status === 'pending_review' ? 'Under review' : l.status}</span>}</div>
          <h1 style={{ fontSize: 24, letterSpacing: -0.5, fontWeight: 800 }}>{l.title}</h1>
          <div className="price">{money(l.price_cents, l.price_type)} {l.price_type === 'negotiable' && <span className="pill t" style={{ verticalAlign: 'middle' }}>Negotiable</span>}</div>
          <div className="muted sm">{CONDITIONS[l.condition]} · {l.location.city}, {l.location.province} · Listed {ago(l.created_at)} ago · Quantity {l.quantity}</div>
          <div className="row wrap">{l.fulfillment.pickup && <span className="pill">Pickup</span>}{l.fulfillment.delivery && <span className="pill t">Delivery available</span>}{l.fulfillment.shipping && <span className="pill">Shipping</span>}</div>
          <Link to={l.business ? `/b/${l.business.slug}` : `/u/${l.seller.username}`} className="card pad row"><Avatar user={l.seller} size={44} /><div><b>{l.business?.name ?? l.seller.display_name} {(l.business?.verified || l.seller.verification_level === 'identity') && <Verified />}</b><div className="muted sm">{l.business ? 'Business' : `@${l.seller.username}`}</div></div><span className="sp" /><span className="muted" style={{ transform: 'rotate(180deg)', display: 'flex' }}><Icon name="back" /></span></Link>
          {l.description && <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{l.description}</p>}
          {l.tags.length > 0 && <div className="row wrap">{l.tags.map((t: string) => <Link key={t} className="pill" to={`/market?q=${t}`}>#{t}</Link>)}</div>}
          <div className="row wrap">
            {mine ? <>
              {l.status === 'active' && <><button className="btn teal" onClick={() => setStatus('sold')}>Mark as sold</button><button className="btn soft" onClick={() => setStatus('reserved')}>Reserve</button></>}
              {['reserved', 'sold'].includes(l.status) && <button className="btn" onClick={() => setStatus('active')}>Relist</button>}
              <button className="btn ghost" onClick={async () => { if (confirm('Remove this listing?')) { try { await api(`/listings/${id}`, { method: 'DELETE' }); nav('/market'); } catch (e) { toast(errMsg(e), 'err'); } } }}>Remove</button>
              <Link className="btn soft" to="/offers">View offers</Link>
              {l.status === 'active' && !l.featured && <BoostButton targetType="listing" targetId={l.id} />}
            </> : <>
              {l.status === 'active' && <button className="btn" style={{ flex: 1 }} onClick={() => guard(() => setOffer(true))}>{l.price_type === 'fixed' ? 'Buy at listed price' : l.price_type === 'free' ? 'Ask for it' : 'Make offer'}</button>}
              <button className="btn ghost" onClick={() => guard(() => nav(`/messages/new?to=${l.seller.id}&listing=${l.id}`))}><Icon name="chat" />Message</button>
              {l.status === 'active' && <button className="btn teal" onClick={() => guard(() => nav(`/create/request?listing=${l.id}`))}><Icon name="truck" />Get it moved</button>}</>}
            <button className={`btn soft ${like.on ? '' : ''}`} onClick={like.toggle} aria-pressed={like.on} aria-label="Like"><Icon name="heart" fill={like.on} />{like.count}</button>
            <button className="btn soft" onClick={save.toggle} aria-pressed={save.on} aria-label="Save"><Icon name="save" fill={save.on} /></button>
            <button className="btn soft" onClick={() => shareLink(`/l/${l.id}`, l.title, toast)} aria-label="Share"><Icon name="share" /></button>
            {!mine && <Menu items={[{ label: 'Report listing', onClick: () => guard(() => setReport(true)) }]} />}
          </div>
          <div className="muted sm">Meet in a public place and never send money before you've seen the item. twiqo doesn't hold funds yet — agree payment directly.</div>
          <h2 className="sec" style={{ marginTop: 14 }}>Questions &amp; comments</h2>
          <Comments target={{ type: 'listing', id: l.id }} />
        </div>
      </div>
      {offer && <OfferDialog target={{ kind: 'goods', listing: l }} onClose={() => setOffer(false)} />}
      {report && <ReportDialog target={{ type: 'listing', id: l.id }} onClose={() => setReport(false)} />}
    </main>
  );
}
