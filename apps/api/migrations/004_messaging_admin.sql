-- Messaging, moderation, audit, platform configuration
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct','business','listing','transport','group')),
  subject_type text, subject_id uuid,
  pair_key text,                                  -- sorted "userA:userB" to dedupe 1:1 threads
  created_by uuid NOT NULL REFERENCES users(id),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX conversations_pair_uidx ON conversations(pair_key, coalesce(subject_type,''), coalesce(subject_id, '00000000-0000-0000-0000-000000000000')) WHERE pair_key IS NOT NULL;
CREATE TABLE conversation_members (
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT 'epoch',
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members(user_id);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','attachment','offer','booking','system')),
  body text CHECK (char_length(body) <= 4000),
  media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',          -- structured cards live here, separate from chat text
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'text' OR body IS NOT NULL)
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, created_at DESC);

CREATE TABLE moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moderator_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('remove','restore','warn','suspend','ban','unban','dismiss_report')),
  reason text NOT NULL,
  report_id uuid REFERENCES reports(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_target_idx ON moderation_actions(target_type, target_id);

CREATE TABLE appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderation_action_id uuid REFERENCES moderation_actions(id),
  message text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','overturned')),
  decided_by uuid REFERENCES users(id), decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text, target_id text,
  before jsonb, after jsonb, ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_actor_idx ON audit_logs(actor_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_logs(created_at DESC);
-- append-only
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_immutable();

CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings(key,value,description) VALUES
 ('story.expiry_hours','24','Default story lifetime'),
 ('listing.default_expiry_days','30','Listing lifetime before renewal is required'),
 ('listing.max_images','10','Maximum images per listing'),
 ('search.default_radius_km','25','Default nearby radius'),
 ('feed.weights','{"recency":1.0,"following":2.0,"engagement":0.5,"proximity":0.8}','Feed ranking weights'),
 ('upload.max_image_mb','10','Maximum image upload size'),
 ('moderation.new_account_listing_review','false','Hold first listings from new accounts for review');

CREATE TABLE banned_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term citext NOT NULL UNIQUE,
  severity text NOT NULL DEFAULT 'block' CHECK (severity IN ('block','flag')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Commission/fee rules are data, never constants (applied from phase 4)
CREATE TABLE fee_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('product_sale','transport_booking','premium_listing','featured_service')),
  percent_bps int NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  fixed_cents int NOT NULL DEFAULT 0 CHECK (fixed_cents >= 0),
  min_cents int, max_cents int,
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fee_rules(scope,percent_bps,fixed_cents) VALUES
 ('product_sale',0,0),('transport_booking',0,0),('premium_listing',0,499),('featured_service',0,999);
