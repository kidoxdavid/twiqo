import { describe, expect, it } from 'vitest';
import { api, auth, makeCategory, makeCircle, makeJourney, makeListing, makeRequest, makeService, makeUser, PNG } from './helpers.js';

/** Regression: Zod 4 `.partial()` keeps defaults, so a PATCH with one field used to reset the others. */
describe('PATCH only changes the fields you send', () => {
  it('listing: price edit keeps condition, quantity, tags, description, fulfilment and photos', async () => {
    const u = await makeUser('pl'); const cat = await makeCategory();
    const img = (await api().post('/api/media').set(auth(u)).attach('file', PNG, 'a.png')).body;
    const l = await makeListing(u, cat, { title: 'Patch me', description: 'A very specific description', condition: 'like_new', quantity: 4, tags: ['keep', 'these'], price_type: 'negotiable', fulfillment: { pickup: true, delivery: true, shipping: false }, media_ids: [img.id] });
    const r = await api().patch(`/api/listings/${l.id}`).set(auth(u)).send({ price_cents: 12345 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ price_cents: 12345, condition: 'like_new', quantity: 4, price_type: 'negotiable', tags: ['keep', 'these'] });
    expect(r.body.fulfillment).toEqual({ pickup: true, delivery: true, shipping: false });
    expect(r.body.images).toHaveLength(1);
    expect((await api().get(`/api/listings/${l.id}`)).body.description).toBe('A very specific description');
  });

  it('transport request: editing the budget does not make a private request public', async () => {
    const u = await makeUser('pr'); const other = await makeUser('po');
    const r = await makeRequest(u, { visibility: 'private', description: 'keep this text', preferred_vehicles: ['pickup_truck'], needs_loading_help: true });
    const p = await api().patch(`/api/transport/requests/${r.id}`).set(auth(u)).send({ budget_cents: 5000 });
    expect(p.body).toMatchObject({ budget_cents: 5000, visibility: 'private', description: 'keep this text', needs_loading_help: true, preferred_vehicles: ['pickup_truck'] });
    expect((await api().get(`/api/transport/requests/${r.id}`).set(auth(other))).status).toBe(404);
  });

  it('journey and service: a price edit keeps everything else', async () => {
    const u = await makeUser('pj');
    const j = await makeJourney(u, { description: 'Stays', max_detour_km: 40, helps_loading: true, item_restrictions: ['tires'], price_type: 'fixed' });
    const jp = (await api().patch(`/api/transport/journeys/${j.id}`).set(auth(u)).send({ price_cents: 7777 })).body;
    expect(jp).toMatchObject({ price_cents: 7777, description: 'Stays', max_detour_km: 40, helps_loading: true, item_restrictions: ['tires'], price_type: 'fixed' });
    const s = await makeService(u, { description: 'Stays too', intercity: true, price_type: 'fixed' });
    const sp = (await api().patch(`/api/transport/services/${s.id}`).set(auth(u)).send({ price_cents: 9999 })).body;
    expect(sp).toMatchObject({ price_cents: 9999, description: 'Stays too', intercity: true, price_type: 'fixed' });
  });

  it('circle: changing the rules keeps visibility, join policy and posting rules', async () => {
    const o = await makeUser('pc'); const c = await makeCircle(o, { visibility: 'private', who_can_post: 'moderators', allow_commerce: false, description: 'Stay put' });
    const r = (await api().patch(`/api/circles/${c.slug}`).set(auth(o)).send({ rules: 'New rules' })).body;
    expect(r).toMatchObject({ rules: 'New rules', visibility: 'private', join_policy: 'approval', who_can_post: 'moderators', allow_commerce: false, description: 'Stay put' });
  });
});
