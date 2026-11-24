import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

export const app = createApp();
export const api = () => request(app);

export interface TestUser { id: string; username: string; token: string; refresh: string }

export async function makeUser(prefix = 'u', city = 'Calgary'): Promise<TestUser> {
  const username = `${prefix}${crypto.randomBytes(3).toString('hex')}`;
  const r = await api().post('/api/auth/register').send({ email: `${username}@t.test`, username, password: 'password123', display_name: prefix, city });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.user.id, username, token: r.body.access_token, refresh: r.body.refresh_token };
}
export const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

export async function makeStaff(role: 'moderator' | 'admin' | 'super_admin'): Promise<TestUser> {
  const u = await makeUser(role.slice(0, 3));
  await pool.query('INSERT INTO user_roles(user_id, role_key) VALUES ($1,$2)', [u.id, role]);
  return u;
}

export async function makeCategory(slug = `cat-${crypto.randomBytes(3).toString('hex')}`, restricted = false) {
  const r = await pool.query(`INSERT INTO categories(name, slug, is_restricted) VALUES ($1,$2,$3) RETURNING id`, [slug, slug, restricted]);
  return r.rows[0].id as string;
}

export async function makeListing(u: TestUser, categoryId: string, over: Record<string, unknown> = {}) {
  const r = await api().post('/api/listings').set(auth(u)).send({ title: 'Test sofa', description: 'Nice', category_id: categoryId, price_cents: 10000, price_type: 'negotiable', ...over });
  if (r.status !== 201) throw new Error(`listing failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// 1x1 PNG
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
