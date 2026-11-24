-- Admin-managed category tree + listings
CREATE FUNCTION tags_to_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES categories(id) ON DELETE RESTRICT,
  slug citext NOT NULL UNIQUE,
  name text NOT NULL,
  icon text,
  position int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_restricted boolean NOT NULL DEFAULT false,   -- restricted items need review before going live
  restriction_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_parent_idx ON categories(parent_id, position);

CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  category_id uuid NOT NULL REFERENCES categories(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 8000),
  price_cents int NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  price_type text NOT NULL DEFAULT 'fixed' CHECK (price_type IN ('fixed','negotiable','free')),
  condition text NOT NULL DEFAULT 'good' CHECK (condition IN ('new','like_new','good','fair','for_parts')),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','pending_review','active','reserved','sold','expired','removed')),
  city text, province char(2), postal_fsa varchar(3),
  location geography(Point,4326),               -- coarse only
  fulfillment jsonb NOT NULL DEFAULT '{"pickup":true,"delivery":false,"shipping":false}',
  tags text[] NOT NULL DEFAULT '{}',
  attributes jsonb NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','followers','private')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  view_count int NOT NULL DEFAULT 0,
  like_count int NOT NULL DEFAULT 0, comment_count int NOT NULL DEFAULT 0, save_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')),'A') ||
    setweight(to_tsvector('english', tags_to_text(tags)),'B') ||
    setweight(to_tsvector('english', coalesce(description,'')),'C')
  ) STORED,
  CHECK (price_type <> 'free' OR price_cents = 0)
);
CREATE INDEX listings_search_idx ON listings USING gin(search_vector);
CREATE INDEX listings_title_trgm ON listings USING gin(title gin_trgm_ops);
CREATE INDEX listings_loc_idx ON listings USING gist(location);
CREATE INDEX listings_browse_idx ON listings(category_id, status, created_at DESC);
CREATE INDEX listings_seller_idx ON listings(seller_id, created_at DESC);

CREATE TABLE listing_media (
  listing_id uuid REFERENCES listings(id) ON DELETE CASCADE,
  media_id uuid REFERENCES media_assets(id) ON DELETE CASCADE,
  position smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, media_id)
);

CREATE INDEX posts_search_idx ON posts USING gin(to_tsvector('english', coalesce(body,'')));
