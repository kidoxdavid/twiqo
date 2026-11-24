-- Phase 6C: identity verification, driver documents, risk flags, safety tools, blind reviews, instant book.

ALTER TABLE user_profiles ADD COLUMN identity_verified_at timestamptz;
CREATE TABLE identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_session_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','verified','requires_input','canceled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz
);
CREATE INDEX identity_user_idx ON identity_verifications(user_id, created_at DESC);

-- Photos of licences and insurance are private: stored outside the public /media folder and only readable by the owner and reviewers.
CREATE TABLE driver_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('drivers_licence','vehicle_registration','insurance')),
  file_key text NOT NULL, mime text NOT NULL,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','replaced')),
  reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, review_note text,
  expiry_warned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_docs_user_idx ON driver_documents(user_id, kind, created_at DESC);
CREATE INDEX driver_docs_pending_idx ON driver_documents(created_at) WHERE status = 'pending';
INSERT INTO permissions(key, description) VALUES ('review.documents', 'Review driver documents and handle safety incidents');
INSERT INTO role_permissions(role_key, permission_key) VALUES ('moderator','review.documents'), ('admin','review.documents'), ('super_admin','review.documents');

ALTER TABLE journeys ADD COLUMN instant_book boolean NOT NULL DEFAULT false;

CREATE TABLE risk_events (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('listing','message','journey','request','user')),
  entity_id uuid, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  score int NOT NULL, reasons text[] NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, note text
);
CREATE INDEX risk_open_idx ON risk_events(created_at DESC) WHERE status = 'open';
ALTER TABLE messages ADD COLUMN flags text[] NOT NULL DEFAULT '{}';

CREATE TABLE emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  email text, phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE TABLE trip_shares (
  token text PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_shares_booking_idx ON trip_shares(booking_id);
ALTER TABLE bookings ADD COLUMN share_location boolean NOT NULL DEFAULT false;
CREATE TABLE booking_locations (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90), lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m int, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_locations_idx ON booking_locations(booking_id, id DESC);
CREATE TABLE safety_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text CHECK (char_length(message) <= 500),
  lat double precision, lng double precision,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_by uuid REFERENCES users(id), resolved_at timestamptz, resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_open_idx ON safety_incidents(created_at DESC) WHERE status = 'open';
ALTER TABLE delivery_events ADD COLUMN lat double precision, ADD COLUMN lng double precision;   -- GPS captured with a PIN confirmation, visible to the two parties only

ALTER TABLE reviews ADD COLUMN revealed_at timestamptz;
UPDATE reviews SET revealed_at = created_at;
CREATE INDEX reviews_hidden_idx ON reviews(created_at) WHERE revealed_at IS NULL;

INSERT INTO platform_settings(key, value, description) VALUES
 ('transport.require_verified_driver', 'false', 'Drivers must have verified identity and an approved driving licence before posting journeys or services (recommended on at launch)'),
 ('transport.required_documents', '["drivers_licence"]', 'Document kinds a verified driver must have approved and unexpired'),
 ('instant_book.min_completed', '3', 'Completed bookings a driver needs (unless identity-verified) before turning on instant book'),
 ('instant_book.min_account_age_hours', '24', 'Shipper accounts must be at least this old to use instant book'),
 ('risk.flag_threshold', '3', 'Risk score at which a new listing is held for review'),
 ('risk.new_account_hours', '72', 'Accounts younger than this get the tighter limits below'),
 ('risk.new_listings_per_day', '5', 'Listings per day for a new account (established accounts get 5x)'),
 ('risk.new_conversations_per_hour', '15', 'New conversations per hour for a new account (established accounts get 5x)'),
 ('risk.new_offers_per_hour', '15', 'Offers per hour for a new account (established accounts get 5x)'),
 ('reviews.reveal_after_days', '7', 'A review stays hidden until the other person reviews too, or this many days pass'),
 ('safety.sos_per_hour', '3', 'SOS alerts one person can send per hour');
INSERT INTO platform_settings(key, value, description) VALUES ('risk.max_identical_listings', '5', 'Most listings one person can have with the same title in 30 days (stops copy-paste spam)') ON CONFLICT DO NOTHING;
