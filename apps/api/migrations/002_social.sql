-- Businesses, social graph, posts, interactions, feed, notifications
CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  description text,
  category text,
  logo_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  cover_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  contact_email citext, phone text,
  city text, province char(2),
  service_radius_km int CHECK (service_radius_km IS NULL OR service_radius_km >= 0),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  follower_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business_members (
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager','listing_manager','customer_support','delivery_coordinator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_members_user_idx ON business_members(user_id);

-- Follow a user or a business
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('user','business')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, target_type, target_id),
  CHECK (NOT (target_type = 'user' AND follower_id = target_id))
);
CREATE INDEX follows_target_idx ON follows(target_type, target_id);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks(blocked_id);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  group_id uuid,                                   -- FK added with communities (phase 3)
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','photo','video','poll','share')),
  body text CHECK (char_length(body) <= 5000),
  attachment_type text CHECK (attachment_type IN ('listing','transport_request','journey','transport_service','event','business')),
  attachment_id uuid,                              -- reference only; never the source of truth
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers','private')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','pending')),
  location geography(Point,4326),
  like_count int NOT NULL DEFAULT 0, comment_count int NOT NULL DEFAULT 0,
  share_count int NOT NULL DEFAULT 0, save_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((attachment_type IS NULL) = (attachment_id IS NULL)),
  CHECK (body IS NOT NULL OR kind <> 'text')
);
CREATE INDEX posts_author_idx ON posts(author_id, created_at DESC);
CREATE INDEX posts_loc_idx ON posts USING gist(location);
CREATE TABLE post_media (
  post_id uuid REFERENCES posts(id) ON DELETE CASCADE,
  media_id uuid REFERENCES media_assets(id) ON DELETE CASCADE,
  position smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, media_id)
);

-- Threaded comments on any commentable object
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('post','listing','transport_request','journey','event')),
  target_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  like_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_target_idx ON comments(target_type, target_id, created_at);
CREATE INDEX comments_parent_idx ON comments(parent_id);

CREATE TABLE reactions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','listing','transport_request','journey')),
  target_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'like' CHECK (kind IN ('like')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id, kind)
);
CREATE INDEX reactions_target_idx ON reactions(target_type, target_id);

CREATE TABLE saved_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','listing','transport_request','journey','business')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('user','post','comment','listing','business','message','transport_request','journey','group','video')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('spam','prohibited_item','fraud','harassment','nudity','violence','misleading','other')),
  details text CHECK (char_length(details) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX reports_open_idx ON reports(status, created_at);

-- Unified feed reference layer. Source of truth stays in the domain table.
CREATE TABLE feed_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL CHECK (item_type IN ('post','listing','transport_request','journey','transport_service','event','promotion')),
  item_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  group_id uuid,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers','private')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','pending')),
  sponsored boolean NOT NULL DEFAULT false,
  location geography(Point,4326),
  rank_hint real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_type, item_id)
);
CREATE INDEX feed_cursor_idx ON feed_items(created_at DESC, id DESC) WHERE status = 'active';
CREATE INDEX feed_author_idx ON feed_items(author_id, created_at DESC);
CREATE INDEX feed_loc_idx ON feed_items USING gist(location);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_type text, target_id uuid,
  data jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
