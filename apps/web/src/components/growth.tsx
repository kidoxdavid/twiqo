import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { t, useLocale } from '../i18n';
import { ListingCard } from './cards';
import { Avatar, errMsg } from './ui';
import { useToast } from './Toast';

/** Trending strip shown above the market grid: what people are actually saving, liking and making offers on this week. */
export function DiscoverStrip() {
  useLocale(); const q = useQuery({ queryKey: ['discover'], queryFn: () => api('/discover'), staleTime: 60_000 });
  const d = q.data; if (!d || (!d.listings.length && !d.tags.length && !d.circles.length)) return null;
  return <section aria-label={t('home.trending')} style={{ padding: '0 16px 8px' }}>
    {d.tags.length > 0 && <div className="col" style={{ gap: 6, marginBottom: 10 }}><h2 className="sec" style={{ margin: 0 }}>{t('home.trending_tags')}</h2>
      <div className="row wrap">{d.tags.map((x: any) => <Link key={x.tag} className="pill" to={`/market?q=${encodeURIComponent(x.tag)}`}>#{x.tag} <span className="muted">· {x.uses}</span></Link>)}</div></div>}
    {d.listings.length > 0 && <><h2 className="sec">{t('home.trending')}</h2><div className="hscroll">{d.listings.map((l: any) => <div key={l.id} style={{ width: 168, flex: 'none' }}><ListingCard l={l} /></div>)}</div></>}
    {d.circles.length > 0 && <><h2 className="sec">{t('home.trending_circles')}</h2><div className="row wrap">{d.circles.map((c: any) => <Link key={c.id} to={`/c/${c.slug}`} className="pill b">{c.name} · +{c.new_members}</Link>)}</div></>}
  </section>;
}

export function RecommendedListings() {
  const { me } = useAuth(); useLocale();
  const q = useQuery({ queryKey: ['rec-listings', me?.id], queryFn: () => api('/recommendations/listings'), enabled: !!me, staleTime: 60_000 });
  if (!me || !q.data?.items.length) return null;
  return <section style={{ padding: '0 16px 8px' }}><h2 className="sec">{q.data.basis === 'your_activity' ? t('market.for_you') : t('market.for_you_new')}</h2><div className="hscroll">{q.data.items.map((l: any) => <div key={l.id} style={{ width: 168, flex: 'none' }}><ListingCard l={l} /></div>)}</div></section>;
}

export function SimilarListings({ id }: { id: string }) {
  useLocale(); const q = useQuery({ queryKey: ['similar', id], queryFn: () => api(`/listings/${id}/similar`), staleTime: 60_000 });
  if (!q.data?.items.length) return null;
  return <section style={{ padding: '16px 16px 0' }}><h2 className="sec">{t('market.similar')}</h2><div className="grid">{q.data.items.slice(0, 6).map((l: any) => <ListingCard key={l.id} l={l} />)}</div></section>;
}

export function PeopleToFollow() {
  const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); useLocale();
  const q = useQuery({ queryKey: ['rec-people', me?.id], queryFn: () => api('/recommendations/people'), enabled: !!me, staleTime: 120_000 });
  if (!me || !q.data?.items.length) return null;
  const follow = async (id: string) => { try { await api(`/follows/user/${id}`, { method: 'POST' }); qc.setQueryData(['rec-people', me.id], (o: any) => ({ items: o.items.filter((p: any) => p.id !== id) })); qc.invalidateQueries({ queryKey: ['feed'] }); } catch (e) { toast(errMsg(e), 'err'); } };
  return <section style={{ padding: '0 16px 12px' }}><h2 className="sec">{t('home.people')}</h2><div className="hscroll">{q.data.items.slice(0, 8).map((p: any) => <div key={p.id} className="card pad col" style={{ width: 168, flex: 'none', alignItems: 'center', textAlign: 'center', gap: 6 }}>
    <Link to={`/u/${p.username}`}><Avatar user={p} size={56} /></Link><Link to={`/u/${p.username}`} className="pplink"><b className="sm">{p.display_name}</b></Link><div className="muted sm" style={{ minHeight: 32 }}>{p.reason}</div><button className="btn sm" onClick={() => follow(p.id)}>{t('home.follow')}</button></div>)}</div></section>;
}
