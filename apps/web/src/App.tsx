import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getAccessToken } from './api';
import { useAuth } from './auth';
import { Icon, Ticks } from './components/Icon';
import { Modal, State } from './components/ui';
import { AuthPage } from './pages/Auth';
import { Home, PostPage } from './pages/Home';
import { Market, ListingDetail } from './pages/Market';
import { CreateListing, CreatePost } from './pages/Create';
import { Profile, EditProfile, Saved, SearchPeople } from './pages/Profile';
import { BusinessPage, CreateBusiness } from './pages/Business';
import { Inbox, Thread, NewThread } from './pages/Chat';
import { Notifications } from './pages/Notifications';
import { Move, JourneyPage, RequestPage, ServicePage } from './pages/Move';
import { CreateRequest, CreateJourney, CreateService } from './pages/CreateTransport';
import { Offers, Bookings, BookingPage, OrderPage } from './pages/Deals';
import { Admin } from './pages/Admin';
import { Clips } from './pages/Clips';
import { CreateClip, CreateStory } from './pages/CreateMedia';
import { Circles, CreateCircle, CirclePage } from './pages/Circles';

function CreateSheet({ onClose }: { onClose: () => void }) {
  const items: [string, string, string, string, string?][] = [
    ['/create/post', 'Post', 'Share a photo or thought', 'img', 'var(--blue)'],
    ['/create/listing', 'Sell something', 'List almost anything lawful', 'bag', 'var(--amber)'],
    ['/create/clip', 'Clip', 'Short vertical video', 'film', '#8E6CF5'],
    ['/create/story', 'Story', 'Gone in 24 hours', 'camera', '#5B6784'],
    ['/create/post?poll=1', 'Poll', 'Ask your community', 'chat', '#2FA45F'],
    ['/create/circle', 'Start a circle', 'Build a community', 'users', '#F76B6B'],
    ['/create/request', 'Find someone to move it', 'Post a transport request', 'box', 'var(--teal)'],
    ['/create/journey', 'Offer a journey', 'Earn on a trip you\'re making', 'route', 'var(--navy)'],
    ['/create/service', 'Offer a delivery service', 'Truck, van or courier', 'truck', '#F76B6B'],
    ['/business/new', 'Business page', 'Set up a storefront', 'users', '#8E6CF5'],
  ];
  return (
    <Modal onClose={onClose} title="What do you want to do?">
      <div className="cg">
        {items.map(([to, t, d, ic, bg]) => <Link key={to} to={to} onClick={onClose}><span className="ic" style={{ background: bg }}><Icon name={ic} /></span>{t}<small>{d}</small></Link>)}
      </div>
    </Modal>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { me } = useAuth(); const nav = useNavigate(); const qc = useQueryClient(); const loc = useLocation();
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
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="home" />Home</NavLink>
            <NavLink to="/market" className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="bag" />Market</NavLink>
            <a className="plus" href="#create" onClick={(e) => { e.preventDefault(); me ? setCreate(true) : nav('/login'); }}><span><Icon name="plus" /></span><span style={{ fontSize: 'inherit' }} className="lbl">Create</span></a>
            <NavLink to="/move" className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="truck" />Move</NavLink>
            <NavLink to={me ? `/u/${me.username}` : '/login'} className={({ isActive }) => (isActive && loc.pathname.startsWith('/u/') ? 'active' : '')}><Icon name="user" />{me ? 'Me' : 'Sign in'}</NavLink>
          </div>
        </nav>
        <form className="searchbox" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/market?q=${encodeURIComponent(q.trim())}`); }}>
          <Icon name="search" /><input aria-label="Search the market" placeholder="Search listings…" value={q} onChange={(e) => setQ(e.target.value)} />
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
    <Routes>
      <Route path="/login" element={<AuthPage />} />
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
  );
}
