-- Phase 6B: notification channels, web push, saved searches, price-drop alerts.

ALTER TABLE users ADD COLUMN email_notifications_off boolean NOT NULL DEFAULT false;   -- one-click unsubscribe from non-essential email

CREATE TABLE notification_channels (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','push')),
  enabled boolean NOT NULL,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL, auth text NOT NULL,
  user_agent text,
  failures int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), last_success_at timestamptz
);
CREATE INDEX push_user_idx ON push_subscriptions(user_id);

CREATE TABLE saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('listing','journey','request')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  params jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_alert_at timestamptz
);
CREATE INDEX saved_searches_kind_idx ON saved_searches(kind) WHERE active;
CREATE INDEX saved_searches_user_idx ON saved_searches(user_id);
CREATE TABLE saved_search_hits (
  search_id uuid NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_id, item_id)
);

INSERT INTO platform_settings(key, value, description) VALUES
 ('saved_search.max_per_user', '20', 'How many saved searches one person can keep'),
 ('saved_search.max_alerts_per_day', '10', 'Alerts per saved search per day (the rest are dropped, not queued)'),
 ('notifications.digest_enabled', 'true', 'Send one email summarising unread notifications to people who have been away for a while'),
 ('notifications.price_drop_min_percent', '5', 'Smallest price drop that alerts people who saved the item');

ALTER TABLE outbox_emails ADD COLUMN unsubscribe_url text;
