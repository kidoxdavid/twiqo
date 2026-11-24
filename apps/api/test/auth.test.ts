import { describe, expect, it } from 'vitest';
import { api, auth, makeUser, makeStaff } from './helpers.js';
import { pool } from '../src/db/pool.js';

describe('identity', () => {
  it('registers, rejects duplicates and returns the profile', async () => {
    const u = await makeUser('reg');
    const me = await api().get('/api/me').set(auth(u));
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe(u.username);
    expect(me.body.user.city).toBe('Calgary');
    expect(me.body.user.password_hash).toBeUndefined();
    const dup = await api().post('/api/auth/register').send({ email: `${u.username}@t.test`, username: 'other_name', password: 'password123', display_name: 'x' });
    expect(dup.status).toBe(409);
    const dupName = await api().post('/api/auth/register').send({ email: 'new@t.test', username: u.username.toUpperCase(), password: 'password123', display_name: 'x' });
    expect(dupName.status).toBe(409);
  });

  it('validates input', async () => {
    const r = await api().post('/api/auth/register').send({ email: 'nope', username: 'a', password: 'short', display_name: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.details.length).toBeGreaterThan(2);
  });

  it('logs in by email or username and rejects wrong passwords', async () => {
    const u = await makeUser('log');
    expect((await api().post('/api/auth/login').send({ identifier: u.username, password: 'password123' })).status).toBe(200);
    expect((await api().post('/api/auth/login').send({ identifier: `${u.username}@t.test`, password: 'password123' })).status).toBe(200);
    expect((await api().post('/api/auth/login').send({ identifier: u.username, password: 'wrong-password' })).status).toBe(401);
  });

  it('locks the account after repeated failures', async () => {
    const u = await makeUser('lock');
    for (let i = 0; i < 5; i++) await api().post('/api/auth/login').send({ identifier: u.username, password: 'bad-password' });
    const r = await api().post('/api/auth/login').send({ identifier: u.username, password: 'password123' });
    expect(r.status).toBe(429);
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const u = await makeUser('ref');
    const a = await api().post('/api/auth/refresh').send({ refresh_token: u.refresh });
    expect(a.status).toBe(200);
    expect(a.body.refresh_token).not.toBe(u.refresh);
    expect((await api().post('/api/auth/refresh').send({ refresh_token: u.refresh })).status).toBe(401);
    await api().post('/api/auth/logout').send({ refresh_token: a.body.refresh_token });
    expect((await api().post('/api/auth/refresh').send({ refresh_token: a.body.refresh_token })).status).toBe(401);
  });

  it('requires a valid token and blocks suspended accounts', async () => {
    expect((await api().get('/api/me')).status).toBe(401);
    expect((await api().get('/api/me').set('Authorization', 'Bearer junk')).status).toBe(401);
    const u = await makeUser('sus');
    const admin = await makeStaff('admin');
    const r = await api().post(`/api/admin/users/${u.id}/suspend`).set(auth(admin)).send({ reason: 'spam accounts', days: 3 });
    expect(r.status).toBe(204);
    expect((await api().get('/api/me').set(auth(u))).status).toBe(403);
    expect((await api().post('/api/auth/refresh').send({ refresh_token: u.refresh })).status).toBe(401);
    await pool.query(`UPDATE users SET suspended_until = now() - interval '1 minute' WHERE id=$1`, [u.id]);
    expect((await api().get('/api/me').set(auth(u))).status).toBe(200);
  });

  it('stores only a hash of passwords and refresh tokens', async () => {
    const u = await makeUser('hash');
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain('password123');
    const s = await pool.query('SELECT refresh_hash FROM sessions WHERE user_id=$1', [u.id]);
    expect(s.rows[0].refresh_hash).not.toBe(u.refresh);
  });
});
