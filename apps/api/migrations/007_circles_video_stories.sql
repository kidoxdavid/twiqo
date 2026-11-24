-- Phase 3: videos, polls, Circles (groups), events, stories

-- ------------------------------------------------------------------ videos (provider-agnostic: local ffmpeg or Bunny Stream)
CREATE TABLE videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('local','bunny')),
  provider_video_id text,
  title text,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','processing','ready','failed','rejected','removed')),
  duration_s numeric(7,2), width int, height int, bytes bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  UNIQUE (provider, provider_video_id)
);
CREATE INDEX videos_owner_idx ON videos(owner_id, created_at DESC);

-- ------------------------------------------------------------------ Circles
CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,50}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  category text CHECK (char_length(category) <= 40),
  city text, province char(2), location geography(Point,4326),
  cover_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  join_policy text NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','approval')),
  who_can_post text NOT NULL DEFAULT 'members' CHECK (who_can_post IN ('members','moderators')),
  allow_commerce boolean NOT NULL DEFAULT true,   -- members may attach listings / journeys / requests / services
  rules text NOT NULL DEFAULT '' CHECK (char_length(rules) <= 3000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  member_count int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name,'')),'A') || setweight(to_tsvector('english', coalesce(category,'')),'B') || setweight(to_tsvector('english', coalesce(description,'')),'C')) STORED
);
CREATE INDEX groups_search_idx ON groups USING gin(search_vector);
CREATE INDEX groups_loc_idx ON groups USING gist(location);
CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','moderator','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','invited','banned')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members(user_id, status);
-- exactly one owner per group
CREATE UNIQUE INDEX group_one_owner ON group_members(group_id) WHERE role = 'owner';
CREATE TABLE group_pins (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  pinned_by uuid REFERENCES users(id),
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, post_id)
);

ALTER TABLE posts DROP CONSTRAINT posts_visibility_check;
ALTER TABLE posts ADD CONSTRAINT posts_visibility_check CHECK (visibility IN ('public','followers','private','group'));
ALTER TABLE feed_items DROP CONSTRAINT feed_items_visibility_check;
ALTER TABLE feed_items ADD CONSTRAINT feed_items_visibility_check CHECK (visibility IN ('public','followers','private','group'));
ALTER TABLE posts ADD CONSTRAINT posts_group_fk FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE feed_items ADD CONSTRAINT feed_items_group_fk FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
CREATE INDEX posts_group_idx ON posts(group_id, created_at DESC) WHERE group_id IS NOT NULL;
CREATE INDEX feed_group_idx ON feed_items(group_id, created_at DESC) WHERE group_id IS NOT NULL;

-- ------------------------------------------------------------------ video posts and polls
ALTER TABLE posts ADD COLUMN video_id uuid REFERENCES videos(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN view_count int NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN poll_closes_at timestamptz;
CREATE INDEX posts_video_idx ON posts(created_at DESC) WHERE video_id IS NOT NULL;
CREATE TABLE post_views (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewer_key text NOT NULL,                 -- user id, or a hash of ip for signed-out viewers
  day date NOT NULL DEFAULT current_date,
  PRIMARY KEY (post_id, viewer_key, day)
);
CREATE TABLE poll_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 80),
  position smallint NOT NULL,
  vote_count int NOT NULL DEFAULT 0
);
CREATE INDEX poll_options_post_idx ON poll_options(post_id, position);
CREATE TABLE poll_votes (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)            -- one vote per person per poll
);

-- ------------------------------------------------------------------ events
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 3000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  city text, province char(2), location geography(Point,4326), venue text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','removed')),
  going_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX events_group_idx ON events(group_id, starts_at);
CREATE INDEX events_time_idx ON events(starts_at) WHERE status = 'scheduled';
CREATE TABLE event_rsvps (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'going' CHECK (status IN ('going','interested')),
  PRIMARY KEY (event_id, user_id)
);

-- ------------------------------------------------------------------ stories
CREATE TABLE stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('photo','video','text')),
  media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  video_id uuid REFERENCES videos(id) ON DELETE SET NULL,
  text_body text CHECK (char_length(text_body) <= 300),
  bg text CHECK (bg ~ '^#[0-9A-Fa-f]{6}$'),
  link_type text CHECK (link_type IN ('listing','business')),
  link_id uuid,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','removed')),
  view_count int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((link_type IS NULL) = (link_id IS NULL)),
  CHECK ((kind = 'photo' AND media_id IS NOT NULL) OR (kind = 'video' AND video_id IS NOT NULL) OR (kind = 'text' AND text_body IS NOT NULL))
);
CREATE INDEX stories_author_idx ON stories(author_id, created_at DESC);
CREATE INDEX stories_active_idx ON stories(expires_at) WHERE status = 'active';
CREATE TABLE story_views (
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);

ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user','post','comment','listing','business','message','transport_request','journey','transport_service','group','video','story','event'));

INSERT INTO platform_settings(key,value,description) VALUES
 ('video.max_mb','200','Largest video upload'),
 ('video.max_seconds','90','Longest clip or story video'),
 ('circle.max_owned_per_user','10','Circles one person may own'),
 ('clips.min_account_age_hours','24','Accounts younger than this are only shown to people who follow them'),
 ('event.reminder_hours','24','Send event reminders this long before the start')
ON CONFLICT DO NOTHING;
