import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { FeedListing, PostCard } from '../components/cards';
import { State } from '../components/ui';
import { t, useLocale } from '../i18n';
import { JourneyCard, RequestCard, ServiceCard } from '../components/transport';
import { StoryTray } from '../components/stories';
import { PeopleToFollow } from '../components/growth';
import { ActiveMoves, DriversNearYou, HowStrip, MoveHero, NewMemberCard, ShopStrip } from '../components/movehome';
import { Icon } from '../components/Icon';

const tabs = (): [string, string][] => [['for_you', t('home.for_you')], ['following', t('home.following')], ['nearby', t('home.nearby')], ['circles', t('home.circles')]];

function Greeting({ name, city }: { name: string; city: string | null }) {
  const h = new Date().getHours(); const key = h < 12 ? 'home.good_morning' : h < 18 ? 'home.good_afternoon' : 'home.good_evening';
  return <div className="greet"><div><small>{t(key)}</small><b>{name.split(' ')[0]}</b></div>{city && <Link to="/settings" className="locchip"><Icon name="pin" />{city}</Link>}</div>;
}

export function Home() {
  const { me } = useAuth(); const nav = useNavigate(); const qc = useQueryClient(); useLocale();
  const [tab, setTab] = useState('for_you'); const [city, setCity] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['feed', tab, city, me?.id], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api('/feed', { query: { tab, cursor: pageParam, city: !me || tab === 'nearby' ? city : undefined } }),
    getNextPageParam: (l) => l.next_cursor ?? undefined, enabled: !((tab === 'following' || tab === 'circles') && !me),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <main className="main">
      {me ? <><Greeting name={me.display_name} city={me.city} /><MoveHero /><NewMemberCard /><ActiveMoves /><DriversNearYou /><ShopStrip /></> : <><MoveHero guest /><HowStrip /><ShopStrip /></>}
      <div className="secrow"><h2 className="sec">{t('home.community')}</h2><span className="shortcuts"><Link to="/clips" className="more">Clips</Link><Link to="/search" className="more">People</Link></span></div>
      <div className="tabs" role="tablist" aria-label="Feed">{tabs().map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {me && <StoryTray />}
      {me && tab === 'for_you' && <PeopleToFollow />}
      {tab === 'circles' && <div className="row" style={{ padding: '0 16px 12px' }}><Link className="btn sm soft" to="/circles">My circles &amp; discover</Link><Link className="btn sm ghost" to="/create/circle">Start a circle</Link></div>}
      {!me && <div className="card pad" style={{ margin: '0 16px 12px' }}><b>{t('home.join_title')}</b><div className="muted sm" style={{ margin: '4px 0 10px' }}>{t('home.join_text')}</div><Link to="/login" className="btn sm">{t('home.join_cta')}</Link></div>}
      {tab === 'nearby' && (!me || q.isError) && <div className="row" style={{ padding: '0 16px 12px' }}><input className="input" aria-label="City" placeholder="Enter a city, e.g. Calgary" value={city} onChange={(e) => setCity(e.target.value)} /></div>}
      {(tab === 'following' || tab === 'circles') && !me ? <State kind="empty" title="Sign in to see this feed" action={<Link className="btn" to="/login">Sign in</Link>} />
        : q.isLoading ? <State kind="loading" />
        : q.isError ? <State kind="error" title={tab === 'nearby' ? 'Where are you?' : undefined} text={(q.error as Error).message} />
        : items.length === 0 ? <State kind="empty" title={tab === 'following' ? 'Your feed is quiet' : tab === 'circles' ? 'No circle posts yet' : 'Nothing here yet'} text={tab === 'following' ? 'Follow people and businesses to see their posts and listings here.' : tab === 'circles' ? 'Join a circle to see its posts here.' : 'Be the first to post something.'} action={<div className="row" style={{ justifyContent: 'center' }}>{tab === 'circles' ? <Link className="btn" to="/circles">Discover circles</Link> : <><Link className="btn" to="/create/post">Create a post</Link><Link className="btn ghost" to="/search">Find people</Link></>}</div>} />
        : <>{items.map((it: any) => it.type === 'post' ? <PostCard key={`p${it.id}`} p={it} onRemoved={() => qc.invalidateQueries({ queryKey: ['feed'] })} /> : it.type === 'journey' ? <div key={`j${it.id}`} style={{ margin: '0 0 12px' }}><JourneyCard j={it} /></div> : it.type === 'transport_request' ? <div key={`r${it.id}`}><RequestCard r={it} /></div> : it.type === 'transport_service' ? <div key={`s${it.id}`}><ServiceCard s={it} /></div> : <FeedListing key={`l${it.id}`} l={it} />)}
          {q.hasNextPage && <div style={{ textAlign: 'center', padding: 16 }}><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>}</>}
      <span hidden>{nav.length}</span>
    </main>
  );
}

export function PostPage() {
  const { id } = useParams(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['post', id], queryFn: () => api(`/posts/${id}`) });
  return <main className="main">{q.isLoading ? <State kind="loading" /> : q.isError ? <State kind="empty" title="This post isn't available" text="It may have been removed or is private." action={<Link className="btn" to="/">Back home</Link>} /> : <PostCard p={q.data} onRemoved={() => nav('/')} />}</main>;
}
