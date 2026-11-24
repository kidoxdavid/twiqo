-- Phase 6A: job queue, email outbox, account security, consent, deletion.

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at timestamptz,
  done_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs(run_at) WHERE done_at IS NULL;
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND done_at IS NULL;

CREATE TABLE outbox_emails (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  template text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX outbox_user_idx ON outbox_emails(user_id, created_at DESC);

CREATE TABLE user_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify_email','reset_password','change_email')),
  token_hash text NOT NULL UNIQUE,
  data jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user_idx ON user_tokens(user_id, kind);

ALTER TABLE users ADD COLUMN totp_secret_enc text;            -- AES-GCM encrypted; null until set up
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step bigint;           -- replay protection
ALTER TABLE users ADD COLUMN terms_version text;
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;

CREATE TABLE recovery_codes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);

ALTER TABLE sessions ADD COLUMN device_hash text;
ALTER TABLE sessions ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE known_devices (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash text NOT NULL,
  label text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);

INSERT INTO platform_settings(key, value, description) VALUES
 ('terms.version', '"2026-01-draft"', 'Version of the Terms and Privacy Policy people accept at sign-up'),
 ('security.require_verified_email_to_sell', 'false', 'People must verify their email before listing items'),
 ('account.delete_blocked_while_active_deals', 'true', 'Account deletion waits until open orders, bookings and disputes are finished');
