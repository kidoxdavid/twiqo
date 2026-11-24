/**
 * Load check: inserts synthetic data (marked with the username prefix "perf_"), times the main read endpoints in-process, prints p50/p95,
 * then deletes the synthetic data again. Development databases only.  Usage: npm run perf:check -w apps/api -- [listings=20000] [posts=20000]
 */
import request from 'supertest';
import { config } from '../config.js';
import { pool } from './pool.js';
import { createApp } from '../app.js';

if (config.NODE_ENV === 'production') { console.error('Refusing to run against production.'); process.exit(1); }
const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`${k}=`))?.split('=')[1] ?? d);
const N = arg('listings', 20000), P = arg('posts', 20000), SELLERS = 300;
const app = createApp(); const api = () => request(app);

async function cleanup() { await pool.query(`DELETE FROM users WHERE username LIKE 'perf\\_%'`); }
await cleanup();
console.log(`Seeding ${SELLERS} sellers, ${N} listings, ${P} posts…`);
const t0 = Date.now();
await pool.query(`INSERT INTO users(email,username,password_hash,referral_code) SELECT 'perf'||g||'@perf.test','perf_'||g,'x',substr(md5('perf'||g),1,8) FROM generate_series(1,$1) g`, [SELLERS]);
await pool.query(`INSERT INTO user_profiles(user_id,display_name,city,province,location) SELECT u.id,'Perf '||substr(u.username::text,6), p.city, p.province, p.location FROM users u CROSS JOIN LATERAL (SELECT * FROM places ORDER BY random() LIMIT 1) p WHERE u.username LIKE 'perf\\_%'`);
await pool.query(`CREATE TEMP TABLE perf_sellers AS SELECT id, row_number() OVER () AS n FROM users WHERE username LIKE 'perf\\_%'`);
await pool.query(`CREATE TEMP TABLE perf_cats AS SELECT id, row_number() OVER () AS n FROM categories`);
await pool.query(`INSERT INTO listings(seller_id,category_id,title,description,price_cents,city,province,location,tags,created_at)
  SELECT s.id, c.id, 'Perf item '||g||' '||(ARRAY['sofa','bike','laptop','table','tires','phone','chair','lamp'])[1+g%8], 'Synthetic listing for load testing', 1000 + (g*37)%90000, p.city, p.province, p.location,
         ARRAY[(ARRAY['sofa','bike','laptop','table','tires','phone','chair','lamp'])[1+g%8], (ARRAY['vintage','new','used','sale'])[1+g%4]], now() - (g % 40 || ' days')::interval - (g % 1440 || ' minutes')::interval
  FROM generate_series(1,$1) g JOIN perf_sellers s ON s.n = 1 + g % ${SELLERS} JOIN perf_cats c ON c.n = 1 + g % (SELECT count(*) FROM perf_cats)
  CROSS JOIN LATERAL (SELECT * FROM places OFFSET (g % (SELECT count(*) FROM places)) LIMIT 1) p`, [N]);
await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,visibility,status,location,created_at) SELECT 'listing', l.id, l.seller_id, 'public','active', l.location, l.created_at FROM listings l JOIN users u ON u.id=l.seller_id WHERE u.username LIKE 'perf\\_%'`);
await pool.query(`INSERT INTO posts(author_id,kind,body,location,created_at) SELECT s.id,'text','Perf post '||g||' #'||(ARRAY['yyc','moving','sale','deal'])[1+g%4], p.location, now() - (g % 30 || ' days')::interval - (g % 1440 || ' minutes')::interval
  FROM generate_series(1,$1) g JOIN perf_sellers s ON s.n = 1 + g % ${SELLERS} CROSS JOIN LATERAL (SELECT * FROM places OFFSET (g % (SELECT count(*) FROM places)) LIMIT 1) p`, [P]);
await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,visibility,status,location,created_at) SELECT 'post', p.id, p.author_id,'public','active', p.location, p.created_at FROM posts p JOIN users u ON u.id=p.author_id WHERE u.username LIKE 'perf\\_%'`);
await pool.query(`INSERT INTO reactions(user_id,target_type,target_id,created_at) SELECT s.id,'listing',l.id, now() - (random()*6 || ' days')::interval FROM listings l JOIN perf_sellers s ON s.n = 1 + (abs(hashtext(l.id::text)) % ${SELLERS}) JOIN users u ON u.id=l.seller_id WHERE u.username LIKE 'perf\\_%' AND s.id <> l.seller_id AND random() < 0.1 ON CONFLICT DO NOTHING`);
await pool.query('ANALYZE');
console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const reg = await api().post('/api/auth/register').send({ email: `perf_viewer${Date.now()}@perf.test`, username: `perf_viewer${Date.now() % 100000}`, password: 'password123', display_name: 'Perf Viewer', city: 'Calgary' });
const auth = { Authorization: `Bearer ${reg.body.access_token}` };
const anId = (await pool.query(`SELECT l.id FROM listings l JOIN users u ON u.id=l.seller_id WHERE u.username LIKE 'perf\\_%' LIMIT 1`)).rows[0].id;
await api().put(`/api/saves/listing/${anId}`).set(auth);
const cases: [string, string][] = [
  ['feed for_you', '/api/feed?tab=for_you&limit=20'], ['feed nearby', '/api/feed?tab=nearby&limit=20'], ['listings newest', '/api/listings?sort=newest&limit=24'], ['listings search', '/api/listings?q=sofa&sort=relevance&limit=24'],
  ['listings near me', '/api/listings?city=Calgary&radius_km=50&sort=distance&limit=24'], ['discover', '/api/discover'], ['recommended listings', '/api/recommendations/listings'], ['similar listings', `/api/listings/${anId}/similar`], ['people suggestions', '/api/recommendations/people'],
];
const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log('\nendpoint                       p50 ms   p95 ms   status');
let slow = 0;
for (const [name, url] of cases) {
  const times: number[] = []; let status = 0;
  for (let i = 0; i < 25; i++) { const s = performance.now(); const r = await api().get(url).set(auth); times.push(performance.now() - s); status = r.status; }
  const p95 = pct(times, 0.95); if (p95 > 300 || status !== 200) slow++;
  console.log(`${name.padEnd(30)} ${pct(times, 0.5).toFixed(0).padStart(6)}   ${p95.toFixed(0).padStart(6)}   ${status}${p95 > 300 ? '  <-- slow (>300ms)' : ''}`);
}
await cleanup(); await pool.end();
console.log(slow ? `\n${slow} endpoint(s) over budget.` : '\nAll endpoints within the 300 ms p95 budget.');
process.exit(slow ? 1 : 0);
