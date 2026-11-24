import { describe, expect, it } from 'vitest';
import { api, app, auth, makeStaff, makeUser } from './helpers.js';
import { config } from '../src/config.js';

describe('operations', () => {
  it('reports readiness without needing a login, and tags every response with a request id', async () => {
    const r = await api().get('/ready'); expect(r.status).toBe(200); expect(r.body).toMatchObject({ ok: true, db: true });
    expect(r.headers['x-request-id']).toMatch(/^[\w-]{8,}$/);
    expect((await api().get('/health').set('x-request-id', 'trace-abc-12345')).headers['x-request-id']).toBe('trace-abc-12345');
    expect((await api().get('/health').set('x-request-id', 'bad id with spaces & <script>')).headers['x-request-id']).not.toContain('<script>');
  });
  it('shows system health to staff only', async () => {
    const admin = await makeStaff('admin'), user = await makeUser('usr');
    expect((await api().get('/api/admin/system')).status).toBe(401); expect((await api().get('/api/admin/system').set(auth(user))).status).toBe(403);
    const s = (await api().get('/api/admin/system').set(auth(admin))).body;
    expect(s).toMatchObject({ db: true, providers: { email: 'fake', payments: 'fake' } }); expect(s.counts).toHaveProperty('webhooks_stuck'); expect(s.jobs).toHaveProperty('oldest_due_s'); expect(Array.isArray(s.failing_jobs)).toBe(true);
  });
  it('sends hardening headers and does not advertise the framework', async () => {
    const h = (await api().get('/health')).headers;
    expect(h['x-powered-by']).toBeUndefined(); expect(h['x-content-type-options']).toBe('nosniff'); expect(h['strict-transport-security']).toBeTruthy(); expect(h['x-frame-options']).toBeTruthy();
  });
  it('rate-limits bursts of writes from one address', async () => {
    const prev = config.RATE_LIMIT_DISABLED; (config as any).RATE_LIMIT_DISABLED = 'false';
    try {
      const codes: number[] = []; for (let i = 0; i < 130; i++) codes.push((await api().post('/api/auth/refresh').set('X-Forwarded-For', '203.0.113.9').send({ refresh_token: 'x'.repeat(20) })).status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0); expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    } finally { (config as any).RATE_LIMIT_DISABLED = prev; }
  });
});

/** Walks every route the app registers. A new route that forgets its auth guard fails here, which is the point. */
function routes() {
  const out: { method: string; path: string }[] = [];
  const walk = (stack: any[]) => { for (const l of stack) { if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: l.route.path as string }); else if (l.handle?.stack) walk(l.handle.stack); } };
  walk((app as any).router.stack); return out.filter((r) => typeof r.path === 'string');
}
const fill = (p: string) => '/api' + p.replace(/:[A-Za-z]+/g, '3b1f6a52-0a43-4c37-9d1e-0f2f6a7c9a11');
const PUBLIC_WRITES = new Set(['POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout', 'POST /auth/password/forgot', 'POST /auth/password/reset', 'POST /auth/verify-email', 'POST /appeals', 'POST /analytics/events', 'POST /email/unsubscribe',
  'POST /posts/:id/view',            // anonymous view counter, de-duplicated per person or network address per day
  'POST /api/webhooks/stripe']);   // authenticated by the provider's signature, covered in payments tests
const PRIVATE_PREFIXES = ['/me', '/admin', '/payments', '/bookings', '/orders', '/offers', '/notifications', '/conversations', '/driver', '/identity', '/saved-searches', '/disputes', '/boosts', '/subscriptions', '/credits', '/referrals', '/insights', '/push/subscribe', '/recommendations'];

describe('authorization sweep', () => {
  const all = routes();
  it('finds the routes (guard against the walker silently finding nothing)', () => { expect(all.length).toBeGreaterThan(250); });
  it('every write route requires sign-in unless it is deliberately public', async () => {
    const open: string[] = [];
    for (const r of all.filter((x) => x.method !== 'GET' && x.method !== 'HEAD')) {
      if (PUBLIC_WRITES.has(`${r.method} ${r.path}`)) continue;
      const res = await (api() as any)[r.method.toLowerCase()](fill(r.path)).send({});
      if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });
  it('private reads require sign-in', async () => {
    const open: string[] = [];
    for (const r of all.filter((x) => x.method === 'GET' && PRIVATE_PREFIXES.some((p) => x.path === p || x.path.startsWith(p + '/')) && x.path !== '/boosts/pricing' && x.path !== '/push/config')) {
      const res = await api().get(fill(r.path)); if (res.status !== 401) open.push(`GET ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });
  it('every admin route is closed to ordinary members', async () => {
    const user = await makeUser('swp'); const open: string[] = [];
    for (const r of all.filter((x) => x.path.startsWith('/admin'))) {
      const res = await (api() as any)[r.method.toLowerCase()](fill(r.path)).set(auth(user)).send({}); if (res.status !== 403) open.push(`${r.method} ${r.path} -> ${res.status}`);
    }
    expect(open).toEqual([]);
  });
});
