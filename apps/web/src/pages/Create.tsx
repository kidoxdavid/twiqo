import { PriceHint } from '../components/tools';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { ImageUploader, errMsg, type Uploaded } from '../components/ui';
import { ApiError } from '../api';

function useBusinesses() { return useQuery({ queryKey: ['mybiz'], queryFn: () => api('/me/businesses') }); }

export function CreatePost() {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const { me } = useAuth(); const [sp] = useSearchParams();
  const biz = useBusinesses();
  const circles = useQuery({ queryKey: ['mycircles'], queryFn: () => api('/circles', { query: { mine: 1, limit: 50 } }) });
  const joined = (circles.data?.items ?? []).filter((c: any) => c.viewer?.status === 'active');
  const [poll, setPoll] = useState(sp.get('poll') === '1'); const [options, setOptions] = useState(['', '']); const [hours, setHours] = useState(24);
  const [body, setBody] = useState(''); const [media, setMedia] = useState<Uploaded[]>([]); const [vis, setVis] = useState('public'); const [asBiz, setAsBiz] = useState(''); const [circle, setCircle] = useState(sp.get('circle') ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const opts = options.map((o) => o.trim()).filter(Boolean);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api('/posts', { body: poll
        ? { kind: 'poll', body: body.trim(), poll: { options: opts, closes_in_hours: hours }, visibility: vis, business_id: asBiz || undefined, group_id: circle || undefined }
        : { kind: media.length ? 'photo' : 'text', body: body.trim() || undefined, media_ids: media.map((m) => m.id), visibility: vis, business_id: asBiz || undefined, group_id: circle || undefined } });
      qc.invalidateQueries({ queryKey: ['feed'] }); qc.invalidateQueries({ queryKey: ['cposts'] }); toast('Posted!'); nav(circle ? `/c/${joined.find((c: any) => c.id === circle)?.slug ?? ''}` : '/');
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <main className="main"><h1 className="page">{poll ? 'New poll' : 'New post'}</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={submit}>
        <div className="field"><label htmlFor="b">{poll ? 'Your question' : `What's happening${me ? `, ${me.display_name.split(' ')[0]}` : ''}?`}</label><textarea id="b" className="input" maxLength={poll ? 280 : 5000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={poll ? 'Ask your community something…' : 'Share something with your community…'} /></div>
        {poll ? <div className="col" style={{ gap: 8 }}>
          {options.map((o, i) => <div key={i} className="row"><input className="input" aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} maxLength={80} value={o} onChange={(e) => setOptions(options.map((x, k) => (k === i ? e.target.value : x)))} />{options.length > 2 && <button type="button" className="btn soft sm" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, k) => k !== i))}>✕</button>}</div>)}
          {options.length < 6 && <button type="button" className="btn soft sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOptions([...options, ''])}>+ Add option</button>}
          <div className="field"><label htmlFor="ph">Poll closes after</label><select id="ph" className="input" value={hours} onChange={(e) => setHours(+e.target.value)}>{[[1, '1 hour'], [24, '1 day'], [72, '3 days'], [168, '1 week'], [720, '30 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div></div>
          : <div className="field"><label>Photos</label><ImageUploader value={media} onChange={setMedia} max={10} /></div>}
        <div className="row wrap">
          {joined.length > 0 && <div className="field" style={{ flex: 1, minWidth: 160 }}><label htmlFor="ci">Post in</label><select id="ci" className="input" value={circle} onChange={(e) => setCircle(e.target.value)}><option value="">My profile</option>{joined.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
          {!circle && <div className="field" style={{ flex: 1, minWidth: 160 }}><label htmlFor="v">Who can see this?</label><select id="v" className="input" value={vis} onChange={(e) => setVis(e.target.value)}><option value="public">Everyone</option><option value="followers">Followers</option><option value="private">Only me</option></select></div>}
          {!circle && biz.data?.items.length > 0 && <div className="field" style={{ flex: 1, minWidth: 160 }}><label htmlFor="as">Post as</label><select id="as" className="input" value={asBiz} onChange={(e) => setAsBiz(e.target.value)}><option value="">Me</option>{biz.data.items.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>}
        </div>
        <label className="row sm"><input type="checkbox" checked={poll} onChange={(e) => setPoll(e.target.checked)} /> Make this a poll</label>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy || (poll ? !body.trim() || opts.length < 2 : !body.trim() && !media.length)}>{busy ? 'Posting…' : 'Post'}</button>
      </form>
    </main>
  );
}

export function CreateListing() {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const { me } = useAuth();
  const cats = useQuery({ queryKey: ['cats'], queryFn: () => api('/categories'), staleTime: 300_000 });
  const biz = useBusinesses();
  const [f, setF] = useState({ title: '', description: '', category_id: '', price: '', price_type: 'negotiable', condition: 'good', quantity: '1', city: me?.city ?? '', tags: '', pickup: true, delivery: false, shipping: false, business_id: '' });
  const [media, setMedia] = useState<Uploaded[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [fe, setFe] = useState<Record<string, string>>({});
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFe({});
    try {
      const l = await api('/listings', { body: {
        title: f.title.trim(), description: f.description, category_id: f.category_id, price_type: f.price_type, price_cents: f.price_type === 'free' ? 0 : Math.round(Number(f.price) * 100) || 0,
        condition: f.condition, quantity: Math.max(1, parseInt(f.quantity) || 1), city: f.city || undefined, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10),
        fulfillment: { pickup: f.pickup, delivery: f.delivery, shipping: f.shipping }, media_ids: media.map((m) => m.id), business_id: f.business_id || undefined } });
      qc.invalidateQueries({ queryKey: ['listings'] }); qc.invalidateQueries({ queryKey: ['feed'] });
      toast(l.status === 'pending_review' ? 'Submitted — it will go live after a quick review.' : 'Your listing is live!'); nav(`/l/${l.id}`);
    } catch (x) { if (x instanceof ApiError && x.details) setFe(Object.fromEntries(x.details.map((d) => [d.path, d.message]))); setErr(errMsg(x)); setBusy(false); }
  }
  const cat = cats.data?.items.flatMap((c: any) => [c, ...c.children]).find((c: any) => c.id === f.category_id);
  return (
    <main className="main"><h1 className="page">Sell something</h1>
      <form className="card pad col" style={{ margin: '0 16px' }} onSubmit={submit}>
        <div className="field"><label>Photos</label><ImageUploader value={media} onChange={setMedia} max={10} /><span className="muted sm">Listings with clear photos sell faster. Location data in photos is removed.</span></div>
        <div className="field"><label htmlFor="t">Title</label><input id="t" className="input" value={f.title} maxLength={120} onChange={(e) => set('title', e.target.value)} required />{fe.title && <span className="err">{fe.title}</span>}</div>
        <div className="field"><label htmlFor="c">Category</label><select id="c" className="input" value={f.category_id} onChange={(e) => set('category_id', e.target.value)} required><option value="">Choose…</option>{cats.data?.items.map((c: any) => <optgroup key={c.id} label={c.name}><option value={c.id}>All {c.name}</option>{c.children.map((k: any) => <option key={k.id} value={k.id}>{k.name}</option>)}</optgroup>)}</select>
          {cat?.is_restricted && <span className="pill a" style={{ alignSelf: 'flex-start' }}>Listings in this category are reviewed before going live</span>}</div>
        <div className="row wrap">
          <div className="field" style={{ flex: 1 }}><label htmlFor="pt">Price</label><select id="pt" className="input" value={f.price_type} onChange={(e) => set('price_type', e.target.value)}><option value="negotiable">Negotiable</option><option value="fixed">Fixed price</option><option value="free">Free</option></select></div>
          {f.price_type !== 'free' && <div className="field" style={{ flex: 1 }}><label htmlFor="p">Amount (CAD)</label><input id="p" className="input" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} required /></div>}
        </div>
        {f.price_type !== 'free' && <PriceHint path="/listings/price-guidance" query={{ category_id: f.category_id, condition: f.condition }} />}
        <div className="row wrap">
          <div className="field" style={{ flex: 1 }}><label htmlFor="cn">Condition</label><select id="cn" className="input" value={f.condition} onChange={(e) => set('condition', e.target.value)}><option value="new">New</option><option value="like_new">Like new</option><option value="good">Good</option><option value="fair">Fair</option><option value="for_parts">For parts</option></select></div>
          <div className="field" style={{ width: 110 }}><label htmlFor="q">Quantity</label><input id="q" className="input" inputMode="numeric" value={f.quantity} onChange={(e) => set('quantity', e.target.value.replace(/\D/g, ''))} /></div>
        </div>
        <div className="field"><label htmlFor="d">Description</label><textarea id="d" className="input" value={f.description} maxLength={8000} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="field"><label htmlFor="ci">City</label><input id="ci" className="input" value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="Where is the item?" /><span className="muted sm">Buyers only see your city, never your address.</span></div>
        <div className="field"><label htmlFor="tg">Tags (comma separated)</label><input id="tg" className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="sofa, grey, living room" /></div>
        <fieldset className="row wrap" style={{ border: 'none' }}><legend style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>How can buyers get it?</legend>
          {([['pickup', 'Pickup'], ['delivery', 'Delivery available'], ['shipping', 'Shipping']] as const).map(([k, l]) => <label key={k} className="chip" style={{ cursor: 'pointer', ...(f[k] ? { background: 'var(--navy)', color: '#fff' } : {}) }}><input type="checkbox" hidden checked={f[k]} onChange={(e) => set(k, e.target.checked)} />{l}</label>)}</fieldset>
        {biz.data?.items.length > 0 && <div className="field"><label htmlFor="bz">Sell as</label><select id="bz" className="input" value={f.business_id} onChange={(e) => set('business_id', e.target.value)}><option value="">Me</option>{biz.data.items.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>}
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Publishing…' : 'Publish listing'}</button>
      </form>
    </main>
  );
}
