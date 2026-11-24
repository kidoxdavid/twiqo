import { BulkUpload } from '../components/tools';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ListingCard, useRequireAuth } from '../components/cards';
import { useToast } from '../components/Toast';
import { Avatar, State, Verified, errMsg } from '../components/ui';

const ROLES: [string, string][] = [['manager', 'Manager'], ['listing_manager', 'Listing manager'], ['customer_support', 'Customer support'], ['delivery_coordinator', 'Delivery coordinator']];

export function BusinessPage() {
  const { slug } = useParams(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const guard = useRequireAuth();
  const b = useQuery({ queryKey: ['biz', slug], queryFn: () => api(`/businesses/${slug}`) });
  const listings = useQuery({ queryKey: ['bizlist', b.data?.id], enabled: !!b.data, queryFn: async () => (await api('/listings', { query: { business: slug, limit: 50 } })).items });
  const team = useQuery({ queryKey: ['team', b.data?.id], enabled: !!b.data?.viewer.role, queryFn: () => api(`/businesses/${b.data.id}/members`) });
  const [member, setMember] = useState(''); const [role, setRole] = useState('listing_manager');
  if (b.isLoading) return <main className="main"><State kind="loading" /></main>;
  if (b.isError) return <main className="main"><State kind="empty" title="Business not found" action={<Link className="btn" to="/">Back home</Link>} /></main>;
  const x = b.data; const canTeam = ['owner', 'manager'].includes(x.viewer.role);
  return (
    <main className="main">
      <div className="cover" style={x.cover_url ? { backgroundImage: `url(${x.cover_url})` } : undefined} />
      <div className="phead">
        <div style={{ border: '4px solid #fff', borderRadius: '50%', width: 92, height: 92, background: '#fff' }}><Avatar user={{ display_name: x.name, avatar_url: x.logo_url }} size={84} /></div>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.4, marginTop: 8 }}>{x.name} {x.verification_status === 'verified' && <Verified />}</h1>
        <div className="muted sm">{x.category ?? 'Business'}{x.city ? ` · ${x.city}, ${x.province}` : ''}{x.service_radius_km ? ` · serves ${x.service_radius_km} km` : ''}</div>
        {x.description && <p style={{ margin: '10px 0', lineHeight: 1.5 }}>{x.description}</p>}
        <div className="stats"><div className="stat"><b>{x.follower_count}</b><span>Followers</span></div><div className="stat"><b>{x.listing_count}</b><span>Products</span></div></div>
        <div className="row wrap">{x.viewer.role ? <><Link className="btn" to="/create/listing">Add a product</Link>{['owner', 'manager', 'listing_manager'].includes(x.viewer.role) && <BulkUpload businessId={x.id} />}<span className="pill b">You are {x.viewer.role.replace('_', ' ')}</span></> :
          <button className={`btn ${x.viewer.following ? 'soft' : ''}`} style={{ flex: 1 }} onClick={() => guard(async () => { try { await api(`/follows/business/${x.id}`, { method: x.viewer.following ? 'DELETE' : 'POST' }); qc.invalidateQueries({ queryKey: ['biz'] }); } catch (e) { toast(errMsg(e), 'err'); } })}>{x.viewer.following ? 'Following' : 'Follow'}</button>}
          {x.contact_email && <a className="btn ghost" href={`mailto:${x.contact_email}`}>Contact</a>}</div>
      </div>
      <h2 className="sec" style={{ padding: '18px 16px 0' }}>Storefront</h2>
      {listings.isLoading ? <State kind="loading" /> : listings.data?.length ? <div className="grid">{listings.data.map((l: any) => <ListingCard key={l.id} l={l} />)}</div> : <State kind="empty" title="No products yet" />}
      {x.viewer.role && <>
        <h2 className="sec" style={{ padding: '18px 16px 0' }}>Team</h2>
        <div className="card" style={{ margin: '0 16px' }}>
          {team.data?.items.map((m: any) => <div key={m.id} className="row pad"><Avatar user={m} size={34} /><div><b>{m.display_name}</b><div className="muted sm">@{m.username}</div></div><span className="sp" /><span className="pill">{m.role.replace('_', ' ')}</span>
            {canTeam && m.role !== 'owner' && <button className="btn sm soft" onClick={async () => { try { await api(`/businesses/${x.id}/members/${m.username}`, { method: 'DELETE' }); team.refetch(); } catch (e) { toast(errMsg(e), 'err'); } }}>Remove</button>}</div>)}
          {canTeam && <form className="row pad wrap" onSubmit={async (e) => { e.preventDefault(); try { await api(`/businesses/${x.id}/members/${member.replace(/^@/, '')}`, { method: 'PUT', body: { role } }); setMember(''); team.refetch(); toast('Team updated'); } catch (er) { toast(errMsg(er), 'err'); } }}>
            <input className="input" style={{ flex: 1, minWidth: 140 }} aria-label="Username" placeholder="Username to add" value={member} onChange={(e) => setMember(e.target.value)} required />
            <select className="input" style={{ width: 'auto' }} aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><button className="btn">Add</button></form>}
        </div></>}
      <span hidden>{nav.length}</span>
    </main>
  );
}

export function CreateBusiness() {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = useState({ name: '', slug: '', category: '', city: '', description: '', contact_email: '' }); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value, ...(k === 'name' && !f.slug ? { slug: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) } : {}) });
  return (
    <main className="main"><h1 className="page">Create a business page</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { const b = await api('/businesses', { body: { name: f.name, slug: f.slug, category: f.category || undefined, city: f.city || undefined, description: f.description || undefined, contact_email: f.contact_email || undefined } }); qc.invalidateQueries({ queryKey: ['mybiz'] }); toast('Business created'); nav(`/b/${b.slug}`); } catch (x) { setErr(errMsg(x)); setBusy(false); } }}>
        <div className="field"><label htmlFor="n">Business name</label><input id="n" className="input" value={f.name} onChange={set('name')} required minLength={2} /></div>
        <div className="field"><label htmlFor="s">Page URL</label><input id="s" className="input" value={f.slug} onChange={set('slug')} required pattern="[a-z0-9-]{3,40}" /><span className="muted sm">twiqo.com/b/{f.slug || 'your-business'}</span></div>
        <div className="field"><label htmlFor="c">Category</label><input id="c" className="input" value={f.category} onChange={set('category')} placeholder="e.g. Furniture store" /></div>
        <div className="field"><label htmlFor="ci">City</label><input id="ci" className="input" value={f.city} onChange={set('city')} /></div>
        <div className="field"><label htmlFor="e">Contact email</label><input id="e" type="email" className="input" value={f.contact_email} onChange={set('contact_email')} /></div>
        <div className="field"><label htmlFor="d">About</label><textarea id="d" className="input" value={f.description} onChange={set('description')} /></div>
        <div className="muted sm">Verification badges are granted by twiqo after review.</div>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create page'}</button>
      </form>
    </main>
  );
}
