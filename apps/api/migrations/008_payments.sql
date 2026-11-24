-- Phase 4: payments (Stripe Connect), refunds, payouts, disputes, boosts

-- ------------------------------------------------------------------ connected accounts (sellers and drivers get paid here)
CREATE TABLE payment_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe','fake')),
  provider_account_id text NOT NULL UNIQUE,
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  requirements_due text[] NOT NULL DEFAULT '{}',
  country char(2) NOT NULL DEFAULT 'CA',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ boosts (premium listings / featured services / sponsored)
CREATE TABLE boosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('listing','transport_service','post')),
  target_id uuid NOT NULL,
  placement text NOT NULL CHECK (placement IN ('featured','sponsored')),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','active','expired','canceled')),
  days int NOT NULL CHECK (days BETWEEN 1 AND 90),
  price_cents int NOT NULL CHECK (price_cents >= 0),
  impressions int NOT NULL DEFAULT 0,
  starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (placement = 'sponsored' OR target_type <> 'post')
);
CREATE INDEX boosts_active_idx ON boosts(target_type, target_id) WHERE status = 'active';
CREATE INDEX boosts_owner_idx ON boosts(owner_id, created_at DESC);
CREATE UNIQUE INDEX boosts_one_live_per_target ON boosts(target_type, target_id, placement) WHERE status IN ('pending_payment','active');

-- ------------------------------------------------------------------ payments
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('order','booking','boost')),
  order_id uuid REFERENCES orders(id),
  booking_id uuid REFERENCES bookings(id),
  boost_id uuid REFERENCES boosts(id),
  payer_id uuid NOT NULL REFERENCES users(id),
  payee_id uuid REFERENCES users(id),                 -- NULL for boosts: the platform is the payee
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  fee_cents int NOT NULL DEFAULT 0 CHECK (fee_cents >= 0 AND fee_cents <= amount_cents),
  currency char(3) NOT NULL DEFAULT 'CAD',
  fee_scope text, fee_percent_bps int, fee_fixed_cents int,   -- snapshot of the fee rule applied: later rule edits never change past payments
  status text NOT NULL DEFAULT 'requires_payment' CHECK (status IN ('requires_payment','processing','succeeded','failed','canceled','partially_refunded','refunded')),
  provider text NOT NULL CHECK (provider IN ('stripe','fake')),
  provider_payment_id text UNIQUE,
  provider_charge_id text,
  refunded_cents int NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  failure_reason text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  CHECK ((kind = 'order' AND order_id IS NOT NULL AND booking_id IS NULL AND boost_id IS NULL AND payee_id IS NOT NULL)
      OR (kind = 'booking' AND booking_id IS NOT NULL AND order_id IS NULL AND boost_id IS NULL AND payee_id IS NOT NULL)
      OR (kind = 'boost' AND boost_id IS NOT NULL AND order_id IS NULL AND booking_id IS NULL AND payee_id IS NULL))
);
-- one live payment per thing being paid for: the database stops double charging even if the app has a bug
CREATE UNIQUE INDEX payments_one_live_order ON payments(order_id) WHERE order_id IS NOT NULL AND status IN ('requires_payment','processing','succeeded','partially_refunded');
CREATE UNIQUE INDEX payments_one_live_booking ON payments(booking_id) WHERE booking_id IS NOT NULL AND status IN ('requires_payment','processing','succeeded','partially_refunded');
CREATE UNIQUE INDEX payments_one_live_boost ON payments(boost_id) WHERE boost_id IS NOT NULL AND status IN ('requires_payment','processing','succeeded','partially_refunded');
CREATE INDEX payments_payer_idx ON payments(payer_id, created_at DESC);
CREATE INDEX payments_payee_idx ON payments(payee_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments(status, created_at);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  reason text,
  source text NOT NULL CHECK (source IN ('seller','admin','dispute','cancellation','provider')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  provider_refund_id text UNIQUE,
  initiated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds(payment_id);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_payout_id text NOT NULL UNIQUE,
  amount_cents int NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CAD',
  status text NOT NULL,
  arrival_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_user_idx ON payouts(user_id, created_at DESC);

-- webhook idempotency: each provider event is applied at most once
CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  provider text NOT NULL,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE orders ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','partially_refunded','refunded'));
ALTER TABLE bookings ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','partially_refunded','refunded'));

-- ------------------------------------------------------------------ disputes between the two parties (not card chargebacks)
CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(id),
  order_id uuid REFERENCES orders(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  other_party_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (reason IN ('not_delivered','damaged','not_as_described','late','no_show','overcharged','other')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 10 AND 3000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','withdrawn')),
  resolution text CHECK (resolution IN ('refund_full','refund_partial','no_refund')),
  refund_cents int CHECK (refund_cents >= 0),
  resolution_note text,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((booking_id IS NOT NULL) <> (order_id IS NOT NULL))
);
CREATE UNIQUE INDEX disputes_one_open_booking ON disputes(booking_id) WHERE booking_id IS NOT NULL AND status = 'open';
CREATE UNIQUE INDEX disputes_one_open_order ON disputes(order_id) WHERE order_id IS NOT NULL AND status = 'open';
CREATE INDEX disputes_status_idx ON disputes(status, created_at);
CREATE TABLE dispute_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  staff boolean NOT NULL DEFAULT false,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_messages_idx ON dispute_messages(dispute_id, created_at);

-- ------------------------------------------------------------------ permissions, fee scopes, settings
INSERT INTO permissions(key, description) VALUES ('manage.payments', 'View payments, issue refunds, resolve disputes, manage boosts and see revenue');
INSERT INTO role_permissions(role_key, permission_key) VALUES ('admin','manage.payments'), ('super_admin','manage.payments');
ALTER TABLE fee_rules DROP CONSTRAINT fee_rules_scope_check;
ALTER TABLE fee_rules ADD CONSTRAINT fee_rules_scope_check CHECK (scope IN ('product_sale','transport_booking','premium_listing','featured_service','sponsored'));
INSERT INTO fee_rules(scope, percent_bps, fixed_cents) VALUES ('sponsored', 0, 1499);
INSERT INTO platform_settings(key, value, description) VALUES
 ('payments.enabled', 'true', 'Allow card payments through Stripe'),
 ('payments.required_for_pickup', 'false', 'Drivers cannot confirm pickup until the booking is paid on twiqo'),
 ('payments.payout_delay_days', '7', 'Days Stripe waits before paying out to a seller or driver (set on new connected accounts)'),
 ('payments.refund_platform_fee', 'true', 'Give back the platform commission proportionally on refunds'),
 ('payments.dispute_window_days', '14', 'Days after completion within which a dispute can be opened'),
 ('boost.days', '7', 'Length of a featured or sponsored boost'),
 ('ads.every_n', '8', 'At most one sponsored item per this many feed items')
ON CONFLICT DO NOTHING;
