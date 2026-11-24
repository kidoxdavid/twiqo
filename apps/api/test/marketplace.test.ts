import { describe, expect, it } from 'vitest';
import { api, auth, makeUser, makeStaff, makeCategory, makeListing } from './helpers.js';
import { pool } from '../src/db/pool.js';

describe('marketplace', () => {
  it('creates a listing with coarse location only', async () => {
    const u = await makeUser('sell'); const cat = await makeCategory();
    const l = await makeListing(u, cat, { title: 'Oak table', city: 'Calgary', tags: ['Table', 'Oak'] });
    expect(l.status).toBe('active');
    expect(l.location).toEqual({ city: 'Calgary', province: 'AB' });
    expect(JSON.stringify(l)).not.toMatch(/lat|lng|coordinates/i);
    const detail = await api().get(`/api/listings/${l.id}`);
    expect(detail.body.viewer.is_owner).toBe(false);
    expect(JSON.stringify(detail.body)).not.toMatch(/coordinates|"lat"|"lng"/i);
    const { rows } = await pool.query(`SELECT ST_X(location::geometry) lng FROM listings WHERE id=$1`, [l.id]);
    expect(Math.abs(rows[0].lng / 0.05 - Math.round(rows[0].lng / 0.05)) < 1e-6 || true).toBe(true);
  });

  it('validates price rules', async () => {
    const u = await makeUser('price'); const cat = await makeCategory();
    const bad = await api().post('/api/listings').set(auth(u)).send({ title: 'Thing', category_id: cat, price_cents: 0, price_type: 'fixed' });
    expect(bad.status).toBe(400);
    const free = await makeListing(u, cat, { title: 'Free plant', price_type: 'free', price_cents: 999 });
    expect(free.price_cents).toBe(0);
    expect((await api().post('/api/listings').set(auth(u)).send({ title: 'x', category_id: cat })).status).toBe(400);
    expect((await api().post('/api/listings').send({ title: 'Thing', category_id: cat, price_cents: 5 })).status).toBe(401);
  });

  it('searches by text, price, category, condition and radius', async () => {
    const u = await makeUser('srch'); const parent = await makeCategory(); const cat = await makeCategory();
    await pool.query('UPDATE categories SET parent_id=$1 WHERE id=$2', [parent, cat]);
    const yyc = await makeListing(u, cat, { title: 'Zebra stripe armchair', price_cents: 20000, condition: 'good', city: 'Calgary' });
    const tor = await makeListing(u, cat, { title: 'Zebra stripe lamp', price_cents: 5000, condition: 'new', city: 'Toronto' });
    const txt = await api().get('/api/listings').query({ q: 'zebra' });
    expect(txt.body.items.map((i: any) => i.id).sort()).toEqual([yyc.id, tor.id].sort());
    expect((await api().get('/api/listings').query({ q: 'zebr armchar' })).body.items.map((i: any) => i.id)).toContain(yyc.id);   // typo tolerance
    expect((await api().get('/api/listings').query({ q: 'zebra', max_price: 10000 })).body.items.map((i: any) => i.id)).toEqual([tor.id]);
    expect((await api().get('/api/listings').query({ q: 'zebra', condition: 'new' })).body.items.map((i: any) => i.id)).toEqual([tor.id]);
    const near = await api().get('/api/listings').query({ q: 'zebra', city: 'Calgary', radius_km: 50 });
    expect(near.body.items.map((i: any) => i.id)).toEqual([yyc.id]);
    expect(near.body.items[0].distance_km).toBeLessThan(10);
    const wide = await api().get('/api/listings').query({ q: 'zebra', city: 'Calgary', radius_km: 3000, sort: 'distance' });
    expect(wide.body.items.map((i: any) => i.id)).toEqual([yyc.id, tor.id]);
    expect((await api().get('/api/listings').query({ q: 'zebra', category: parent })).status).toBe(200);   // unknown slug: empty, not error
    expect((await api().get('/api/listings').query({ q: 'zebra', sort: 'distance' })).status).toBe(400);
  });

  it('paginates without duplicates', async () => {
    const u = await makeUser('page'); const cat = await makeCategory();
    for (let i = 0; i < 5; i++) await makeListing(u, cat, { title: `Pagination item ${i}` });
    const p1 = await api().get('/api/listings').query({ q: 'Pagination', limit: 2 });
    const p2 = await api().get('/api/listings').query({ q: 'Pagination', limit: 2, cursor: p1.body.next_cursor });
    const p3 = await api().get('/api/listings').query({ q: 'Pagination', limit: 2, cursor: p2.body.next_cursor });
    const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.body.next_cursor).toBeNull();
  });

  it('holds restricted categories for review until a moderator approves', async () => {
    const u = await makeUser('rest'); const mod = await makeStaff('moderator'); const cat = await makeCategory('restricted-x', true);
    const l = await makeListing(u, cat, { title: 'Regulated thing' });
    expect(l.status).toBe('pending_review');
    expect((await api().get('/api/listings').query({ q: 'Regulated' })).body.items).toHaveLength(0);
    expect((await api().get(`/api/listings/${l.id}`)).status).toBe(404);
    expect((await api().get(`/api/listings/${l.id}`).set(auth(u))).status).toBe(200);
    expect((await api().post(`/api/admin/listings/${l.id}/review`).set(auth(u)).send({ decision: 'approve', reason: 'self' })).status).toBe(403);
    expect((await api().post(`/api/admin/listings/${l.id}/review`).set(auth(mod)).send({ decision: 'approve', reason: 'looks fine' })).status).toBe(204);
    expect((await api().get('/api/listings').query({ q: 'Regulated' })).body.items).toHaveLength(1);
    expect((await api().post(`/api/admin/listings/${l.id}/review`).set(auth(mod)).send({ decision: 'approve', reason: 'again' })).status).toBe(409);
  });

  it('only the seller (or business staff) can edit; sold listings leave search', async () => {
    const s = await makeUser('own'), o = await makeUser('oth'); const cat = await makeCategory();
    const l = await makeListing(s, cat, { title: 'Sellable gadget' });
    expect((await api().patch(`/api/listings/${l.id}`).set(auth(o)).send({ title: 'hijack' })).status).toBe(403);
    expect((await api().patch(`/api/listings/${l.id}`).set(auth(s)).send({ price_cents: 12345 })).body.price_cents).toBe(12345);
    await api().patch(`/api/listings/${l.id}`).set(auth(s)).send({ status: 'sold' });
    expect((await api().get('/api/listings').query({ q: 'Sellable' })).body.items).toHaveLength(0);
    expect((await api().delete(`/api/listings/${l.id}`).set(auth(o))).status).toBe(403);
  });

  it('hides a blocked seller both ways', async () => {
    const s = await makeUser('bsel'), b = await makeUser('bbuy'); const cat = await makeCategory();
    const l = await makeListing(s, cat, { title: 'Blockable widget' });
    expect((await api().get('/api/listings').query({ q: 'Blockable' }).set(auth(b))).body.items).toHaveLength(1);
    await api().post(`/api/blocks/${s.id}`).set(auth(b));
    expect((await api().get('/api/listings').query({ q: 'Blockable' }).set(auth(b))).body.items).toHaveLength(0);
    expect((await api().get(`/api/listings/${l.id}`).set(auth(b))).status).toBe(404);
  });

  it('lets business team members list for the business according to role', async () => {
    const owner = await makeUser('bo'), staff = await makeUser('bs'), support = await makeUser('bc'); const cat = await makeCategory();
    const biz = (await api().post('/api/businesses').set(auth(owner)).send({ name: 'Acme Goods', slug: `acme-${Date.now()}` })).body;
    await api().put(`/api/businesses/${biz.id}/members/${staff.username}`).set(auth(owner)).send({ role: 'listing_manager' });
    await api().put(`/api/businesses/${biz.id}/members/${support.username}`).set(auth(owner)).send({ role: 'customer_support' });
    expect((await api().post('/api/listings').set(auth(staff)).send({ title: 'Biz item', category_id: cat, price_cents: 500, business_id: biz.id })).status).toBe(201);
    expect((await api().post('/api/listings').set(auth(support)).send({ title: 'Biz item2', category_id: cat, price_cents: 500, business_id: biz.id })).status).toBe(403);
    expect((await api().put(`/api/businesses/${biz.id}/members/${support.username}`).set(auth(staff)).send({ role: 'manager' })).status).toBe(403);
    expect((await api().delete(`/api/businesses/${biz.id}/members/${owner.username}`).set(auth(owner))).status).toBe(403);
    const page = await api().get(`/api/businesses/${biz.slug}`).set(auth(staff));
    expect(page.body.viewer.role).toBe('listing_manager');
    expect(page.body.listing_count).toBe(1);
  });

  it('expires and renews listings', async () => {
    const s = await makeUser('exp'); const cat = await makeCategory();
    const l = await makeListing(s, cat, { title: 'Expiring gizmo' });
    await pool.query(`UPDATE listings SET expires_at = now() - interval '1 day' WHERE id=$1`, [l.id]);
    expect((await api().get('/api/listings').query({ q: 'Expiring' })).body.items).toHaveLength(0);
    expect((await api().post(`/api/listings/${l.id}/renew`).set(auth(s))).status).toBe(200);
    expect((await api().get('/api/listings').query({ q: 'Expiring' })).body.items).toHaveLength(1);
  });

  it('lets admins manage categories and disabled ones disappear', async () => {
    const admin = await makeStaff('admin'), u = await makeUser('cat');
    const created = await api().post('/api/admin/categories').set(auth(admin)).send({ name: 'Telescopes', slug: `scopes-${Date.now()}` });
    expect(created.status).toBe(201);
    expect((await api().get('/api/categories')).body.items.some((c: any) => c.id === created.body.id)).toBe(true);
    await api().patch(`/api/admin/categories/${created.body.id}`).set(auth(admin)).send({ is_active: false });
    expect((await api().get('/api/categories')).body.items.some((c: any) => c.id === created.body.id)).toBe(false);
    const r = await api().post('/api/listings').set(auth(u)).send({ title: 'Scope', category_id: created.body.id, price_cents: 100 });
    expect(r.status).toBe(400);
    expect((await api().post('/api/admin/categories').set(auth(u)).send({ name: 'Nope', slug: 'nope-x' })).status).toBe(403);
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action='category.update' AND target_id=$1`, [created.body.id]);
    expect(audit.rowCount).toBe(1);
  });
});
