import { pool } from '../db/pool.js';
import { mediaUrl, thumbUrl } from './views.js';
import { videoUrls } from './video.js';

const av = (k: string | null) => (k ? thumbUrl(k) : null);

export interface Viewer { id: string | null }

export async function hydratePosts(ids: string[], viewer: string | null) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT p.*, u.username, pr.display_name, pr.verification_level, (SELECT storage_key FROM media_assets WHERE id = pr.avatar_media_id) AS avatar_key,
            b.name AS business_name, b.slug AS business_slug, b.verification_status AS business_verification,
            pr.city, pr.province, g.slug AS group_slug, g.name AS group_name,
            vd.id AS vd_id, vd.status AS vd_status, vd.duration_s AS vd_dur, vd.width AS vd_w, vd.height AS vd_h, vd.provider AS vd_provider, vd.provider_video_id AS vd_pvid,
            (SELECT json_agg(json_build_object('id', o.id, 'text', o.text, 'votes', o.vote_count) ORDER BY o.position) FROM poll_options o WHERE o.post_id = p.id) AS poll_opts,
            (SELECT option_id FROM poll_votes pv WHERE pv.post_id = p.id AND pv.user_id = $2) AS my_vote,
            EXISTS (SELECT 1 FROM reactions r WHERE r.user_id=$2 AND r.target_type='post' AND r.target_id=p.id) AS liked,
            EXISTS (SELECT 1 FROM saved_items s WHERE s.user_id=$2 AND s.target_type='post' AND s.target_id=p.id) AS saved,
            coalesce((SELECT json_agg(json_build_object('id', m.id, 'key', m.storage_key, 'width', m.width, 'height', m.height) ORDER BY pm.position)
                      FROM post_media pm JOIN media_assets m ON m.id = pm.media_id WHERE pm.post_id = p.id), '[]') AS media
     FROM posts p JOIN users u ON u.id = p.author_id JOIN user_profiles pr ON pr.user_id = u.id
     LEFT JOIN businesses b ON b.id = p.business_id LEFT JOIN groups g ON g.id = p.group_id LEFT JOIN videos vd ON vd.id = p.video_id WHERE p.id = ANY($1::uuid[])`, [ids, viewer]);
  const listingIds = rows.filter((r) => r.attachment_type === 'listing').map((r) => r.attachment_id);
  const listings = await hydrateListings(listingIds, viewer);
  const att = (t: string) => rows.filter((r) => r.attachment_type === t).map((r) => r.attachment_id);
  const [reqs, jrns, svcs] = await Promise.all([hydrateRequests(att('transport_request'), viewer), hydrateJourneys(att('journey'), viewer), hydrateServices(att('transport_service'), viewer)]);
  for (const r of rows) {
    out.set(r.id, {
      type: 'post', id: r.id, kind: r.kind, body: r.status === 'removed' ? null : r.body, status: r.status,
      author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: av(r.avatar_key), verification_level: r.verification_level },
      business: r.business_id ? { id: r.business_id, name: r.business_name, slug: r.business_slug, verified: r.business_verification === 'verified' } : null,
      location: r.city ? { city: r.city, province: r.province } : null,
      group: r.group_id ? { id: r.group_id, slug: r.group_slug, name: r.group_name } : null,
      video: r.vd_id ? { id: r.vd_id, status: r.vd_status, duration_s: r.vd_dur === null ? null : Number(r.vd_dur), width: r.vd_w, height: r.vd_h, urls: r.vd_status === 'ready' ? videoUrls({ id: r.vd_id, provider: r.vd_provider, provider_video_id: r.vd_pvid }) : null } : null,
      poll: r.poll_opts ? (() => { const total = r.poll_opts.reduce((n: number, o: any) => n + o.votes, 0); const closed = r.poll_closes_at && new Date(r.poll_closes_at) < new Date(); return { options: r.poll_opts.map((o: any) => ({ id: o.id, text: o.text, votes: o.votes, pct: total ? Math.round((o.votes / total) * 100) : 0 })), total_votes: total, my_vote: r.my_vote, closes_at: r.poll_closes_at, closed: !!closed }; })() : null,
      view_count: r.view_count,
      media: r.media.map((m: any) => ({ id: m.id, url: mediaUrl(m.key), thumb_url: thumbUrl(m.key), width: m.width, height: m.height })),
      attachment: r.attachment_type === 'listing' ? { type: 'listing', id: r.attachment_id, listing: listings.get(r.attachment_id) ?? null }
        : r.attachment_type === 'transport_request' ? { type: 'transport_request', id: r.attachment_id, request: reqs.get(r.attachment_id) ?? null }
        : r.attachment_type === 'journey' ? { type: 'journey', id: r.attachment_id, journey: jrns.get(r.attachment_id) ?? null }
        : r.attachment_type === 'transport_service' ? { type: 'transport_service', id: r.attachment_id, service: svcs.get(r.attachment_id) ?? null }
        : r.attachment_type ? { type: r.attachment_type, id: r.attachment_id } : null,
      counts: { likes: r.like_count, comments: r.comment_count, shares: r.share_count, saves: r.save_count },
      viewer: { liked: r.liked, saved: r.saved }, visibility: r.visibility, created_at: r.created_at,
    });
  }
  return out;
}


/** Mark items with an active "featured" boost. Featured items rank higher in browse/search but are not labelled as ads. */
async function markFeatured(out: Map<string, any>, type: 'listing' | 'transport_service') {
  for (const v of out.values()) v.featured = false;
  if (!out.size) return;
  const { rows } = await pool.query(`SELECT target_id FROM boosts WHERE target_type=$1 AND placement='featured' AND status='active' AND ends_at > now() AND target_id = ANY($2::uuid[])`, [type, [...out.keys()]]);
  for (const r of rows) { const v = out.get(r.target_id); if (v) v.featured = true; }
}

export async function hydrateListings(ids: string[], viewer: string | null, distanceFrom?: { lng: number; lat: number }) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.price_cents, l.currency, l.price_type, l.condition, l.status, l.quantity, l.city, l.province, l.fulfillment, l.tags,
            l.like_count, l.comment_count, l.save_count, l.created_at, l.business_id, l.seller_id,
            u.username, pr.display_name, pr.verification_level, (SELECT storage_key FROM media_assets WHERE id = pr.avatar_media_id) AS avatar_key,
            b.name AS business_name, b.slug AS business_slug, b.verification_status AS business_verification,
            CASE WHEN $3::float8 IS NULL OR l.location IS NULL THEN NULL
                 ELSE round((ST_Distance(l.location, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography)/1000)::numeric, 1) END AS distance_km,
            EXISTS (SELECT 1 FROM saved_items s WHERE s.user_id=$2 AND s.target_type='listing' AND s.target_id=l.id) AS saved,
            EXISTS (SELECT 1 FROM reactions r WHERE r.user_id=$2 AND r.target_type='listing' AND r.target_id=l.id) AS liked,
            coalesce((SELECT json_agg(json_build_object('id', m.id, 'key', m.storage_key, 'width', m.width, 'height', m.height) ORDER BY lm.position)
                      FROM listing_media lm JOIN media_assets m ON m.id = lm.media_id WHERE lm.listing_id = l.id), '[]') AS media
     FROM listings l JOIN users u ON u.id = l.seller_id JOIN user_profiles pr ON pr.user_id = u.id
     LEFT JOIN businesses b ON b.id = l.business_id WHERE l.id = ANY($1::uuid[])`,
    [ids, viewer, distanceFrom?.lng ?? null, distanceFrom?.lat ?? null]);
  for (const r of rows) {
    out.set(r.id, {
      type: 'listing', id: r.id, title: r.title, price_cents: r.price_cents, currency: r.currency, price_type: r.price_type,
      condition: r.condition, status: r.status, quantity: r.quantity, fulfillment: r.fulfillment, tags: r.tags,
      location: { city: r.city, province: r.province }, distance_km: r.distance_km === null ? null : Number(r.distance_km),
      images: r.media.map((m: any) => ({ id: m.id, url: mediaUrl(m.key), thumb_url: thumbUrl(m.key), width: m.width, height: m.height })),
      seller: { id: r.seller_id, username: r.username, display_name: r.display_name, avatar_url: av(r.avatar_key), verification_level: r.verification_level },
      business: r.business_id ? { id: r.business_id, name: r.business_name, slug: r.business_slug, verified: r.business_verification === 'verified' } : null,
      counts: { likes: r.like_count, comments: r.comment_count, saves: r.save_count },
      viewer: { liked: r.liked, saved: r.saved }, created_at: r.created_at,
    });
  }
  await markFeatured(out, 'listing');
  return out;
}

// ---------------------------------------------------------------------------------------- transport objects
const ownerSql = (idCol: string, role: 'transporter' | 'shipper') => `
  u.username, pr.display_name, pr.verification_level,
  (SELECT storage_key FROM media_assets WHERE id = pr.avatar_media_id) AS avatar_key,
  (SELECT round(avg(rv.rating)::numeric, 2) FROM reviews rv WHERE rv.reviewee_id = ${idCol} AND rv.status='active' AND rv.revealed_at IS NOT NULL AND rv.role='${role}') AS rating_avg,
  (SELECT count(*) FROM reviews rv WHERE rv.reviewee_id = ${idCol} AND rv.status='active' AND rv.revealed_at IS NOT NULL AND rv.role='${role}')::int AS rating_count,
  (SELECT count(*) FROM bookings bk WHERE bk.${role}_id = ${idCol} AND bk.status='completed')::int AS completed,
  EXISTS (SELECT 1 FROM driver_documents dd WHERE dd.user_id = ${idCol} AND dd.kind='drivers_licence' AND dd.status='approved' AND dd.expires_on >= current_date) AS licence_ok,
  EXISTS (SELECT 1 FROM driver_documents dd WHERE dd.user_id = ${idCol} AND dd.kind='insurance' AND dd.status='approved' AND dd.expires_on >= current_date) AS insurance_ok`;

const ownerView = (r: any, id: string) => ({
  id, username: r.username, display_name: r.display_name, avatar_url: av(r.avatar_key), verification_level: r.verification_level,
  rating_avg: r.rating_avg === null ? null : Number(r.rating_avg), rating_count: r.rating_count, completed: r.completed,
  trust: { identity: r.verification_level === 'identity', licence: !!r.licence_ok, insurance: !!r.insurance_ok },
});
const place = (city: string, province: string, pt: { x: number; y: number }, area?: string | null) => ({ city, province, lat: pt.y, lng: pt.x, ...(area !== undefined ? { area } : {}) });
const ST = (c: string) => `json_build_object('x', ST_X(${c}::geometry), 'y', ST_Y(${c}::geometry))`;

export async function hydrateRequests(ids: string[], viewer: string | null) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT r.*, ${ST('r.origin')} AS o_pt, ${ST('r.dest')} AS d_pt, ${ownerSql('r.requester_id', 'shipper')},
       b.name AS business_name, b.slug AS business_slug, ll.title AS listing_title,
       EXISTS (SELECT 1 FROM reactions x WHERE x.user_id=$2 AND x.target_type='transport_request' AND x.target_id=r.id) AS liked,
       EXISTS (SELECT 1 FROM saved_items x WHERE x.user_id=$2 AND x.target_type='transport_request' AND x.target_id=r.id) AS saved,
       (SELECT count(*) FROM offers o WHERE o.request_id=r.id AND o.status='pending')::int AS pending_offers,
       coalesce((SELECT json_agg(json_build_object('id', m.id, 'key', m.storage_key, 'width', m.width, 'height', m.height) ORDER BY rm.position)
                 FROM transport_request_media rm JOIN media_assets m ON m.id = rm.media_id WHERE rm.request_id = r.id), '[]') AS media
     FROM transport_requests r JOIN users u ON u.id = r.requester_id JOIN user_profiles pr ON pr.user_id = u.id
     LEFT JOIN businesses b ON b.id = r.business_id LEFT JOIN listings ll ON ll.id = r.linked_listing_id WHERE r.id = ANY($1::uuid[])`, [ids, viewer]);
  for (const r of rows) {
    out.set(r.id, {
      type: 'transport_request', id: r.id, title: r.title, description: r.description, item_category: r.item_category, quantity: r.quantity, weight_kg: Number(r.weight_kg),
      dimensions_cm: { length: r.length_cm, width: r.width_cm, height: r.height_cm }, fragile: r.fragile, special_handling: r.special_handling,
      needs_loading_help: r.needs_loading_help, needs_unloading_help: r.needs_unloading_help,
      origin: place(r.origin_city, r.origin_province, r.o_pt, r.pickup_area), destination: place(r.dest_city, r.dest_province, r.d_pt, r.delivery_area),
      pickup_from: r.pickup_from instanceof Date ? r.pickup_from.toISOString().slice(0, 10) : r.pickup_from, pickup_to: r.pickup_to instanceof Date ? r.pickup_to.toISOString().slice(0, 10) : r.pickup_to,
      deliver_by: r.deliver_by instanceof Date ? r.deliver_by.toISOString().slice(0, 10) : r.deliver_by, budget_cents: r.budget_cents, price_type: r.price_type,
      preferred_vehicles: r.preferred_vehicles, visibility: r.visibility, status: r.status,
      images: r.media.map((m: any) => ({ id: m.id, url: mediaUrl(m.key), thumb_url: thumbUrl(m.key), width: m.width, height: m.height })),
      linked_listing: r.linked_listing_id ? { id: r.linked_listing_id, title: r.listing_title } : null,
      requester: ownerView(r, r.requester_id), business: r.business_id ? { id: r.business_id, name: r.business_name, slug: r.business_slug } : null,
      pending_offers: viewer === r.requester_id ? r.pending_offers : undefined,
      counts: { likes: r.like_count, comments: r.comment_count, saves: r.save_count }, viewer: { liked: r.liked, saved: r.saved, is_owner: viewer === r.requester_id }, created_at: r.created_at,
    });
  }
  return out;
}

export async function hydrateJourneys(ids: string[], viewer: string | null) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT j.*, ${ST('j.origin')} AS o_pt, ${ST('j.dest')} AS d_pt, ${ownerSql('j.driver_id', 'transporter')}, b.name AS business_name, b.slug AS business_slug,
       EXISTS (SELECT 1 FROM reactions x WHERE x.user_id=$2 AND x.target_type='journey' AND x.target_id=j.id) AS liked,
       EXISTS (SELECT 1 FROM saved_items x WHERE x.user_id=$2 AND x.target_type='journey' AND x.target_id=j.id) AS saved
     FROM journeys j JOIN users u ON u.id = j.driver_id JOIN user_profiles pr ON pr.user_id = u.id
     LEFT JOIN businesses b ON b.id = j.business_id WHERE j.id = ANY($1::uuid[])`, [ids, viewer]);
  for (const r of rows) {
    out.set(r.id, {
      type: 'journey', id: r.id, description: r.description, origin: place(r.origin_city, r.origin_province, r.o_pt), destination: place(r.dest_city, r.dest_province, r.d_pt),
      waypoints: r.waypoints, distance_km: r.distance_km, max_detour_km: r.max_detour_km, departure_at: r.departure_at, arrival_at: r.arrival_at, vehicle_type: r.vehicle_type,
      capacity_kg: r.capacity_kg, remaining_kg: r.remaining_kg, capacity_m3: r.capacity_m3 === null ? null : Number(r.capacity_m3), remaining_m3: r.remaining_m3 === null ? null : Number(r.remaining_m3),
      max_dimensions_cm: { length: r.max_length_cm, width: r.max_width_cm, height: r.max_height_cm }, item_restrictions: r.item_restrictions,
      price_cents: r.price_cents, price_type: r.price_type, instant_book: !!r.instant_book, pickup_preferences: r.pickup_preferences, delivery_preferences: r.delivery_preferences, helps_loading: r.helps_loading,
      status: r.status, driver: ownerView(r, r.driver_id), business: r.business_id ? { id: r.business_id, name: r.business_name, slug: r.business_slug } : null,
      counts: { likes: r.like_count, comments: r.comment_count, saves: r.save_count }, viewer: { liked: r.liked, saved: r.saved, is_owner: viewer === r.driver_id }, created_at: r.created_at,
    });
  }
  return out;
}

export async function hydrateServices(ids: string[], viewer: string | null) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT s.*, ${ST('s.service_center')} AS c_pt, ${ownerSql('s.provider_id', 'transporter')}, b.name AS business_name, b.slug AS business_slug,
       EXISTS (SELECT 1 FROM reactions x WHERE x.user_id=$2 AND x.target_type='transport_service' AND x.target_id=s.id) AS liked,
       EXISTS (SELECT 1 FROM saved_items x WHERE x.user_id=$2 AND x.target_type='transport_service' AND x.target_id=s.id) AS saved
     FROM transport_services s JOIN users u ON u.id = s.provider_id JOIN user_profiles pr ON pr.user_id = u.id
     LEFT JOIN businesses b ON b.id = s.business_id WHERE s.id = ANY($1::uuid[])`, [ids, viewer]);
  for (const r of rows) {
    out.set(r.id, {
      type: 'transport_service', id: r.id, title: r.title, description: r.description, vehicle_type: r.vehicle_type,
      area: place(r.service_city, r.service_province, r.c_pt), service_radius_km: r.service_radius_km, intercity: r.intercity, capacity_kg: r.capacity_kg,
      max_dimensions_cm: { length: r.max_length_cm, width: r.max_width_cm, height: r.max_height_cm }, helps_loading: r.helps_loading, item_restrictions: r.item_restrictions,
      pricing_model: r.pricing_model, price_cents: r.price_cents, price_type: r.price_type, status: r.status, provider: ownerView(r, r.provider_id),
      business: r.business_id ? { id: r.business_id, name: r.business_name, slug: r.business_slug } : null,
      counts: { likes: r.like_count, comments: r.comment_count, saves: r.save_count }, viewer: { liked: r.liked, saved: r.saved, is_owner: viewer === r.provider_id }, created_at: r.created_at,
    });
  }
  await markFeatured(out, 'transport_service');
  return out;
}
