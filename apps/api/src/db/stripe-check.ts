/**
 * Verifies your Stripe TEST keys against your own Stripe account. Nothing here moves real money:
 * it needs a test-mode secret key (sk_test_...), creates a throwaway Express account and a test PaymentIntent, then cancels it.
 */
import Stripe from 'stripe';
import { config } from '../config.js';

const key = config.STRIPE_SECRET_KEY;
if (!key || !config.STRIPE_PUBLISHABLE_KEY) { console.error('Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in apps/api/.env first.'); process.exit(1); }
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) { console.error('Refusing to run: this check only accepts test-mode keys (sk_test_...).'); process.exit(1); }
const stripe = new Stripe(key);
const ok = (m: string) => console.log(`✓ ${m}`);
try {
  await stripe.balance.retrieve(); ok('API key works');
  const a = await stripe.accounts.create({ type: 'express', country: 'CA', capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { twiqo_check: '1' } });
  ok(`Connect is enabled: created Express test account ${a.id}`);
  const link = await stripe.accountLinks.create({ account: a.id, type: 'account_onboarding', return_url: `${config.WEB_ORIGIN.split(',')[0]}/settings/payments`, refresh_url: `${config.WEB_ORIGIN.split(',')[0]}/settings/payments` });
  ok(`Onboarding link works (${new URL(link.url).host})`);
  const pi = await stripe.paymentIntents.create({ amount: 1000, currency: 'cad', automatic_payment_methods: { enabled: true }, metadata: { twiqo_check: '1' } });
  ok(`PaymentIntent created (${pi.id}) with a client secret`);
  await stripe.paymentIntents.cancel(pi.id); ok('PaymentIntent cancelled');
  await stripe.accounts.del(a.id); ok('Test account deleted');
  console.log('\nNot checked here: destination charges need a connected account with transfers enabled. Finish onboarding one test seller in the app (use Stripe\'s test data) and make a test purchase.');
  console.log('Webhooks: add endpoints for  <your API>/api/webhooks/stripe  (platform events, secret -> STRIPE_WEBHOOK_SECRET) and the same URL as a Connect endpoint (secret -> STRIPE_CONNECT_WEBHOOK_SECRET).');
  console.log('Events: payment_intent.succeeded, payment_intent.payment_failed, refund.created, refund.updated, charge.refund.updated, charge.dispute.created, account.updated, payout.created, payout.paid, payout.failed, payout.updated');
} catch (e) { console.error('✗', (e as Error).message); process.exit(1); }
