import { describe, expect, it } from 'vitest';
import { api, auth, makeCategory, makeListing, makeUser, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runQueue } from '../src/lib/queue.js';
import { emailProvider, FakeEmailProvider } from '../src/lib/email.js';
import { currentStep, totpAt } from '../src/lib/totp.js';
import { decryptField } from '../src/lib/secrets.js';

/** Other test files queue emails in the same table, so deliver everything of the kind we care about, not just the first few rows. */
const drain = async (kinds: string[] = ['send_email']) => { let t = { ran: 0, failed: 0 }; for (let i = 0; i < 20; i++) { const r = await runQueue(200, { kinds }); t = { ran: t.ran + r.ran, failed: t.failed + r.failed }; if (!r.ran && !r.failed) break; } return t; };
const fake = () => emailProvider() as FakeEmailProvider;
const reg = async (extra: Record<string, unknown> = {}, ua = 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/120') => {
  const username = `sec${Math.random().toString(36).slice(2, 8)}`;
  const r = await api().post('/api/auth/register').set('User-Agent', ua).send({ email: `${username}@t.test`, username, password: 'password123', display_name: 'Sec', accept_terms: true, ...extra });
  return { r, username, email: `${username}@t.test`, id: r.body.user?.id as string, token: r.body.access_token as string, refresh: r.body.refresh_token as string };
};
const mail = async (email: string, template: string) => (await pool.query(`SELECT * FROM outbox_emails WHERE to_email=$1 AND template=$2 ORDER BY id DESC LIMIT 1`, [email, template])).rows[0];
const linkToken = (body: string) => body.match(/token=([A-Za-z0-9_-]+)/)![1];
const login = (identifier: string, password: string, extra: Record<string, unknown> = {}, ua = 'TestBrowser/1 Chrome/120 Linux') => api().post('/api/auth/login').set('User-Agent', ua).send({ identifier, password, ...extra });

describe('sign-up consent and email verification', () => {
  it('requires accepting the terms, records the version, and queues a verification email that the worker sends', async () => {
    const bad = await api().post('/api/auth/register').send({ email: 'x@t.test', username: 'nonterms1', password: 'password123', display_name: 'X' });
    expect(bad.status).toBe(400);
    const u = await reg(); expect(u.r.status).toBe(201);
    const row = (await pool.query('SELECT terms_version, terms_accepted_at, email_verified_at FROM users WHERE id=$1', [u.id])).rows[0];
    expect(row.terms_version).toBeTruthy(); expect(row.terms_accepted_at).toBeTruthy(); expect(row.email_verified_at).toBeNull();
    const m = await mail(u.email, 'verify_email'); expect(m.status).toBe('queued');
    await drain(); expect((await mail(u.email, 'verify_email')).status).toBe('sent'); expect(fake().sent.some((s) => s.to === u.email)).toBe(true);
  });
  it('verifies once with the emailed link, rejects reuse, and only the newest link works', async () => {
    const u = await reg(); const first = linkToken((await mail(u.email, 'verify_email')).body_text);
    expect((await api().post('/api/auth/verify-email/request').set({ Authorization: `Bearer ${u.token}` })).body.sent).toBe(true);
    const second = linkToken((await mail(u.email, 'verify_email')).body_text); expect(second).not.toBe(first);
    expect((await api().post('/api/auth/verify-email').send({ token: first })).status).toBe(400);
    expect((await api().post('/api/auth/verify-email').send({ token: second })).body.verified).toBe(true);
    expect((await api().post('/api/auth/verify-email').send({ token: second })).status).toBe(400);
    expect((await api().get('/api/me/security').set({ Authorization: `Bearer ${u.token}` })).body.email_verified).toBe(true);
    expect((await api().post('/api/auth/verify-email/request').set({ Authorization: `Bearer ${u.token}` })).body.already_verified).toBe(true);
    const old = await reg(); const t = linkToken((await mail(old.email, 'verify_email')).body_text);
    await pool.query(`UPDATE user_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [old.id]);
    expect((await api().post('/api/auth/verify-email').send({ token: t })).status).toBe(400);
  });
});

describe('password reset and change', () => {
  it('answers the same for unknown emails, resets with a one-time link, and signs everything out', async () => {
    const u = await reg(); const before = (await pool.query('SELECT count(*)::int n FROM outbox_emails')).rows[0].n;
    expect((await api().post('/api/auth/password/forgot').send({ email: 'nobody-here@t.test' })).body.sent).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM outbox_emails')).rows[0].n).toBe(before);
    await api().post('/api/auth/password/forgot').send({ email: u.email });
    const t = linkToken((await mail(u.email, 'reset_password')).body_text);
    expect((await api().post('/api/auth/password/reset').send({ token: t, password: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/password/reset').send({ token: t, password: 'a-brand-new-pass' })).body.reset).toBe(true);
    expect((await api().post('/api/auth/password/reset').send({ token: t, password: 'another-pass-123' })).status).toBe(400);
    expect((await api().get('/api/me').set({ Authorization: `Bearer ${u.token}` })).status).toBe(401);          // old session is gone
    expect((await login(u.email, 'password123')).status).toBe(401);
    expect((await login(u.email, 'a-brand-new-pass')).status).toBe(200);
    expect(await mail(u.email, 'password_changed')).toBeTruthy();
  });
  it('changing your password needs the current one and keeps only this session', async () => {
    const u = await reg(); const second = (await login(u.username, 'password123')).body;
    const h = { Authorization: `Bearer ${u.token}` };
    expect((await api().post('/api/me/password').set(h).send({ current_password: 'wrong-password', new_password: 'new-password-1' })).status).toBe(403);
    expect((await api().post('/api/me/password').set(h).send({ current_password: 'password123', new_password: 'new-password-1' })).body.changed).toBe(true);
    expect((await api().get('/api/me').set(h)).status).toBe(200);
    expect((await api().get('/api/me').set({ Authorization: `Bearer ${second.access_token}` })).status).toBe(401);
  });
});

describe('sessions and new-device alerts', () => {
  it('lists sessions, marks the current one, and revoking signs that device out', async () => {
    const u = await reg(); const other = (await login(u.username, 'password123', {}, 'Mozilla/5.0 (iPhone) Safari/605')).body; const h = { Authorization: `Bearer ${u.token}` };
    const list = (await api().get('/api/me/sessions').set(h)).body.items; expect(list.length).toBe(2);
    expect(list.filter((s: any) => s.current)).toHaveLength(1); expect(list.some((s: any) => s.device.includes('iOS'))).toBe(true);
    const target = list.find((s: any) => !s.current);
    expect((await api().delete(`/api/me/sessions/${list.find((s: any) => s.current).id}`).set({ Authorization: `Bearer ${other.access_token}` })).status).toBe(204);   // signs the first device out from the second
    expect((await api().get('/api/me').set(h)).status).toBe(401);
    expect((await api().delete(`/api/me/sessions/${target.id}`).set({ Authorization: `Bearer ${other.access_token}` })).status).toBe(204);
    expect((await api().get('/api/me').set({ Authorization: `Bearer ${other.access_token}` })).status).toBe(401);
    expect((await api().delete(`/api/me/sessions/${target.id}`).set(auth(await makeUser('oth')))).status).toBe(404);
  });
  it('emails a heads-up only for a device we have not seen before', async () => {
    const u = await reg({}, 'FirstBrowser/1 Chrome/120 Windows');
    await login(u.username, 'password123', {}, 'FirstBrowser/1 Chrome/120 Windows'); expect(await mail(u.email, 'login_alert')).toBeUndefined();
    await login(u.username, 'password123', {}, 'Mozilla/5.0 (Android 14) Firefox/120'); const a = await mail(u.email, 'login_alert');
    expect(a.body_text).toContain('Firefox on Android');
    const n = (await pool.query(`SELECT count(*)::int n FROM outbox_emails WHERE to_email=$1 AND template='login_alert'`, [u.email])).rows[0].n;
    await login(u.username, 'password123', {}, 'Mozilla/5.0 (Android 14) Firefox/120'); expect((await pool.query(`SELECT count(*)::int n FROM outbox_emails WHERE to_email=$1 AND template='login_alert'`, [u.email])).rows[0].n).toBe(n);
  });
});

describe('two-step verification', () => {
  it('enrols with an authenticator code, demands it at sign-in, blocks replays, and accepts each recovery code once', async () => {
    const u = await reg(); const h = { Authorization: `Bearer ${u.token}` };
    const setup = (await api().post('/api/me/2fa/setup').set(h)).body; expect(setup.otpauth_url).toContain('issuer=twiqo');
    const secret = setup.secret as string;
    const stored = (await pool.query('SELECT totp_secret_enc FROM users WHERE id=$1', [u.id])).rows[0].totp_secret_enc; expect(stored).not.toContain(secret); expect(decryptField(stored)).toBe(secret);   // encrypted at rest
    expect((await api().post('/api/me/2fa/enable').set(h).send({ code: '000000' })).status).toBe(400);
    const en = await api().post('/api/me/2fa/enable').set(h).send({ code: totpAt(secret, currentStep()) });
    expect(en.body.recovery_codes).toHaveLength(10);
    const need = await login(u.username, 'password123'); expect(need.status).toBe(401); expect(need.body.error.code).toBe('otp_required');
    expect((await login(u.username, 'password123', { otp: totpAt(secret, currentStep()) })).status).toBe(401);       // that code was used to enrol: replay blocked
    const ok = await login(u.username, 'password123', { otp: totpAt(secret, currentStep() + 1) }); expect(ok.status).toBe(200);
    expect((await login(u.username, 'password123', { otp: totpAt(secret, currentStep() + 1) })).status).toBe(401);   // and that one is spent too
    const rc = en.body.recovery_codes[0];
    expect((await login(u.username, 'password123', { otp: rc })).status).toBe(200); expect((await login(u.username, 'password123', { otp: rc })).status).toBe(401);
    expect((await api().get('/api/me/security').set(h)).body).toMatchObject({ two_factor: true, recovery_codes_left: 9 });
    expect((await api().post('/api/me/2fa/disable').set(h).send({ password: 'nope-nope-nope', code: en.body.recovery_codes[1] })).status).toBe(403);
    expect((await api().post('/api/me/2fa/disable').set(h).send({ password: 'password123', code: en.body.recovery_codes[1] })).body.enabled).toBe(false);
    expect((await login(u.username, 'password123')).status).toBe(200);
    expect(await mail(u.email, 'two_factor_changed')).toBeTruthy();
  });
});

describe('job queue and email delivery', () => {
  it('retries a failed send with backoff and eventually delivers', async () => {
    const u = await reg(); await drain();
    await api().post('/api/auth/password/forgot').send({ email: u.email }); const m = await mail(u.email, 'reset_password');
    fake().fail = true; try { const r = await runQueue(200, { kinds: ['send_email'] }); expect(r.failed).toBeGreaterThanOrEqual(1); } finally { fake().fail = false; }
    const job = (await pool.query(`SELECT * FROM jobs WHERE kind='send_email' AND payload->>'id'=$1`, [String(m.id)])).rows[0];
    expect(job.attempts).toBe(1); expect(job.done_at).toBeNull(); expect(new Date(job.run_at).getTime()).toBeGreaterThan(Date.now());
    expect((await mail(u.email, 'reset_password')).status).toBe('queued');
    await pool.query(`UPDATE jobs SET run_at = now() WHERE id=$1`, [job.id]); await drain();
    expect((await mail(u.email, 'reset_password')).status).toBe('sent');
  });
  it('de-duplicates keyed jobs and gives up after max attempts', async () => {
    const { enqueue, registerJob } = await import('../src/lib/queue.js');
    registerJob('always_fails', async () => { throw new Error('boom'); });
    expect(await enqueue(pool, 'always_fails', {}, { dedupeKey: 'k1', maxAttempts: 2 })).toBeTruthy(); expect(await enqueue(pool, 'always_fails', {}, { dedupeKey: 'k1' })).toBeUndefined();
    for (let i = 0; i < 3; i++) { await drain(['always_fails']); await pool.query(`UPDATE jobs SET run_at = now() WHERE kind='always_fails'`); }
    const j = (await pool.query(`SELECT attempts, done_at FROM jobs WHERE dedupe_key='k1'`)).rows[0]; expect(j.attempts).toBe(2); expect(j.done_at).toBeNull();
  });
});

describe('data export and account deletion', () => {
  it('exports your own data only', async () => {
    const a = await makeUser('exa'), b = await makeUser('exb'); await makeListing(a, await makeCategory(), { title: 'Mine to export' }); await makeListing(b, await makeCategory(), { title: 'Not mine' });
    const d = (await api().get('/api/me/export').set(auth(a))).body;
    expect(d.account.username).toBe(a.username); expect(d.listings.map((l: any) => l.title)).toEqual(['Mine to export']); expect(JSON.stringify(d)).not.toContain('password_hash');
    expect((await api().get('/api/me/export')).status).toBe(401);
  });
  it('deletion needs the password, waits for open deals, then removes personal data and sign-in', async () => {
    const u = await reg(); const me = { id: u.id, username: u.username, token: u.token, refresh: u.refresh } as TestUser; const buyer = await makeUser('buy');
    const listing = await makeListing(me, await makeCategory(), { price_cents: 20000, price_type: 'fixed' });
    const o = await api().post('/api/offers').set(auth(buyer)).send({ kind: 'goods', listing_id: listing.id, amount_cents: 20000 });
    const order = (await api().post(`/api/offers/${o.body.id}/accept`).set(auth(me))).body.order_id;
    expect((await api().delete('/api/me').set(auth(me)).send({ password: 'wrong-password' })).status).toBe(403);
    expect((await api().delete('/api/me').set(auth(me)).send({ password: 'password123' })).body.error.code).toBe('active_deals');
    await api().post(`/api/orders/${order}/cancel`).set(auth(buyer));
    expect((await api().delete('/api/me').set(auth(me)).send({ password: 'password123' })).status).toBe(204);
    const row = (await pool.query('SELECT status, email, username FROM users WHERE id=$1', [u.id])).rows[0]; expect(row.status).toBe('deleted'); expect(row.email).toContain('deleted.invalid');
    expect((await pool.query('SELECT display_name FROM user_profiles WHERE user_id=$1', [u.id])).rows[0].display_name).toBe('Deleted user');
    expect((await login(u.email, 'password123')).status).toBe(401); expect((await api().get('/api/me').set(auth(me))).status).toBe(401);
    expect((await api().get(`/api/listings/${listing.id}`)).status).toBe(404);
    expect((await pool.query(`SELECT count(*)::int n FROM orders WHERE id=$1`, [order])).rows[0].n).toBe(1);        // records kept for payments and disputes
    expect(await mail(u.email, 'account_deleted')).toBeTruthy();
  });
});
