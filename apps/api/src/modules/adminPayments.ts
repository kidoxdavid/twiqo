import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { wrap } from '../lib/errors.js';
import { requireAuthStaff } from './disputes.js';

export const adminPayments = Router();

adminPayments.get('/admin/payments', requireAuthStaff(), wrap(async (req, res) => {
  const q = z.object({ status: z.string().optional(), kind: z.enum(['order', 'booking', 'boost']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT p.id, p.kind, p.status, p.amount_cents, p.fee_cents, p.refunded_cents, p.currency, p.created_at, p.succeeded_at, p.failure_reason, p.provider, p.provider_payment_id,
            pu.username AS payer, eu.username AS payee
     FROM payments p JOIN users pu ON pu.id=p.payer_id LEFT JOIN users eu ON eu.id=p.payee_id
     WHERE ($1::text IS NULL OR p.status=$1) AND ($2::text IS NULL OR p.kind=$2) ORDER BY p.created_at DESC LIMIT $3`, [q.status ?? null, q.kind ?? null, q.limit]);
  res.json({ items: rows });
}));

/** Platform revenue: commissions and boost fees on money actually collected, net of the commission given back on refunds. */
adminPayments.get('/admin/revenue', requireAuthStaff(), wrap(async (req, res) => {
  const days = z.coerce.number().int().min(1).max(365).default(30).parse(req.query.days ?? 30);
  const base = `FROM payments WHERE status IN ('succeeded','partially_refunded','refunded') AND succeeded_at > now() - ($1 || ' days')::interval`;
  const refundedFee = `round(fee_cents::numeric * refunded_cents / amount_cents)`;
  const totals = (await pool.query(`SELECT count(*)::int AS payments, coalesce(sum(amount_cents),0)::bigint AS gross, coalesce(sum(fee_cents),0)::bigint AS fees, coalesce(sum(refunded_cents),0)::bigint AS refunded, coalesce(sum(${refundedFee}),0)::bigint AS fees_returned ${base}`, [String(days)])).rows[0];
  const byScope = (await pool.query(`SELECT coalesce(fee_scope, kind) AS scope, count(*)::int AS payments, sum(amount_cents)::bigint AS gross, sum(fee_cents - ${refundedFee})::bigint AS net_fees ${base} GROUP BY 1 ORDER BY 3 DESC`, [String(days)])).rows;
  const byDay = (await pool.query(`SELECT date_trunc('day', succeeded_at)::date AS day, sum(amount_cents)::bigint AS gross, sum(fee_cents - ${refundedFee})::bigint AS net_fees ${base} GROUP BY 1 ORDER BY 1`, [String(days)])).rows;
  const open = (await pool.query(`SELECT (SELECT count(*) FROM disputes WHERE status='open')::int AS open_disputes, (SELECT count(*) FROM payments WHERE status='failed' AND created_at > now() - interval '7 days')::int AS failed_7d, (SELECT count(*) FROM refunds WHERE status='failed')::int AS failed_refunds`)).rows[0];
  const n = (v: unknown) => Number(v);
  res.json({ days, currency: 'CAD', payments: totals.payments, gross_cents: n(totals.gross), platform_fees_cents: n(totals.fees), fees_returned_cents: n(totals.fees_returned), net_platform_revenue_cents: n(totals.fees) - n(totals.fees_returned), refunded_cents: n(totals.refunded),
    by_scope: byScope.map((r) => ({ scope: r.scope, payments: r.payments, gross_cents: n(r.gross), net_fees_cents: n(r.net_fees) })), by_day: byDay.map((r) => ({ day: r.day, gross_cents: n(r.gross), net_fees_cents: n(r.net_fees) })), ...open,
    note: 'Sales tax (GST/HST/PST) on sales and on twiqo fees is not calculated or collected by this system yet.' });
}));

adminPayments.get('/admin/webhook-events', requireAuthStaff(), wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT id, provider, type, received_at, processed_at FROM webhook_events ORDER BY received_at DESC LIMIT 100`);
  res.json({ items: rows });
}));
