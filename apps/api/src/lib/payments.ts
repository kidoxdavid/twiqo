import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../config.js';

// ---------------------------------------------------------------------------------------------- fees
export interface FeeRule { percent_bps: number; fixed_cents: number; min_cents?: number | null; max_cents?: number | null }

/** Platform commission for an amount, in whole cents. Never more than the amount itself. */
export function computeFee(rule: FeeRule | null | undefined, amountCents: number): number {
  if (!rule) return 0;
  let fee = Math.round((amountCents * rule.percent_bps) / 10_000) + rule.fixed_cents;
  if (rule.min_cents != null) fee = Math.max(fee, rule.min_cents);
  if (rule.max_cents != null) fee = Math.min(fee, rule.max_cents);
  return Math.max(0, Math.min(fee, amountCents));
}

// ---------------------------------------------------------------------------------------------- provider interface
export interface NormalizedEvent {
  id: string;
  type: 'subscription.updated' | 'payment.succeeded' | 'payment.failed' | 'refund.updated' | 'account.updated' | 'payout.updated' | 'card_dispute.created' | 'ignored';
  paymentId?: string; chargeId?: string; failureReason?: string;
  refundId?: string; refundStatus?: 'pending' | 'succeeded' | 'failed'; refundAmount?: number;
  accountId?: string;
  subscription?: { id: string; customerId: string; userId?: string; status: 'incomplete' | 'active' | 'past_due' | 'canceled'; periodEnd?: string; cancelAtPeriodEnd: boolean };
  payout?: { id: string; amount: number; status: string; arrival?: string; currency?: string };
}
export interface CreatePaymentInput { amountCents: number; currency: string; feeCents: number; destinationAccountId: string | null; metadata: Record<string, string>; idempotencyKey: string; description: string }
export interface ProviderAccount { chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean; requirementsDue: string[] }

/** Integration boundary: everything the app needs from a payment backend. */
export interface PaymentProvider {
  readonly name: 'stripe' | 'fake';
  publishableKey(): string | null;
  createAccount(i: { userId: string; email: string }): Promise<{ accountId: string }>;
  accountLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  getAccount(accountId: string): Promise<ProviderAccount>;
  dashboardLink(accountId: string): Promise<string | null>;
  createPayment(i: CreatePaymentInput): Promise<{ id: string; clientSecret: string | null }>;
  retrievePayment(id: string): Promise<{ clientSecret: string | null; status: string }>;
  cancelPayment(id: string): Promise<void>;
  refund(i: { paymentId: string; amountCents: number; hasTransfer: boolean; refundFee: boolean; reason?: string; idempotencyKey: string; metadata: Record<string, string> }): Promise<{ id: string; status: 'pending' | 'succeeded' | 'failed' }>;
  /** Business Pro (recurring) billing: hosted checkout page and customer portal. */
  createSubscriptionCheckout(i: { userId: string; email: string; customerId?: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  subscriptionPortal(customerId: string, returnUrl: string): Promise<string | null>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent;
}

const hdr = (h: Record<string, string | string[] | undefined>, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };

// ---------------------------------------------------------------------------------------------- fake (development and tests only)
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';
const fakePayments = new Map<string, { status: string; secret: string }>();
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  readonly refunds: { paymentId: string; amountCents: number; hasTransfer: boolean; refundFee: boolean; key: string }[] = [];
  failNextRefund = false;
  private seenKeys = new Map<string, { id: string }>();
  publishableKey() { return 'pk_fake'; }
  async createAccount(i: { userId: string }) { return { accountId: `acct_fake_${i.userId.slice(0, 8)}_${crypto.randomBytes(3).toString('hex')}` }; }
  async accountLink(id: string, returnUrl: string) { return `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}fake_onboarding=${id}`; }
  async getAccount(): Promise<ProviderAccount> { return { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, requirementsDue: ['external_account', 'individual.verification.document'] }; }
  async dashboardLink() { return null; }
  async createPayment(i: CreatePaymentInput) {
    const prior = this.seenKeys.get(i.idempotencyKey); if (prior) return { id: prior.id, clientSecret: fakePayments.get(prior.id)?.secret ?? null };
    const id = `pi_fake_${crypto.randomBytes(8).toString('hex')}`; const secret = `${id}_secret_${crypto.randomBytes(4).toString('hex')}`;
    fakePayments.set(id, { status: 'requires_payment_method', secret }); this.seenKeys.set(i.idempotencyKey, { id });
    return { id, clientSecret: secret };
  }
  async retrievePayment(id: string) { const p = fakePayments.get(id); return { clientSecret: p?.secret ?? null, status: p?.status ?? 'unknown' }; }
  async cancelPayment(id: string) { const p = fakePayments.get(id); if (p) p.status = 'canceled'; }
  async refund(i: { paymentId: string; amountCents: number; hasTransfer: boolean; refundFee: boolean; idempotencyKey: string }) {
    if (this.failNextRefund) { this.failNextRefund = false; throw new Error('simulated provider outage'); }
    const prior = this.seenKeys.get(i.idempotencyKey); if (prior) return { id: prior.id, status: 'succeeded' as const };
    const id = `re_fake_${crypto.randomBytes(8).toString('hex')}`; this.seenKeys.set(i.idempotencyKey, { id });
    this.refunds.push({ paymentId: i.paymentId, amountCents: i.amountCents, hasTransfer: i.hasTransfer, refundFee: i.refundFee, key: i.idempotencyKey });
    return { id, status: 'succeeded' as const };
  }
  async createSubscriptionCheckout(i: { successUrl: string }) { return { url: `${i.successUrl}${i.successUrl.includes('?') ? '&' : '?'}fake_subscription=1` }; }
  async subscriptionPortal() { return null; }
  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent {
    const sig = hdr(headers, 'x-fake-signature');
    if (!sig || sig.length !== FAKE_WEBHOOK_SECRET.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(FAKE_WEBHOOK_SECRET))) throw new Error('Invalid webhook signature');
    return JSON.parse(raw.toString()) as NormalizedEvent;
  }
}

// ---------------------------------------------------------------------------------------------- Stripe Connect
/**
 * Stripe adapter. Funds flow ("destination charges"): the customer pays twiqo's Stripe account, the seller's share
 * is transferred to their connected account in the same moment and twiqo's commission stays as the application fee.
 * twiqo does not hold the seller's money, and nothing here is escrow.
 * Written against Stripe's documented API and tested against a mocked client; run `npm run stripe:check -w apps/api`
 * with your test keys to verify it against your own account.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  constructor(private stripe: Stripe = new Stripe(config.STRIPE_SECRET_KEY!), private publishable = config.STRIPE_PUBLISHABLE_KEY ?? null,
    private secrets: string[] = [config.STRIPE_WEBHOOK_SECRET, config.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean) as string[]) {}
  publishableKey() { return this.publishable; }
  async createAccount(i: { userId: string; email: string }) {
    const a = await this.stripe.accounts.create({ type: 'express', country: 'CA', email: i.email, metadata: { twiqo_user_id: i.userId },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } } });
    return { accountId: a.id };
  }
  /** Best effort: delay payouts so refunds and disputes can be handled before money leaves. */
  async setPayoutDelay(accountId: string, days: number) {
    await this.stripe.accounts.update(accountId, { settings: { payouts: { schedule: { interval: 'daily', delay_days: days } } } });
  }
  async accountLink(accountId: string, returnUrl: string, refreshUrl: string) {
    return (await this.stripe.accountLinks.create({ account: accountId, return_url: returnUrl, refresh_url: refreshUrl, type: 'account_onboarding' })).url;
  }
  async getAccount(accountId: string): Promise<ProviderAccount> {
    const a = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted, requirementsDue: a.requirements?.currently_due ?? [] };
  }
  async dashboardLink(accountId: string) { return (await this.stripe.accounts.createLoginLink(accountId)).url; }
  async createPayment(i: CreatePaymentInput) {
    const params: Stripe.PaymentIntentCreateParams = { amount: i.amountCents, currency: i.currency.toLowerCase(), automatic_payment_methods: { enabled: true }, description: i.description, metadata: i.metadata };
    if (i.destinationAccountId) { params.transfer_data = { destination: i.destinationAccountId }; if (i.feeCents > 0) params.application_fee_amount = i.feeCents; }
    const pi = await this.stripe.paymentIntents.create(params, { idempotencyKey: i.idempotencyKey });
    return { id: pi.id, clientSecret: pi.client_secret };
  }
  async retrievePayment(id: string) { const pi = await this.stripe.paymentIntents.retrieve(id); return { clientSecret: pi.client_secret, status: pi.status }; }
  async cancelPayment(id: string) { await this.stripe.paymentIntents.cancel(id); }
  async refund(i: { paymentId: string; amountCents: number; hasTransfer: boolean; refundFee: boolean; reason?: string; idempotencyKey: string; metadata: Record<string, string> }) {
    const params: Stripe.RefundCreateParams = { payment_intent: i.paymentId, amount: i.amountCents, metadata: i.metadata };
    if (i.hasTransfer) { params.reverse_transfer = true; if (i.refundFee) params.refund_application_fee = true; }
    if (i.reason === 'requested_by_customer') params.reason = 'requested_by_customer';
    const r = await this.stripe.refunds.create(params, { idempotencyKey: i.idempotencyKey });
    return { id: r.id, status: r.status === 'succeeded' ? ('succeeded' as const) : r.status === 'failed' || r.status === 'canceled' ? ('failed' as const) : ('pending' as const) };
  }
  async createSubscriptionCheckout(i: { userId: string; email: string; customerId?: string | null; successUrl: string; cancelUrl: string }) {
    if (!config.STRIPE_PRICE_BUSINESS_PRO) throw new Error('STRIPE_PRICE_BUSINESS_PRO is not set');
    const s = await this.stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: config.STRIPE_PRICE_BUSINESS_PRO, quantity: 1 }], client_reference_id: i.userId,
      ...(i.customerId ? { customer: i.customerId } : { customer_email: i.email }), subscription_data: { metadata: { twiqo_user_id: i.userId } }, metadata: { twiqo_user_id: i.userId }, success_url: i.successUrl, cancel_url: i.cancelUrl });
    if (!s.url) throw new Error('Stripe returned no checkout URL');
    return { url: s.url };
  }
  async subscriptionPortal(customerId: string, returnUrl: string) { return (await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url; }
  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedEvent {
    const sig = hdr(headers, 'stripe-signature'); if (!sig) throw new Error('Missing Stripe signature');
    let ev: Stripe.Event | null = null;
    for (const s of this.secrets) { try { ev = this.stripe.webhooks.constructEvent(raw, sig, s); break; } catch { /* try the next secret */ } }
    if (!ev) throw new Error('Invalid webhook signature');
    const o: any = ev.data.object;
    switch (ev.type) {
      case 'payment_intent.succeeded': return { id: ev.id, type: 'payment.succeeded', paymentId: o.id, chargeId: typeof o.latest_charge === 'string' ? o.latest_charge : o.latest_charge?.id };
      case 'payment_intent.payment_failed': return { id: ev.id, type: 'payment.failed', paymentId: o.id, failureReason: o.last_payment_error?.message ?? 'The payment failed' };
      case 'refund.created': case 'refund.updated': case 'charge.refund.updated':
        return { id: ev.id, type: 'refund.updated', refundId: o.id, paymentId: typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id, refundAmount: o.amount, refundStatus: o.status === 'succeeded' ? 'succeeded' : o.status === 'failed' || o.status === 'canceled' ? 'failed' : 'pending' };
      case 'account.updated': return { id: ev.id, type: 'account.updated', accountId: o.id };
      case 'payout.created': case 'payout.paid': case 'payout.failed': case 'payout.updated':
        return { id: ev.id, type: 'payout.updated', accountId: ev.account ?? undefined, payout: { id: o.id, amount: o.amount, status: o.status, currency: String(o.currency ?? 'cad').toUpperCase(), arrival: o.arrival_date ? new Date(o.arrival_date * 1000).toISOString().slice(0, 10) : undefined } };
      case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted': {
        const st = o.status as string; const end = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
        return { id: ev.id, type: 'subscription.updated', subscription: { id: o.id, customerId: typeof o.customer === 'string' ? o.customer : o.customer?.id, userId: o.metadata?.twiqo_user_id,
          status: ev.type === 'customer.subscription.deleted' || st === 'canceled' || st === 'incomplete_expired' ? 'canceled' : st === 'active' || st === 'trialing' ? 'active' : st === 'past_due' || st === 'unpaid' ? 'past_due' : 'incomplete',
          periodEnd: end ? new Date(end * 1000).toISOString() : undefined, cancelAtPeriodEnd: !!o.cancel_at_period_end } };
      }
      case 'charge.dispute.created': return { id: ev.id, type: 'card_dispute.created', paymentId: typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent?.id };
      default: return { id: ev.id, type: 'ignored' };
    }
  }
}

// ---------------------------------------------------------------------------------------------- registry
let provider: PaymentProvider | undefined;
export const paymentProvider = (): PaymentProvider => (provider ??= config.PAYMENT_PROVIDER === 'stripe' ? new StripePaymentProvider() : new FakePaymentProvider());
/** Tests may inject a provider (e.g. a fake with failure switches). */
export const setPaymentProvider = (p: PaymentProvider | undefined) => { provider = p; };
