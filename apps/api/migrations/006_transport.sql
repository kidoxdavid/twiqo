-- Phase 2: transport marketplace, offers, bookings, orders, reviews, notification preferences
INSERT INTO places(city,province,location) VALUES
('Sherbrooke','QC',ST_SetSRID(ST_MakePoint(-71.8929,45.4042),4326)::geography),
('Trois-Rivieres','QC',ST_SetSRID(ST_MakePoint(-72.5476,46.3432),4326)::geography),
('Saguenay','QC',ST_SetSRID(ST_MakePoint(-71.0686,48.428),4326)::geography),
('Guelph','ON',ST_SetSRID(ST_MakePoint(-80.2482,43.5448),4326)::geography),
('Barrie','ON',ST_SetSRID(ST_MakePoint(-79.6903,44.3894),4326)::geography),
('Kingston','ON',ST_SetSRID(ST_MakePoint(-76.486,44.2312),4326)::geography),
('Sudbury','ON',ST_SetSRID(ST_MakePoint(-80.993,46.4917),4326)::geography),
('Oshawa','ON',ST_SetSRID(ST_MakePoint(-78.8658,43.8971),4326)::geography),
('St. Catharines','ON',ST_SetSRID(ST_MakePoint(-79.2469,43.1594),4326)::geography),
('Peterborough','ON',ST_SetSRID(ST_MakePoint(-78.3197,44.3091),4326)::geography),
('Sault Ste. Marie','ON',ST_SetSRID(ST_MakePoint(-84.3461,46.5219),4326)::geography),
('North Bay','ON',ST_SetSRID(ST_MakePoint(-79.4608,46.3091),4326)::geography),
('Moose Jaw','SK',ST_SetSRID(ST_MakePoint(-105.5519,50.3934),4326)::geography),
('Prince Albert','SK',ST_SetSRID(ST_MakePoint(-105.7531,53.2033),4326)::geography),
('Swift Current','SK',ST_SetSRID(ST_MakePoint(-107.7939,50.2881),4326)::geography),
('Portage la Prairie','MB',ST_SetSRID(ST_MakePoint(-98.2926,49.9728),4326)::geography),
('Steinbach','MB',ST_SetSRID(ST_MakePoint(-96.6845,49.5253),4326)::geography),
('Nanaimo','BC',ST_SetSRID(ST_MakePoint(-123.9401,49.1659),4326)::geography),
('Prince George','BC',ST_SetSRID(ST_MakePoint(-122.7497,53.9171),4326)::geography),
('Cranbrook','BC',ST_SetSRID(ST_MakePoint(-115.7694,49.513),4326)::geography),
('Revelstoke','BC',ST_SetSRID(ST_MakePoint(-118.1957,50.9981),4326)::geography),
('Golden','BC',ST_SetSRID(ST_MakePoint(-116.9631,51.2961),4326)::geography),
('Fort McMurray','AB',ST_SetSRID(ST_MakePoint(-111.381,56.7268),4326)::geography),
('Grande Prairie','AB',ST_SetSRID(ST_MakePoint(-118.7947,55.1707),4326)::geography),
('Brooks','AB',ST_SetSRID(ST_MakePoint(-111.8989,50.5642),4326)::geography),
('Camrose','AB',ST_SetSRID(ST_MakePoint(-112.8333,53.0167),4326)::geography),
('Canmore','AB',ST_SetSRID(ST_MakePoint(-115.3479,51.0884),4326)::geography),
('Truro','NS',ST_SetSRID(ST_MakePoint(-63.2859,45.3657),4326)::geography),
('Sydney','NS',ST_SetSRID(ST_MakePoint(-60.1942,46.1368),4326)::geography),
('Bathurst','NB',ST_SetSRID(ST_MakePoint(-65.6514,47.6186),4326)::geography),
('Corner Brook','NL',ST_SetSRID(ST_MakePoint(-57.9526,48.9501),4326)::geography),
('Gander','NL',ST_SetSRID(ST_MakePoint(-54.6089,48.9578),4326)::geography),
('Dawson City','YT',ST_SetSRID(ST_MakePoint(-139.4328,64.0601),4326)::geography),
('Thompson','MB',ST_SetSRID(ST_MakePoint(-97.8551,55.7435),4326)::geography),
('Rimouski','QC',ST_SetSRID(ST_MakePoint(-68.5236,48.4488),4326)::geography)
ON CONFLICT DO NOTHING;

CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, type)
);

-- ---------------------------------------------------------------- transport requests
CREATE TABLE transport_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  linked_listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  item_category text NOT NULL DEFAULT 'other' CHECK (item_category IN ('furniture','appliances','boxes','tires','bikes','equipment','building_materials','vehicle_parts','electronics','other')),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 500),
  weight_kg numeric(8,2) NOT NULL CHECK (weight_kg > 0),
  length_cm int CHECK (length_cm > 0), width_cm int CHECK (width_cm > 0), height_cm int CHECK (height_cm > 0),
  fragile boolean NOT NULL DEFAULT false,
  special_handling text,
  needs_loading_help boolean NOT NULL DEFAULT false,
  needs_unloading_help boolean NOT NULL DEFAULT false,
  origin_city text NOT NULL, origin_province char(2) NOT NULL, origin geography(Point,4326) NOT NULL, pickup_area text,
  dest_city text NOT NULL, dest_province char(2) NOT NULL, dest geography(Point,4326) NOT NULL, delivery_area text,
  pickup_from date NOT NULL,
  pickup_to date NOT NULL,
  deliver_by date,
  budget_cents int CHECK (budget_cents >= 0),
  price_type text NOT NULL DEFAULT 'negotiable' CHECK (price_type IN ('fixed','negotiable')),
  preferred_vehicles text[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','completed','cancelled','expired','removed')),
  like_count int NOT NULL DEFAULT 0, comment_count int NOT NULL DEFAULT 0, save_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title,'')),'A') || setweight(to_tsvector('english', coalesce(description,'')),'C')) STORED,
  CHECK (pickup_to >= pickup_from),
  CHECK (deliver_by IS NULL OR deliver_by >= pickup_from)
);
CREATE INDEX treq_origin_idx ON transport_requests USING gist(origin);
CREATE INDEX treq_dest_idx ON transport_requests USING gist(dest);
CREATE INDEX treq_browse_idx ON transport_requests(status, pickup_from);
CREATE INDEX treq_owner_idx ON transport_requests(requester_id, created_at DESC);
CREATE INDEX treq_search_idx ON transport_requests USING gin(search_vector);
CREATE TABLE transport_request_media (
  request_id uuid REFERENCES transport_requests(id) ON DELETE CASCADE,
  media_id uuid REFERENCES media_assets(id) ON DELETE CASCADE,
  position smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, media_id)
);

-- ---------------------------------------------------------------- journeys (available transportation with a route)
CREATE TABLE journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  origin_city text NOT NULL, origin_province char(2) NOT NULL, origin geography(Point,4326) NOT NULL,
  dest_city text NOT NULL, dest_province char(2) NOT NULL, dest geography(Point,4326) NOT NULL,
  waypoints jsonb NOT NULL DEFAULT '[]',
  route geography(LineString,4326) NOT NULL,       -- origin → waypoints → destination; matching uses distance to this line, not a straight origin/destination pair
  distance_km int NOT NULL CHECK (distance_km >= 0),
  max_detour_km int NOT NULL DEFAULT 15 CHECK (max_detour_km BETWEEN 0 AND 500),
  departure_at timestamptz NOT NULL,
  arrival_at timestamptz,
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('car','suv','pickup_truck','cargo_van','box_truck','trailer','other')),
  capacity_kg int NOT NULL CHECK (capacity_kg > 0),
  capacity_m3 numeric(6,2) CHECK (capacity_m3 > 0),
  remaining_kg int NOT NULL,
  remaining_m3 numeric(6,2),
  max_length_cm int CHECK (max_length_cm > 0), max_width_cm int CHECK (max_width_cm > 0), max_height_cm int CHECK (max_height_cm > 0),
  item_restrictions text[] NOT NULL DEFAULT '{}',
  price_cents int NOT NULL CHECK (price_cents >= 0),
  price_type text NOT NULL DEFAULT 'negotiable' CHECK (price_type IN ('fixed','negotiable')),
  pickup_preferences text, delivery_preferences text,
  helps_loading boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','full','departed','completed','cancelled','expired','removed')),
  like_count int NOT NULL DEFAULT 0, comment_count int NOT NULL DEFAULT 0, save_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining_kg >= 0 AND remaining_kg <= capacity_kg),
  CHECK (remaining_m3 IS NULL OR remaining_m3 >= 0),
  CHECK (arrival_at IS NULL OR arrival_at > departure_at)
);
CREATE INDEX journeys_route_idx ON journeys USING gist(route);
CREATE INDEX journeys_origin_idx ON journeys USING gist(origin);
CREATE INDEX journeys_browse_idx ON journeys(status, departure_at);
CREATE INDEX journeys_driver_idx ON journeys(driver_id, departure_at DESC);

-- ---------------------------------------------------------------- transport services (standing local/regional services)
CREATE TABLE transport_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('car','suv','pickup_truck','cargo_van','box_truck','trailer','other')),
  service_city text NOT NULL, service_province char(2) NOT NULL, service_center geography(Point,4326) NOT NULL,
  service_radius_km int NOT NULL CHECK (service_radius_km BETWEEN 1 AND 5000),
  intercity boolean NOT NULL DEFAULT false,       -- true: pickup must be in area, destination may be anywhere
  capacity_kg int NOT NULL CHECK (capacity_kg > 0),
  max_length_cm int, max_width_cm int, max_height_cm int,
  helps_loading boolean NOT NULL DEFAULT false,
  item_restrictions text[] NOT NULL DEFAULT '{}',
  pricing_model text NOT NULL DEFAULT 'flat' CHECK (pricing_model IN ('flat','hourly','per_km')),
  price_cents int NOT NULL CHECK (price_cents >= 0),
  price_type text NOT NULL DEFAULT 'negotiable' CHECK (price_type IN ('fixed','negotiable')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','removed')),
  like_count int NOT NULL DEFAULT 0, comment_count int NOT NULL DEFAULT 0, save_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tsvc_center_idx ON transport_services USING gist(service_center);
CREATE INDEX tsvc_provider_idx ON transport_services(provider_id);

-- ---------------------------------------------------------------- offers (goods AND transport share one engine)
CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('goods','transport')),
  customer_id uuid NOT NULL REFERENCES users(id),   -- buyer / shipper
  provider_id uuid NOT NULL REFERENCES users(id),   -- seller / transporter
  proposer_id uuid NOT NULL REFERENCES users(id),   -- who authored THIS version
  listing_id uuid REFERENCES listings(id),
  request_id uuid REFERENCES transport_requests(id),
  journey_id uuid REFERENCES journeys(id),
  service_id uuid REFERENCES transport_services(id),
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  message text CHECK (char_length(message) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','countered','accepted','rejected','withdrawn','expired')),
  parent_offer_id uuid REFERENCES offers(id),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id <> provider_id),
  CHECK (proposer_id IN (customer_id, provider_id)),
  CHECK ((kind = 'goods' AND listing_id IS NOT NULL AND request_id IS NULL AND journey_id IS NULL AND service_id IS NULL)
      OR (kind = 'transport' AND listing_id IS NULL AND request_id IS NOT NULL AND NOT (journey_id IS NOT NULL AND service_id IS NOT NULL)))
);
CREATE INDEX offers_customer_idx ON offers(customer_id, created_at DESC);
CREATE INDEX offers_provider_idx ON offers(provider_id, created_at DESC);
CREATE INDEX offers_listing_idx ON offers(listing_id, status) WHERE listing_id IS NOT NULL;
CREATE INDEX offers_request_idx ON offers(request_id, status) WHERE request_id IS NOT NULL;
CREATE INDEX offers_pending_exp_idx ON offers(expires_at) WHERE status = 'pending';
CREATE TABLE offer_events (
  id bigserial PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('created','countered','accepted','rejected','withdrawn','expired','auto_rejected')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offer_events_offer_idx ON offer_events(offer_id, id);

-- ---------------------------------------------------------------- orders (agreed goods sales; payments attach in phase 4)
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL UNIQUE REFERENCES offers(id),
  listing_id uuid NOT NULL REFERENCES listings(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  quantity int NOT NULL CHECK (quantity >= 1),
  total_cents int NOT NULL CHECK (total_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  status text NOT NULL DEFAULT 'agreed' CHECK (status IN ('agreed','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, cancelled_at timestamptz, cancelled_by uuid REFERENCES users(id)
);
CREATE INDEX orders_buyer_idx ON orders(buyer_id, created_at DESC);
CREATE INDEX orders_seller_idx ON orders(seller_id, created_at DESC);

-- ---------------------------------------------------------------- bookings
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL UNIQUE REFERENCES offers(id),
  request_id uuid NOT NULL REFERENCES transport_requests(id),
  journey_id uuid REFERENCES journeys(id),
  service_id uuid REFERENCES transport_services(id),
  shipper_id uuid NOT NULL REFERENCES users(id),
  transporter_id uuid NOT NULL REFERENCES users(id),
  agreed_cents int NOT NULL CHECK (agreed_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  reserved_kg numeric(8,2) NOT NULL DEFAULT 0 CHECK (reserved_kg >= 0),
  reserved_m3 numeric(8,3) NOT NULL DEFAULT 0 CHECK (reserved_m3 >= 0),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','pickup_confirmed','in_transit','delivered','completed','cancelled')),
  pickup_pin char(4) NOT NULL,
  delivery_pin char(4) NOT NULL,
  pin_attempts int NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  pickup_confirmed_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
  cancelled_at timestamptz, cancelled_by uuid REFERENCES users(id), cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (shipper_id <> transporter_id)
);
-- A shipment can only have one live booking: the database, not just application code, prevents double booking.
CREATE UNIQUE INDEX bookings_one_active_per_request ON bookings(request_id) WHERE status <> 'cancelled';
CREATE INDEX bookings_shipper_idx ON bookings(shipper_id, created_at DESC);
CREATE INDEX bookings_transporter_idx ON bookings(transporter_id, created_at DESC);
CREATE INDEX bookings_journey_idx ON bookings(journey_id) WHERE journey_id IS NOT NULL;

-- exact addresses live ONLY here, visible to the two booking parties
CREATE TABLE booking_addresses (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  pickup_address text, pickup_notes text,
  delivery_address text, delivery_notes text,
  contact_phone text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_events (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('booked','address_set','pickup_confirmed','in_transit','note','photo','delivered','completed','cancelled','pin_locked')),
  note text,
  location_label text,
  media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_booking_idx ON delivery_events(booking_id, id);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('shipper','transporter','buyer','seller')),   -- role the REVIEWEE played
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (char_length(comment) <= 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((booking_id IS NOT NULL) <> (order_id IS NOT NULL)),
  CHECK (reviewer_id <> reviewee_id),
  UNIQUE (booking_id, reviewer_id),
  UNIQUE (order_id, reviewer_id)
);
CREATE INDEX reviews_reviewee_idx ON reviews(reviewee_id, created_at DESC) WHERE status = 'active';

-- ---------------------------------------------------------------- widen polymorphic checks for the new object types
ALTER TABLE reactions DROP CONSTRAINT reactions_target_type_check;
ALTER TABLE reactions ADD CONSTRAINT reactions_target_type_check CHECK (target_type IN ('post','comment','listing','transport_request','journey','transport_service'));
ALTER TABLE saved_items DROP CONSTRAINT saved_items_target_type_check;
ALTER TABLE saved_items ADD CONSTRAINT saved_items_target_type_check CHECK (target_type IN ('post','listing','transport_request','journey','transport_service','business'));
ALTER TABLE comments DROP CONSTRAINT comments_target_type_check;
ALTER TABLE comments ADD CONSTRAINT comments_target_type_check CHECK (target_type IN ('post','listing','transport_request','journey','transport_service','event'));
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user','post','comment','listing','business','message','transport_request','journey','transport_service','group','video'));

INSERT INTO platform_settings(key,value,description) VALUES
 ('offer.default_expiry_hours','48','Default offer lifetime'),
 ('offer.max_expiry_hours','168','Longest allowed offer lifetime'),
 ('booking.auto_complete_hours','72','Hours after delivery before a booking completes automatically'),
 ('booking.pin_max_attempts','5','Wrong PIN attempts before a 15-minute lockout'),
 ('transport.match_min_score','55','Minimum match score for match notifications'),
 ('transport.request_expiry_grace_days','1','Days after the pickup window before a request expires')
ON CONFLICT DO NOTHING;
