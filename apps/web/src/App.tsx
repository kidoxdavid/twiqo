import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getAccessToken } from './api';
import { t, useLocale } from './i18n';
import { useAuth } from './auth';
import { Icon, Ticks } from './components/Icon';
import { Modal, State } from './components/ui';
import { AuthPage } from './pages/Auth';
import { Home, PostPage } from './pages/Home';
import { Market, ListingDetail } from './pages/Market';
import { CreateListing, CreatePost } from './pages/Create';
import { Profile, EditProfile, Saved, SearchPeople } from './pages/Profile';
import { Inbox, Thread, NewThread } from './pages/Chat';
import { Notifications } from './pages/Notifications';
import { Move, JourneyPage, RequestPage, ServicePage } from './pages/Move';
import { CreateRequest, CreateJourney, CreateService } from './pages/CreateTransport';
import { Offers, Bookings, BookingPage, OrderPage } from './pages/Deals';
import { CreateClip, CreateStory } from './pages/CreateMedia';

const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const Clips = lazy(() => import('./pages/Clips').then((m) => ({ default: m.Clips })));
const Circles = lazy(() => import('./pages/Circles').then((m) => ({ default: m.Circles })));
const CreateCircle = lazy(() => import('./pages/Circles').then((m) => ({ default: m.CreateCircle })));
const CirclePage = lazy(() => import('./pages/Circles').then((m) => ({ default: m.CirclePage })));
const PaymentsSettings = lazy(() => import('./pages/Payments').then((m) => ({ default: m.PaymentsSettings })));
const DisputePage = lazy(() => import('./pages/Payments').then((m) => ({ default: m.DisputePage })));
const BusinessPage = lazy(() => import('./pages/Business').then((m) => ({ default: m.BusinessPage })));
const CreateBusiness = lazy(() => import('./pages/Business').then((m) => ({ default: m.CreateBusiness })));
const InvitePage = lazy(() => import('./pages/Growth').then((m) => ({ default: m.InvitePage })));
const ProPage = lazy(() => import('./pages/Growth').then((m) => ({ default: m.ProPage })));
const SecurityPage = lazy(() => import('./pages/Account').then((m) => ({ default: m.SecurityPage })));
const VerifyEmailPage = lazy(() => import('./pages/Account').then((m) => ({ default: m.VerifyEmailPage })));
const ResetPasswordPage = lazy(() => import('./pages/Account').then((m) => ({ default: m.ResetPasswordPage })));
const SettingsHub = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsHub })));
const NotificationSettings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.NotificationSettings })));
const VerificationPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.VerificationPage })));
const SafetySettings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SafetySettings })));
const TripPage = lazy(() => import('./pages/Trip').then((m) => ({ default: m.TripPage })));
const LegalPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.LegalPage })));
const InsightsPage = lazy(() => import('./pages/Growth').then((m) => ({ default: m.InsightsPage })));

function CreateSheet({ onClose }: { onClose: () => void }) {
  useLocale();
  const items: [string, string, string, string, string?][] = [
    ['/create/post', t('create.post'), t('create.post.d'), 'img', 'var(--blue)'],
    ['/create/listing', t('create.sell'), t('create.sell.d'), 'bag', 'var(--amber)'],
    ['/create/clip', t('create.clip'), t('create.clip.d'), 'film', '#8E6CF5'],
    ['/create/story', t('create.story'), t('create.story.d'), 'camera', '#5B6784'],
    ['/create/post?poll=1', t('create.poll'), t('create.poll.d'), 'chat', '#2FA45F'],
    ['/create/circle', t('create.circle'), t('create.circle.d'), 'users', '#F76B6B'],
    ['/create/request', t('create.request'), t('create.request.d'), 'box', 'var(--teal)'],
    ['/create/journey', t('create.journey'), t('create.journey.d'), 'route', 'var(--navy)'],
    ['/create/service', t('create.service'), t('create.service.d'), 'truck', '#F76B6B'],
    ['/business/new', t('create.business'), t('create.business.d'), 'users', '#8E6CF5'],
  ];
  return (
    <Modal onClose={onClose} title={t('create.title')}>
      <div className="cg">
        {items.map(([to, t, d, ic, bg]) => <Link key={to} to={to} onClick={onClose}><span className="ic" style={{ background: bg }}><Icon name={ic} /></span>{t}<small>{d}</small></Link>)}
      </div>
    </Modal>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { me } = useAuth(); const { locale, setLocale } = useLocale();
  useEffect(() => {   // a device's own choice wins; a brand-new device adopts the saved account language
    if (!me) return; let stored: string | null = null; try { stored = localStorage.getItem('twiqo.locale'); } catch { /* storage unavailable */ }
    if (!stored && me.locale && me.locale !== locale) setLocale(me.locale); else if (stored && me.locale !== locale) setLocale(locale, true);
  }, [me?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
 const nav = useNavigate(); const qc = useQueryClient(); const loc = useLocation();
  const [create, setCreate] = useState(false); const [q, setQ] = useState('');
  const unread = useQuery({ queryKey: ['unread'], queryFn: () => api('/me/unread'), enabled: !!me, refetchInterval: 30_000 });
  useEffect(() => {
    if (!me) return;
    const t = getAccessToken(); if (!t) return;
    const es = new EventSource(`/api/events?token=${encodeURIComponent(t)}`);
    const bump = () => { qc.invalidateQueries({ queryKey: ['unread'] }); qc.invalidateQueries({ queryKey: ['convs'] }); qc.invalidateQueries({ queryKey: ['thread'] }); };
    es.addEventListener('message', bump); es.addEventListener('read', bump);
    return () => es.close();
  }, [me, qc]);
  const isAdmin = !!me?.permissions.length;
  return (
    <div className="app">
      <header className="top"><div className="in">
        <Link to="/" className="brand"><Ticks />twiqo</Link>
        <nav className="navwrap" aria-label="Main">
          <div className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="home" />{t('nav.home')}</NavLink>
            <NavLink to="/market" className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="bag" />{t('nav.market')}</NavLink>
            <a className="plus" href="#create" onClick={(e) => { e.preventDefault(); me ? setCreate(true) : nav('/login'); }}><span><Icon name="plus" /></span><span style={{ fontSize: 'inherit' }} className="lbl">{t('nav.create')}</span></a>
            <NavLink to="/move" className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="truck" />{t('nav.move')}</NavLink>
            <NavLink to={me ? `/u/${me.username}` : '/login'} className={({ isActive }) => (isActive && loc.pathname.startsWith('/u/') ? 'active' : '')}><Icon name="user" />{me ? t('nav.me') : t('nav.signin')}</NavLink>
          </div>
        </nav>
        <form className="searchbox" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/market?q=${encodeURIComponent(q.trim())}`); }}>
          <Icon name="search" /><input aria-label={t('nav.search_aria')} placeholder={t('nav.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="row" style={{ gap: 2 }}>
          <Link to="/clips" className="iconbtn" aria-label="Clips"><Icon name="film" /></Link>
          <Link to="/search" className="iconbtn" aria-label="Find people"><Icon name="users" /></Link>
          {me && <><Link to="/messages" className="iconbtn" aria-label="Messages"><Icon name="chat" />{unread.data?.messages > 0 && <span className="badge">{unread.data.messages}</span>}</Link>
            <Link to="/notifications" className="iconbtn" aria-label="Notifications"><Icon name="bell" />{unread.data?.notifications > 0 && <span className="badge">{unread.data.notifications}</span>}</Link>
            {isAdmin && <Link to="/admin" className="iconbtn" aria-label="Admin"><Icon name="gear" /></Link>}</>}
        </div>
      </div></header>
      {children}
      <footer className="row wrap sm muted" style={{ justifyContent: 'center', gap: 14, padding: '18px 16px 90px' }}><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link><Link to="/legal/guidelines">Guidelines</Link><Link to="/legal/refunds">Refunds</Link><Link to="/legal/prohibited">Prohibited items</Link></footer>
      {create && <CreateSheet onClose={() => setCreate(false)} />}
    </div>
  );
}

function Private({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <State kind="loading" />;
  return me ? <>{children}</> : <Navigate to="/login" replace />;
}

export function App() {
  const { loading } = useAuth();
  if (loading) return <div className="state" style={{ paddingTop: 120 }}><Ticks w={64} /></div>;
  return (
    <Suspense fallback={<div className="state" style={{ paddingTop: 120 }}><Ticks w={64} /></div>}>
    <Routes>
      <Route path="/login" element={<AuthPage />} />
      <Route path="/trip/:token" element={<TripPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/clips" element={<Clips />} />
      <Route path="*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/post/:id" element={<PostPage />} />
            <Route path="/market" element={<Market />} />
            <Route path="/l/:id" element={<ListingDetail />} />
            <Route path="/create/post" element={<Private><CreatePost /></Private>} />
            <Route path="/create/listing" element={<Private><CreateListing /></Private>} />
            <Route path="/circles" element={<Circles />} />
            <Route path="/c/:slug" element={<CirclePage />} />
            <Route path="/create/circle" element={<Private><CreateCircle /></Private>} />
            <Route path="/create/clip" element={<Private><CreateClip /></Private>} />
            <Route path="/create/story" element={<Private><CreateStory /></Private>} />
            <Route path="/move" element={<Move />} />
            <Route path="/j/:id" element={<JourneyPage />} />
            <Route path="/r/:id" element={<RequestPage />} />
            <Route path="/s/:id" element={<ServicePage />} />
            <Route path="/create/request" element={<Private><CreateRequest /></Private>} />
            <Route path="/create/journey" element={<Private><CreateJourney /></Private>} />
            <Route path="/create/service" element={<Private><CreateService /></Private>} />
            <Route path="/offers" element={<Private><Offers /></Private>} />
            <Route path="/bookings" element={<Private><Bookings /></Private>} />
            <Route path="/bookings/:id" element={<Private><BookingPage /></Private>} />
            <Route path="/orders/:id" element={<Private><OrderPage /></Private>} />
            <Route path="/u/:username" element={<Profile />} />
            <Route path="/settings" element={<Private><SettingsHub /></Private>} />
            <Route path="/settings/security" element={<Private><SecurityPage /></Private>} />
            <Route path="/settings/notifications" element={<Private><NotificationSettings /></Private>} />
            <Route path="/settings/verification" element={<Private><VerificationPage /></Private>} />
            <Route path="/settings/safety" element={<Private><SafetySettings /></Private>} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />
            <Route path="/legal/:doc" element={<LegalPage />} />
            <Route path="/settings/invite" element={<Private><InvitePage /></Private>} />
            <Route path="/settings/pro" element={<Private><ProPage /></Private>} />
            <Route path="/insights" element={<Private><InsightsPage /></Private>} />
            <Route path="/settings/payments" element={<Private><PaymentsSettings /></Private>} />
            <Route path="/disputes/:id" element={<Private><DisputePage /></Private>} />
            <Route path="/settings/profile" element={<Private><EditProfile /></Private>} />
            <Route path="/saved" element={<Private><Saved /></Private>} />
            <Route path="/search" element={<SearchPeople />} />
            <Route path="/b/:slug" element={<BusinessPage />} />
            <Route path="/business/new" element={<Private><CreateBusiness /></Private>} />
            <Route path="/messages" element={<Private><Inbox /></Private>} />
            <Route path="/messages/new" element={<Private><NewThread /></Private>} />
            <Route path="/messages/:id" element={<Private><Thread /></Private>} />
            <Route path="/notifications" element={<Private><Notifications /></Private>} />
            <Route path="/admin/*" element={<Private><Admin /></Private>} />
            <Route path="*" element={<main className="main"><State kind="empty" title="Page not found" action={<Link className="btn" to="/">Back home</Link>} /></main>} />
          </Routes>
        </Shell>
      } />
    </Routes>
    </Suspense>
  );
}
