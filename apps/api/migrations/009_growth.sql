-- Phase 5: growth. Referrals + credits, subscriptions, analytics events, locale.

ALTER TABLE users ADD COLUMN referral_code text UNIQUE CHECK (referral_code ~ '^[a-z0-9]{6,12}$');
ALTER TABLE users ADD COLUMN referred_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fr'));

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referee_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,   -- a person can be referred once
  status text NOT NULL DEFAULT 'signed_up' CHECK (status IN ('signed_up','qualified','rejected')),
  qualified_at timestamptz,
  reward_cents int NOT NULL DEFAULT 0 CHECK (reward_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referee_id)
);
CREATE INDEX referrals_referrer_idx ON referrals(referrer_id, created_at DESC);

-- Append-only ledger of twiqo credit. Balance = sum(amount_cents). Spending is serialised by locking the user row.
CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents int NOT NULL CHECK (amount_cents <> 0),
  reason text NOT NULL CHECK (reason IN ('referral_reward','boost_purchase','admin_adjustment','boost_refund')),
  ref_type text, ref_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger(user_id, id DESC);
-- one reward per referral
CREATE UNIQUE INDEX credit_ledger_referral_once ON credit_ledger(ref_id) WHERE reason = 'referral_reward';
CREATE FUNCTION credit_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'credit_ledger is append-only'; END $$;
CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION credit_ledger_immutable();

-- credit applied to a boost (the rest, if any, is paid by card)
ALTER TABLE boosts ADD COLUMN credit_cents int NOT NULL DEFAULT 0 CHECK (credit_cents >= 0);

CREATE TABLE subscriptions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'business_pro' CHECK (plan IN ('business_pro')),
  status text NOT NULL CHECK (status IN ('incomplete','active','past_due','canceled')),
  provider text NOT NULL,
  provider_customer_id text, provider_subscription_id text UNIQUE,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- First-party product analytics. No IP addresses; anonymous visitors are a random per-browser id; pruned after 180 days.
CREATE TABLE analytics_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  anon_id text CHECK (char_length(anon_id) <= 40),
  name text NOT NULL CHECK (name IN ('view','search','share','contact_click','signup','listing_created','offer_made','order_created')),
  target_type text, target_id uuid,
  props jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_target_idx ON analytics_events(target_type, target_id, created_at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX analytics_name_time_idx ON analytics_events(name, created_at DESC);
CREATE INDEX analytics_user_time_idx ON analytics_events(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- performance: indexes the new discovery queries rely on
CREATE INDEX IF NOT EXISTS reactions_recent_idx ON reactions(target_type, created_at DESC);
CREATE INDEX IF NOT EXISTS saved_recent_idx ON saved_items(target_type, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_active_cat_idx ON listings(category_id, created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS listings_tags_idx ON listings USING gin(tags);
CREATE INDEX IF NOT EXISTS posts_recent_idx ON posts(created_at DESC) WHERE status = 'active';

INSERT INTO platform_settings(key, value, description) VALUES
 ('referral.enabled', 'true', 'Referral programme on or off'),
 ('referral.reward_cents', '500', 'twiqo credit given to the referrer when a referred person completes their first deal'),
 ('referral.max_rewards_per_user', '20', 'Cap on rewarded referrals per person (abuse limit)'),
 ('subscription.enabled', 'true', 'Allow Business Pro subscriptions'),
 ('subscription.business_pro_cents', '2900', 'Monthly price shown for Business Pro (the real price is the Stripe Price)'),
 ('subscription.fee_discount_bps', '100', 'Percentage points (in basis points) taken off the sale and booking commission for Business Pro members'),
 ('analytics.enabled', 'true', 'Record first-party product analytics events'),
 ('discover.trending_window_days', '7', 'How far back trending looks');

INSERT INTO permissions(key, description) VALUES ('view.growth', 'View growth analytics, funnels and referral stats');
INSERT INTO role_permissions(role_key, permission_key) VALUES ('admin','view.growth'), ('super_admin','view.growth');

-- existing users get a referral code
UPDATE users SET referral_code = substr(md5(id::text || 'twiqo'), 1, 8) WHERE referral_code IS NULL;
