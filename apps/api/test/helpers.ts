import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

export const app = createApp();
export const api = () => request(app);

export interface TestUser { id: string; username: string; token: string; refresh: string }

export async function makeUser(prefix = 'u', city = 'Calgary'): Promise<TestUser> {
  const username = `${prefix.toLowerCase().replace(/[^a-z0-9_.]/g, '')}${crypto.randomBytes(3).toString('hex')}`;
  const r = await api().post('/api/auth/register').send({ email: `${username}@t.test`, username, password: 'password123', display_name: prefix, city, accept_terms: true });
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

// ---------------------------------------------------------------- phase 2 helpers
export const ymd = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
export const iso = (days: number) => new Date(Date.now() + days * 864e5).toISOString();

export async function makeRequest(u: TestUser, over: Record<string, unknown> = {}) {
  const r = await api().post('/api/transport/requests').set(auth(u)).send({
    title: 'Four winter tires', item_category: 'tires', quantity: 1, weight_kg: 36, length_cm: 70, width_cm: 70, height_cm: 60,
    origin_city: 'Toronto', dest_city: 'Calgary', pickup_from: ymd(3), pickup_to: ymd(6), budget_cents: 12000, ...over });
  if (r.status !== 201) throw new Error(`request failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
export async function makeJourney(u: TestUser, over: Record<string, unknown> = {}) {
  const r = await api().post('/api/transport/journeys').set(auth(u)).send({
    origin_city: 'Toronto', dest_city: 'Calgary', waypoints: [{ city: 'Thunder Bay' }, { city: 'Winnipeg' }, { city: 'Regina' }], departure_at: iso(4),
    vehicle_type: 'pickup_truck', capacity_kg: 400, capacity_m3: 3, price_cents: 9000, price_type: 'negotiable', ...over });
  if (r.status !== 201) throw new Error(`journey failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
export async function makeService(u: TestUser, over: Record<string, unknown> = {}) {
  const r = await api().post('/api/transport/services').set(auth(u)).send({ title: 'Local furniture delivery', vehicle_type: 'pickup_truck', service_city: 'Calgary', service_radius_km: 40, capacity_kg: 800, price_cents: 7500, helps_loading: true, ...over });
  if (r.status !== 201) throw new Error(`service failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
export async function until<T>(fn: () => Promise<T | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as T; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 60)); }
}
/** shipper books `journey` for `request`: offer then accept. Returns booking id. */
export async function bookJourney(shipper: TestUser, driver: TestUser, request: any, journey: any, amount = journey.price_cents) {
  const o = await api().post('/api/offers').set(auth(shipper)).send({ kind: 'transport', request_id: request.id, journey_id: journey.id, amount_cents: amount });
  if (o.status !== 201) throw new Error(`offer failed ${o.status} ${JSON.stringify(o.body)}`);
  const a = await api().post(`/api/offers/${o.body.id}/accept`).set(auth(driver));
  if (a.status !== 200) throw new Error(`accept failed ${a.status} ${JSON.stringify(a.body)}`);
  return a.body.booking_id as string;
}

// ---------------------------------------------------------------- phase 3 helpers
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** Generate a real MP4 with ffmpeg (so the upload path exercises the real transcoder). */
export function makeVideoFile(seconds = 2, w = 360, h = 640): Buffer {
  const f = `/tmp/twiqo-test-${seconds}-${w}x${h}.mp4`;
  if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${w}x${h}:rate=${seconds > 20 ? 1 : 24}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  return fs.readFileSync(f);
}
export async function startVideo(u: TestUser) {
  const r = await api().post('/api/videos').set(auth(u)).send({ title: 'test clip' });
  if (r.status !== 201) throw new Error(`video create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; upload: { type: string; url: string } };
}
export async function waitVideo(u: TestUser, id: string, ms = 60_000) {
  return until(async () => { const v = (await api().get(`/api/videos/${id}`).set(auth(u))).body; return ['ready', 'rejected', 'failed'].includes(v.status) ? v : false; }, ms);
}
export async function uploadVideo(u: TestUser, buf = makeVideoFile()) {
  const v = await startVideo(u);
  const put = await api().put(v.upload.url).set(auth(u)).set('Content-Type', 'video/mp4').send(buf);
  if (put.status !== 202) throw new Error(`upload failed ${put.status} ${JSON.stringify(put.body)}`);
  return { id: v.id, final: await waitVideo(u, v.id) };
}
export async function makeCircle(owner: TestUser, over: Record<string, unknown> = {}) {
  const r = await api().post('/api/circles').set(auth(owner)).send({ name: `Calgary Buy and Sell ${Math.random().toString(36).slice(2, 7)}`, description: 'Local trading', city: 'Calgary', ...over });
  if (r.status !== 201) throw new Error(`circle failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
