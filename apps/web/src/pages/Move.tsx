import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function Move() {
  const steps: [string, string, string][] = [
    ['box', 'Need something moved?', 'Post what it is, where it\'s going and your budget. Drivers and movers send offers.'],
    ['route', 'Driving somewhere?', 'Publish a journey and earn from spare space in your vehicle — Toronto to Calgary, or across town.'],
    ['truck', 'Run a moving or delivery service?', 'List your truck, van or courier service and get bookings from your community.'],
  ];
  return (
    <main className="main"><h1 className="page">Move</h1>
      <div className="card pad" style={{ margin: '0 16px 16px', background: 'linear-gradient(135deg,#246BFD,#13B9B0)', color: '#fff' }}>
        <span className="pill" style={{ background: 'rgba(255,255,255,.2)', color: '#fff' }}>Coming in Phase 2</span>
        <h2 style={{ fontSize: 22, margin: '10px 0 6px', letterSpacing: -0.4 }}>TWIQO Move is on its way</h2>
        <div style={{ opacity: 0.9, lineHeight: 1.5 }}>Peer-to-peer transport, journeys and delivery with route matching, negotiation and PIN-confirmed pickup and delivery. Transport requests and journeys can't be posted yet.</div>
      </div>
      <div className="col" style={{ padding: '0 16px' }}>{steps.map(([ic, t, d]) => <div key={t} className="card pad row" style={{ alignItems: 'flex-start' }}><span style={{ width: 44, height: 44, borderRadius: 14, background: '#E1EBFF', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}><Icon name={ic} /></span><div><b>{t}</b><div className="muted" style={{ fontSize: 14, marginTop: 2 }}>{d}</div></div></div>)}</div>
      <div style={{ padding: 16 }} className="muted sm">In the meantime, sellers can already mark items as <i>delivery available</i> and message buyers to arrange it. <Link to="/market" style={{ color: 'var(--blue)', fontWeight: 700 }}>Browse the market →</Link></div>
    </main>
  );
}
