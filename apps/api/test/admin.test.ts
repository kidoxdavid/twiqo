import { describe, expect, it } from 'vitest';
import { api, auth, makeUser, makeStaff } from './helpers.js';
import { pool } from '../src/db/pool.js';

describe('administration', () => {
  it('enforces role permissions', async () => {
    const user = await makeUser('au'), mod = await makeStaff('moderator'), admin = await makeStaff('admin'), sup = await makeStaff('super_admin');
    for (const [u, path, status] of [[user, '/api/admin/stats', 403], [mod, '/api/admin/stats', 403], [admin, '/api/admin/stats', 200], [mod, '/api/admin/audit', 403], [admin, '/api/admin/audit', 200],
      [admin, '/api/admin/fee-rules', 403], [sup, '/api/admin/fee-rules', 200], [mod, '/api/admin/users', 403]] as const) {
      expect((await api().get(path).set(auth(u))).status, `${path} as ${u.username}`).toBe(status);
    }
    expect((await api().get('/api/admin/stats')).status).toBe(401);
  });

  it('suspends and bans users across every surface and writes the audit log', async () => {
    const admin = await makeStaff('admin'), bad = await makeUser('bad'), other = await makeUser('oth');
    const post = (await api().post('/api/posts').set(auth(bad)).send({ body: 'scammy offer' })).body;
    expect((await api().post(`/api/admin/users/${bad.id}/ban`).set(auth(admin)).send({ reason: 'fraud ring' })).status).toBe(204);
    expect((await api().get(`/api/posts/${post.id}`).set(auth(other))).status).toBe(404);
    expect((await api().get(`/api/users/${bad.username}`).set(auth(other))).status).toBe(404);
    expect((await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(other))).body.items.find((i: any) => i.id === post.id)).toBeUndefined();
    expect((await api().post('/api/auth/login').send({ identifier: bad.username, password: 'password123' })).status).toBe(403);
    const log = await api().get('/api/admin/audit').query({ action: 'user.ban' }).set(auth(admin));
    expect(log.body.items[0]).toMatchObject({ action: 'user.ban', actor: admin.username, target_id: bad.id });
    expect(log.body.items[0].after.reason).toBe('fraud ring');
  });

  it('protects administrators and self from restriction', async () => {
    const admin = await makeStaff('admin'), other = await makeStaff('admin');
    expect((await api().post(`/api/admin/users/${admin.id}/suspend`).set(auth(admin)).send({ reason: 'oops oops' })).status).toBe(400);
    expect((await api().post(`/api/admin/users/${other.id}/suspend`).set(auth(admin)).send({ reason: 'abuse of power' })).status).toBe(403);
  });

  it('resolves reports through one path and closes duplicates', async () => {
    const mod = await makeStaff('moderator'), a = await makeUser('ra'), r1 = await makeUser('r1'), r2 = await makeUser('r2');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'prohibited item for sale' })).body;
    await api().post('/api/reports').set(auth(r1)).send({ target_type: 'post', target_id: p.id, reason: 'prohibited_item' });
    await api().post('/api/reports').set(auth(r2)).send({ target_type: 'post', target_id: p.id, reason: 'prohibited_item' });
    const q = (await api().get('/api/admin/reports').set(auth(mod))).body.items.filter((r: any) => r.target_id === p.id);
    expect(q).toHaveLength(2); expect(q[0].report_count).toBe(2);
    expect((await api().post(`/api/admin/reports/${q[0].id}/resolve`).set(auth(mod)).send({ action: 'remove', reason: 'policy 4.2' })).status).toBe(204);
    expect((await api().get(`/api/posts/${p.id}`)).status).toBe(404);
    expect((await api().get('/api/admin/reports').set(auth(mod))).body.items.filter((r: any) => r.target_id === p.id)).toHaveLength(0);
    expect((await api().post(`/api/admin/reports/${q[1].id}/resolve`).set(auth(mod)).send({ action: 'dismiss', reason: 'already handled' })).status).toBe(409);
    expect((await api().post(`/api/admin/reports/${q[0].id}/resolve`).set(auth(mod)).send({ action: 'suspend_user', reason: 'repeat offender' })).status).toBe(409);
  });

  it('moderators cannot suspend users via reports without manage.users', async () => {
    const mod = await makeStaff('moderator'), a = await makeUser('sa'), r = await makeUser('sr');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'bad' })).body;
    await api().post('/api/reports').set(auth(r)).send({ target_type: 'post', target_id: p.id, reason: 'harassment' });
    const rep = (await api().get('/api/admin/reports').set(auth(mod))).body.items.find((x: any) => x.target_id === p.id);
    expect((await api().post(`/api/admin/reports/${rep.id}/resolve`).set(auth(mod)).send({ action: 'suspend_user', reason: 'nope nope' })).status).toBe(403);
  });

  it('keeps configuration in the database: settings and fee rules are editable and audited', async () => {
    const sup = await makeStaff('super_admin');
    expect((await api().put('/api/admin/settings/story.expiry_hours').set(auth(sup)).send({ value: 12 })).status).toBe(204);
    const s = await api().get('/api/admin/settings').set(auth(sup));
    expect(s.body.items.find((x: any) => x.key === 'story.expiry_hours').value).toBe(12);
    expect((await api().put('/api/admin/settings/does.not.exist').set(auth(sup)).send({ value: 1 })).status).toBe(404);
    const rules = (await api().get('/api/admin/fee-rules').set(auth(sup))).body.items;
    const rule = rules.find((r: any) => r.scope === 'product_sale');
    expect((await api().put(`/api/admin/fee-rules/${rule.id}`).set(auth(sup)).send({ percent_bps: 750, fixed_cents: 30, active: true })).status).toBe(204);
    const after = (await pool.query('SELECT percent_bps, fixed_cents FROM fee_rules WHERE id=$1', [rule.id])).rows[0];
    expect(after).toEqual({ percent_bps: 750, fixed_cents: 30 });
    expect((await api().put(`/api/admin/fee-rules/${rule.id}`).set(auth(sup)).send({ percent_bps: 20000, fixed_cents: 0 })).status).toBe(400);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action IN ('setting.update','fee_rule.update')`)).rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('audit log is append-only at the database level', async () => {
    const admin = await makeStaff('admin');
    await api().post('/api/admin/banned-words').set(auth(admin)).send({ term: 'immutable-check' });
    await expect(pool.query(`UPDATE audit_logs SET action='tampered'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('grants roles only to super admins and takes effect immediately', async () => {
    const sup = await makeStaff('super_admin'), admin = await makeStaff('admin'), u = await makeUser('promo');
    expect((await api().put(`/api/admin/users/${u.id}/roles`).set(auth(admin)).send({ roles: ['moderator'] })).status).toBe(403);
    expect((await api().get('/api/admin/reports').set(auth(u))).status).toBe(403);
    expect((await api().put(`/api/admin/users/${u.id}/roles`).set(auth(sup)).send({ roles: ['moderator'] })).status).toBe(204);
    expect((await api().get('/api/admin/reports').set(auth(u))).status).toBe(200);
  });

  it('supports the appeal workflow for restricted users', async () => {
    const admin = await makeStaff('admin'), u = await makeUser('app');
    expect((await api().post('/api/appeals').send({ identifier: u.username, password: 'password123', message: 'I did nothing wrong at all' })).status).toBe(400);
    await api().post(`/api/admin/users/${u.id}/suspend`).set(auth(admin)).send({ reason: 'suspected spam', days: 30 });
    expect((await api().post('/api/appeals').send({ identifier: u.username, password: 'wrong', message: 'Please review my case' })).status).toBe(401);
    expect((await api().post('/api/appeals').send({ identifier: u.username, password: 'password123', message: 'Please review my case, I am a real seller' })).status).toBe(201);
    expect((await api().post('/api/appeals').send({ identifier: u.username, password: 'password123', message: 'Second appeal attempt here' })).status).toBe(409);
    const open = (await api().get('/api/admin/appeals').set(auth(admin))).body.items.find((a: any) => a.username === u.username);
    expect((await api().post(`/api/admin/appeals/${open.id}/decide`).set(auth(admin)).send({ decision: 'overturn', reason: 'verified seller' })).status).toBe(204);
    expect((await api().get('/api/me').set(auth(u))).status).toBe(200);
  });
});
