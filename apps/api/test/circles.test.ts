import { describe, expect, it } from 'vitest';
import { api, auth, iso, makeCategory, makeCircle, makeListing, makeStaff, makeUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';

const join = (u: any, slug: string) => api().post(`/api/circles/${slug}/join`).set(auth(u));
const post = (u: any, slug: string, body: Record<string, unknown>) => api().post('/api/posts').set(auth(u)).send({ body: 'hello circle', ...body, group_id: body.group_id });

describe('circles (acceptance F + G)', () => {
  it('creates a public circle, lets people join, and manages moderators', async () => {
    const owner = await makeUser('co'), a = await makeUser('ca'), b = await makeUser('cb');
    const c = await makeCircle(owner, { name: 'Calgary Furniture Marketplace', slug: `yyc-furniture-${Date.now()}` });
    expect(c.viewer).toEqual({ role: 'owner', status: 'active' }); expect(c.member_count).toBe(1);
    expect((await join(a, c.slug)).body.status).toBe('active'); expect((await join(a, c.slug)).body.status).toBe('active');   // idempotent
    await join(b, c.slug);
    expect((await api().get(`/api/circles/${c.slug}`)).body.member_count).toBe(3);
    // owner appoints an admin, admin appoints a moderator
    expect((await api().put(`/api/circles/${c.slug}/members/${a.username}/role`).set(auth(owner)).send({ role: 'admin' })).status).toBe(204);
    expect((await api().put(`/api/circles/${c.slug}/members/${b.username}/role`).set(auth(a)).send({ role: 'moderator' })).status).toBe(204);
    const members = (await api().get(`/api/circles/${c.slug}/members`)).body.items;
    expect(members.map((m: any) => `${m.username}:${m.role}`)).toEqual(expect.arrayContaining([`${owner.username}:owner`, `${a.username}:admin`, `${b.username}:moderator`]));
    // duplicate URL
    expect((await api().post('/api/circles').set(auth(owner)).send({ name: 'Another one', slug: c.slug })).status).toBe(409);
  });

  it('enforces the role hierarchy', async () => {
    const owner = await makeUser('ho'), admin = await makeUser('ha'), mod = await makeUser('hm'), mem = await makeUser('hx'), admin2 = await makeUser('hb');
    const c = await makeCircle(owner);
    for (const u of [admin, mod, mem, admin2]) await join(u, c.slug);
    const setRole = (as: any, who: any, role: string) => api().put(`/api/circles/${c.slug}/members/${who.username}/role`).set(auth(as)).send({ role });
    expect((await setRole(owner, admin, 'admin')).status).toBe(204); expect((await setRole(owner, admin2, 'admin')).status).toBe(204);
    expect((await setRole(admin, mod, 'admin')).status).toBe(403);          // only the owner appoints admins
    expect((await setRole(admin, mod, 'moderator')).status).toBe(204);
    expect((await setRole(mod, mem, 'moderator')).status).toBe(403);        // moderators cannot change roles
    expect((await setRole(admin, admin2, 'member')).status).toBe(403);      // cannot demote an equal
    expect((await setRole(admin, owner, 'member')).status).toBe(403);       // the owner role is untouchable
    expect((await api().patch(`/api/circles/${c.slug}`).set(auth(mod)).send({ rules: 'x' })).status).toBe(403);
    expect((await api().patch(`/api/circles/${c.slug}`).set(auth(admin)).send({ rules: 'Be kind. No spam.' })).body.rules).toBe('Be kind. No spam.');
    expect((await api().patch(`/api/circles/${c.slug}`).set(auth(admin)).send({ visibility: 'private' })).status).toBe(403);   // owner only
    // ownership transfer keeps exactly one owner
    expect((await api().post(`/api/circles/${c.slug}/transfer`).set(auth(admin)).send({ username: mem.username })).status).toBe(403);
    expect((await api().post(`/api/circles/${c.slug}/transfer`).set(auth(owner)).send({ username: admin.username })).status).toBe(204);
    expect((await pool.query(`SELECT count(*)::int n FROM group_members WHERE group_id=$1 AND role='owner'`, [c.id])).rows[0].n).toBe(1);
    expect((await api().get(`/api/circles/${c.slug}`).set(auth(admin))).body.viewer.role).toBe('owner');
    await expect(pool.query(`UPDATE group_members SET role='owner' WHERE group_id=$1 AND user_id=$2`, [c.id, mem.id])).rejects.toThrow(/group_one_owner/);
    expect((await api().post(`/api/circles/${c.slug}/leave`).set(auth(admin))).status).toBe(409);   // the owner must transfer or delete
  });

  it('approval circles queue join requests for moderators to approve or reject', async () => {
    const owner = await makeUser('po'), mod = await makeUser('pm'), a = await makeUser('pa'), b = await makeUser('pb'), x = await makeUser('px');
    const c = await makeCircle(owner, { join_policy: 'approval' });
    await join(mod, c.slug); await api().put(`/api/circles/${c.slug}/members/${mod.username}/role`).set(auth(owner)).send({ role: 'moderator' });   // pending first → needs approval
    expect((await join(a, c.slug)).body.status).toBe('pending'); expect((await join(b, c.slug)).body.status).toBe('pending');
    expect((await api().post(`/api/posts`).set(auth(a)).send({ body: 'let me in', group_id: c.id })).status).toBe(403);   // pending members cannot post
    expect((await api().get(`/api/circles/${c.slug}/members`).query({ status: 'pending' }).set(auth(x))).status).toBe(403);
    expect((await api().post(`/api/circles/${c.slug}/requests/${a.username}/approve`).set(auth(x))).status).toBe(403);
    expect((await api().get(`/api/circles/${c.slug}`).set(auth(owner))).body.pending_requests).toBeGreaterThanOrEqual(2);
    expect((await api().post(`/api/circles/${c.slug}/requests/${a.username}/approve`).set(auth(owner))).status).toBe(204);
    expect((await api().post(`/api/circles/${c.slug}/requests/${b.username}/reject`).set(auth(owner))).status).toBe(204);
    expect((await join(b, c.slug)).body.status).toBe('pending');    // a rejected person may ask again
    expect((await api().get(`/api/circles/${c.slug}`).set(auth(a))).body.viewer.status).toBe('active');
    expect((await api().get('/api/notifications').set(auth(owner))).body.items.some((n: any) => n.type === 'group_activity')).toBe(true);
    expect((await api().get('/api/notifications').set(auth(a))).body.items.some((n: any) => n.type === 'group_activity')).toBe(true);
  });

  it('private circles do not exist for outsiders; invited people can accept', async () => {
    const owner = await makeUser('vo'), member = await makeUser('vm'), outsider = await makeUser('vx'), invitee = await makeUser('vi');
    const c = await makeCircle(owner, { visibility: 'private', name: 'Secret Calgary Sellers' });
    expect(c.join_policy).toBe('approval');   // forced for private circles
    await api().post(`/api/circles/${c.slug}/invites`).set(auth(owner)).send({ username: member.username }); await join(member, c.slug);
    const p = (await post(member, c.slug, { group_id: c.id, body: 'secret deal' })).body;
    expect(p.visibility).toBe('group'); expect(p.group.slug).toBe(c.slug);
    for (const u of [outsider, null as any]) {
      const h = (r: any) => (u ? r.set(auth(u)) : r);
      expect((await h(api().get(`/api/circles/${c.slug}`))).status).toBe(404);
      expect((await h(api().get(`/api/circles/${c.slug}/posts`))).status).toBe(404);
      expect((await h(api().get(`/api/posts/${p.id}`))).status).toBe(404);
      expect((await h(api().get('/api/circles'))).body.items.map((x: any) => x.slug)).not.toContain(c.slug);
      expect(JSON.stringify((await h(api().get('/api/feed').query({ tab: 'for_you', limit: 30 }))).body)).not.toContain('secret deal');
    }
    expect((await join(outsider, c.slug)).status).toBe(404);   // no way to even ask
    expect((await api().post('/api/posts').set(auth(outsider)).send({ body: 'sneaky', group_id: c.id })).status).toBe(403);
    // invitation flow
    expect((await api().post(`/api/circles/${c.slug}/invites`).set(auth(member)).send({ username: invitee.username })).status).toBe(403);   // plain members cannot invite
    expect((await api().post(`/api/circles/${c.slug}/invites`).set(auth(owner)).send({ username: invitee.username })).status).toBe(201);
    expect((await api().get('/api/notifications').set(auth(invitee))).body.items.some((n: any) => n.type === 'group_invite')).toBe(true);
    expect((await api().get(`/api/circles/${c.slug}`).set(auth(invitee))).body.viewer.status).toBe('invited');
    expect((await join(invitee, c.slug)).body.status).toBe('active');
    expect((await api().get(`/api/posts/${p.id}`).set(auth(invitee))).status).toBe(200);
    // members see it in their circles feed, outsiders never
    expect((await api().get('/api/feed').query({ tab: 'circles' }).set(auth(invitee))).body.items.map((i: any) => i.id)).toContain(p.id);
  });

  it('shares a marketplace listing into a circle and keeps the live listing record (acceptance G)', async () => {
    const owner = await makeUser('go'), member = await makeUser('gm'), cat = await makeCategory(); const c = await makeCircle(owner);
    await join(member, c.slug); const l = await makeListing(member, cat, { title: 'Oak desk', price_cents: 20000 });
    const p = await api().post('/api/posts').set(auth(member)).send({ kind: 'share', body: 'Selling my desk', attachment_type: 'listing', attachment_id: l.id, group_id: c.id });
    expect(p.status).toBe(201); expect(p.body.attachment.listing.price_cents).toBe(20000);
    await api().patch(`/api/listings/${l.id}`).set(auth(member)).send({ price_cents: 15000 });
    const feed = (await api().get(`/api/circles/${c.slug}/posts`).set(auth(owner))).body.items;
    expect(feed.find((x: any) => x.id === p.body.id).attachment.listing.price_cents).toBe(15000);   // the post never owned the price
  });

  it('applies posting rules: members-only, moderators-only and no-commerce circles', async () => {
    const owner = await makeUser('ro'), mem = await makeUser('rm'), mod = await makeUser('rd'), outsider = await makeUser('rx'), cat = await makeCategory();
    const c = await makeCircle(owner, { who_can_post: 'moderators', allow_commerce: false });
    await join(mem, c.slug); await join(mod, c.slug); await api().put(`/api/circles/${c.slug}/members/${mod.username}/role`).set(auth(owner)).send({ role: 'moderator' });
    expect((await post(outsider, c.slug, { group_id: c.id })).status).toBe(403);
    expect((await post(mem, c.slug, { group_id: c.id })).status).toBe(403);      // moderators only
    expect((await post(mod, c.slug, { group_id: c.id })).status).toBe(201);
    await api().patch(`/api/circles/${c.slug}`).set(auth(owner)).send({ who_can_post: 'members' });
    const l = await makeListing(mem, cat);
    expect((await api().post('/api/posts').set(auth(mem)).send({ kind: 'share', attachment_type: 'listing', attachment_id: l.id, group_id: c.id })).status).toBe(403);   // no commerce for members
    expect((await post(mem, c.slug, { group_id: c.id })).status).toBe(201);
    const l2 = await makeListing(mod, cat);
    expect((await api().post('/api/posts').set(auth(mod)).send({ kind: 'share', attachment_type: 'listing', attachment_id: l2.id, group_id: c.id })).status).toBe(201);   // moderators may
  });

  it('moderators remove posts with a recorded reason; admins pin (max 3); bans stick', async () => {
    const owner = await makeUser('mo'), admin = await makeUser('ma'), mod = await makeUser('mm'), mem = await makeUser('mx'), bad = await makeUser('mb');
    const c = await makeCircle(owner); for (const u of [admin, mod, mem, bad]) await join(u, c.slug);
    await api().put(`/api/circles/${c.slug}/members/${admin.username}/role`).set(auth(owner)).send({ role: 'admin' });
    await api().put(`/api/circles/${c.slug}/members/${mod.username}/role`).set(auth(owner)).send({ role: 'moderator' });
    const ps = []; for (let i = 0; i < 4; i++) ps.push((await post(mem, c.slug, { group_id: c.id, body: `post ${i}` })).body);
    const adminPost = (await post(admin, c.slug, { group_id: c.id, body: 'admin post' })).body;
    expect((await api().post(`/api/circles/${c.slug}/posts/${ps[0].id}/pin`).set(auth(mod))).status).toBe(403);   // moderators cannot pin
    for (const p of ps.slice(0, 3)) expect((await api().post(`/api/circles/${c.slug}/posts/${p.id}/pin`).set(auth(admin))).status).toBe(204);
    expect((await api().post(`/api/circles/${c.slug}/posts/${ps[3].id}/pin`).set(auth(admin))).status).toBe(409);
    const view = (await api().get(`/api/circles/${c.slug}/posts`).set(auth(mem))).body;
    expect(view.pinned.map((p: any) => p.id).sort()).toEqual(ps.slice(0, 3).map((p) => p.id).sort()); expect(view.items.map((p: any) => p.id)).not.toContain(ps[0].id);
    expect((await api().delete(`/api/circles/${c.slug}/posts/${ps[3].id}`).set(auth(mem)).send({ reason: 'nope nope' })).status).toBe(403);
    expect((await api().delete(`/api/circles/${c.slug}/posts/${ps[3].id}`).set(auth(mod)).send({})).status).toBe(400);   // reason required
    expect((await api().delete(`/api/circles/${c.slug}/posts/${adminPost.id}`).set(auth(mod)).send({ reason: 'off topic' })).status).toBe(403);   // not above own role
    expect((await api().delete(`/api/circles/${c.slug}/posts/${ps[3].id}`).set(auth(mod)).send({ reason: 'off topic' })).status).toBe(204);
    expect((await api().get(`/api/posts/${ps[3].id}`)).status).toBe(404);
    expect((await pool.query(`SELECT reason FROM moderation_actions WHERE target_id=$1`, [ps[3].id])).rows[0].reason).toBe('off topic');
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE action='circle.post.remove' AND target_id=$1`, [ps[3].id])).rowCount).toBe(1);
    // removal and ban
    expect((await api().delete(`/api/circles/${c.slug}/members/${admin.username}`).set(auth(mod)).send({})).status).toBe(403);
    expect((await api().delete(`/api/circles/${c.slug}/members/${bad.username}`).set(auth(mod)).send({ ban: true, reason: 'spam' })).status).toBe(204);
    expect((await join(bad, c.slug)).status).toBe(404); expect((await api().get(`/api/circles/${c.slug}`).set(auth(bad))).status).toBe(404);
    expect((await api().get(`/api/circles/${c.slug}`)).body.member_count).toBe(4);   // owner + admin + moderator + member (the banned one is gone)
    expect((await api().post(`/api/circles/${c.slug}/leave`).set(auth(mem))).status).toBe(204);
    expect((await api().get(`/api/circles/${c.slug}`)).body.member_count).toBe(3);
  });

  it('discovers circles by text, category and place; only public ones appear', async () => {
    const o = await makeUser('do'); const tag = Math.random().toString(36).slice(2, 7);
    const yyc = await makeCircle(o, { name: `Calgary Car Enthusiasts ${tag}`, category: 'Cars', city: 'Calgary' }); const tor = await makeCircle(o, { name: `Toronto Car Club ${tag}`, category: 'Cars', city: 'Toronto' });
    const priv = await makeCircle(o, { name: `Hidden Cars ${tag}`, category: 'Cars', visibility: 'private' });
    const slugs = async (q: Record<string, string>) => (await api().get('/api/circles').query({ limit: 50, ...q })).body.items.map((x: any) => x.slug);
    expect(await slugs({ q: `Enthusiasts ${tag}` })).toEqual([yyc.slug]);
    const cars = await slugs({ category: 'cars', q: tag }); expect(cars).toEqual(expect.arrayContaining([yyc.slug, tor.slug])); expect(cars).not.toContain(priv.slug);
    expect(await slugs({ q: tag, city: 'Calgary', radius_km: '50' })).toEqual([yyc.slug]);
    expect((await api().get('/api/circles').query({ mine: '1' })).status).toBe(401);
    expect((await api().get('/api/circles').query({ mine: '1' }).set(auth(o))).body.items.map((x: any) => x.slug)).toContain(priv.slug);
  });

  it('runs events: moderators create, members RSVP, cancellations notify, private events stay private', async () => {
    const owner = await makeUser('eo'), mem = await makeUser('em'), out = await makeUser('ex'); const c = await makeCircle(owner); await join(mem, c.slug);
    const ev = (u: any, over = {}) => api().post(`/api/circles/${c.slug}/events`).set(auth(u)).send({ title: 'Garage sale meetup', starts_at: iso(3), venue: 'Community hall', ...over });
    expect((await ev(mem)).status).toBe(403); expect((await ev(owner, { starts_at: iso(-1) })).status).toBe(400); expect((await ev(owner, { ends_at: iso(2) })).status).toBe(400);
    const e = (await ev(owner)).body; expect(e.group.slug).toBe(c.slug);
    expect((await api().post(`/api/events/${e.id}/rsvp`).set(auth(mem)).send({ status: 'going' })).body.going_count).toBe(1);
    expect((await api().post(`/api/events/${e.id}/rsvp`).set(auth(owner)).send({ status: 'going' })).body.going_count).toBe(2);
    expect((await api().delete(`/api/events/${e.id}/rsvp`).set(auth(owner))).status).toBe(204);
    expect((await api().get(`/api/circles/${c.slug}/events`)).body.items.map((x: any) => x.id)).toContain(e.id);
    expect((await api().get('/api/events/upcoming').query({ city: 'Calgary' })).body.items.map((x: any) => x.id)).toContain(e.id);
    expect((await api().delete(`/api/events/${e.id}`).set(auth(mem))).status).toBe(403);
    expect((await api().delete(`/api/events/${e.id}`).set(auth(owner))).status).toBe(204);
    expect((await api().post(`/api/events/${e.id}/rsvp`).set(auth(mem)).send({})).status).toBe(409);
    expect((await api().get('/api/notifications').set(auth(mem))).body.items.some((n: any) => n.data?.event === 'cancelled')).toBe(true);
    const pc = await makeCircle(owner, { visibility: 'private' }); const pe = (await api().post(`/api/circles/${pc.slug}/events`).set(auth(owner)).send({ title: 'Private meetup', starts_at: iso(4) })).body;
    expect((await api().post(`/api/events/${pe.id}/rsvp`).set(auth(out)).send({})).status).toBe(404);
    expect((await api().get('/api/events/upcoming')).body.items.map((x: any) => x.id)).not.toContain(pe.id);
  });

  it('sends event reminders once, to people who RSVP', async () => {
    const owner = await makeUser('rr'), mem = await makeUser('rs'); const c = await makeCircle(owner); await join(mem, c.slug);
    const e = (await api().post(`/api/circles/${c.slug}/events`).set(auth(owner)).send({ title: 'Reminder test', starts_at: iso(0.5) })).body;
    await api().post(`/api/events/${e.id}/rsvp`).set(auth(mem)).send({});
    expect((await runHousekeeping()).reminders).toBeGreaterThanOrEqual(1); expect((await runHousekeeping()).reminders).toBe(0);
    expect((await api().get('/api/notifications').set(auth(mem))).body.items.filter((n: any) => n.type === 'event_reminder')).toHaveLength(1);
  });

  it('platform admins can act on reported circles; deleting a circle hides its posts', async () => {
    const owner = await makeUser('ao'), rep = await makeUser('ar'), mod = await makeStaff('moderator'); const c = await makeCircle(owner); await join(rep, c.slug);
    const p = (await post(owner, c.slug, { group_id: c.id, body: 'scam central' })).body;
    expect((await api().post('/api/reports').set(auth(rep)).send({ target_type: 'group', target_id: c.id, reason: 'fraud' })).status).toBe(201);
    const q = (await api().get('/api/admin/reports').set(auth(mod))).body.items.find((x: any) => x.target_id === c.id);
    expect((await api().post(`/api/admin/reports/${q.id}/resolve`).set(auth(mod)).send({ action: 'remove', reason: 'Scam circle' })).status).toBe(204);
    expect((await api().get(`/api/circles/${c.slug}`)).status).toBe(404);
    expect((await api().get(`/api/posts/${p.id}`)).status).toBe(404);
    expect((await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(rep))).body.items.find((i: any) => i.id === p.id)).toBeUndefined();
    const own = await makeUser('ao2'); const c2 = await makeCircle(own); expect((await api().delete(`/api/circles/${c2.slug}`).set(auth(own))).status).toBe(204); expect((await api().get(`/api/circles/${c2.slug}`)).status).toBe(404);
  });

  it('makes circle posts public in public circles and visible in the main feed and comments work', async () => {
    const owner = await makeUser('fo'), mem = await makeUser('fm'), anyone = await makeUser('fa'); const c = await makeCircle(owner); await join(mem, c.slug);
    const p = (await post(mem, c.slug, { group_id: c.id, body: 'public circle chatter' })).body; expect(p.visibility).toBe('public');
    expect((await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(anyone))).body.items.map((i: any) => i.id)).toContain(p.id);
    expect((await api().post('/api/comments').set(auth(anyone)).send({ target_type: 'post', target_id: p.id, body: 'nice' })).status).toBe(201);
    // changing a circle to private re-labels existing posts so they stop leaking
    await api().patch(`/api/circles/${c.slug}`).set(auth(owner)).send({ visibility: 'private' });
    expect((await api().get(`/api/posts/${p.id}`).set(auth(anyone))).status).toBe(404);
    expect((await api().get(`/api/posts/${p.id}`).set(auth(mem))).status).toBe(200);
  });
});
