-- Identity, media, profiles, RBAC
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  username citext NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.]{3,30}$'),
  password_hash text NOT NULL,
  account_type text NOT NULL DEFAULT 'individual' CHECK (account_type IN ('individual','business')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned','deleted')),
  suspended_until timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  email_verified_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image','video','file')),
  storage_key text NOT NULL UNIQUE,
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  width int, height int,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('processing','ready','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_owner_idx ON media_assets(owner_id, created_at DESC);

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  bio text CHECK (char_length(bio) <= 500),
  avatar_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  cover_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  city text, province char(2), postal_fsa varchar(3),
  location geography(Point,4326),   -- coarse (grid-snapped) point only, never an address
  privacy jsonb NOT NULL DEFAULT '{"show_followers":true,"show_location":true,"show_transport_history":false,"allow_messages":"everyone"}',
  verification_level text NOT NULL DEFAULT 'none' CHECK (verification_level IN ('none','email','identity')),
  follower_count int NOT NULL DEFAULT 0,
  following_count int NOT NULL DEFAULT 0
);
CREATE INDEX profiles_loc_idx ON user_profiles USING gist(location);
CREATE INDEX profiles_name_trgm ON user_profiles USING gin(display_name gin_trgm_ops);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  user_agent text, ip inet,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE roles (key text PRIMARY KEY, name text NOT NULL);
CREATE TABLE permissions (key text PRIMARY KEY, description text NOT NULL);
CREATE TABLE role_permissions (
  role_key text REFERENCES roles(key) ON DELETE CASCADE,
  permission_key text REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);
CREATE TABLE user_roles (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role_key text REFERENCES roles(key) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_key)
);

INSERT INTO roles(key,name) VALUES ('moderator','Moderator'),('admin','Administrator'),('super_admin','Super administrator');
INSERT INTO permissions(key,description) VALUES
 ('moderate.content','Remove/restore content and resolve reports'),
 ('manage.users','Suspend, ban and restore users'),
 ('manage.categories','Create, edit, reorder and disable categories'),
 ('manage.settings','Edit platform settings and banned words'),
 ('manage.fees','Edit commission and fee rules'),
 ('view.audit','Read the audit log'),
 ('view.analytics','Read dashboard analytics'),
 ('manage.admins','Grant or revoke admin roles');
INSERT INTO role_permissions(role_key,permission_key) VALUES
 ('moderator','moderate.content'),
 ('admin','moderate.content'),('admin','manage.users'),('admin','manage.categories'),('admin','manage.settings'),('admin','view.audit'),('admin','view.analytics'),
 ('super_admin','moderate.content'),('super_admin','manage.users'),('super_admin','manage.categories'),('super_admin','manage.settings'),('super_admin','manage.fees'),('super_admin','view.audit'),('super_admin','view.analytics'),('super_admin','manage.admins');
