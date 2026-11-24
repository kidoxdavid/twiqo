import { pool } from '../db/pool.js';
import { mediaUrl, thumbUrl } from './views.js';

const av = (k: string | null) => (k ? thumbUrl(k) : null);

export interface Viewer { id: string | null }

export async function hydratePosts(ids: string[], viewer: string | null) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT p.*, u.username, pr.display_name, pr.verification_level, (SELECT storage_key FROM media_assets WHERE id = pr.avatar_media_id) AS avatar_key,
            b.name AS business_name, b.slug AS business_slug, b.verification_status AS business_verification,
            pr.city, pr.province,
            EXISTS (SELECT 1 FROM reactions r WHERE r.user_id=$2 AND r.target_type='post' AND r.target_id=p.id) AS liked,
            EXISTS (SELECT 1 FROM saved_items s WHERE s.user_id=$2 AND s.target_type='post' AND s.target_id=p.id) AS saved,
            coalesce((SELECT json_agg(json_build_object('id', m.id, 'key', m.storage_key, 'width', m.width, 'height', m.height) ORDER BY pm.position)
                      FROM post_media pm JOIN media_assets m ON m.id = pm.media_id WHERE pm.post_id = p.id), '[]') AS media
     FROM posts p JOIN users u ON u.id = p.author_id JOIN user_profiles pr ON pr.user_id = u.id
     LEFT JOIN businesses b ON b.id = p.business_id WHERE p.id = ANY($1::uuid[])`, [ids, viewer]);
  const listingIds = rows.filter((r) => r.attachment_type === 'listing').map((r) => r.attachment_id);
  const listings = await hydrateListings(listingIds, viewer);
  for (const r of rows) {
    out.set(r.id, {
      type: 'post', id: r.id, kind: r.kind, body: r.status === 'removed' ? null : r.body, status: r.status,
      author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: av(r.avatar_key), verification_level: r.verification_level },
      business: r.business_id ? { id: r.business_id, name: r.business_name, slug: r.business_slug, verified: r.business_verification === 'verified' } : null,
      location: r.city ? { city: r.city, province: r.province } : null,
      media: r.media.map((m: any) => ({ id: m.id, url: mediaUrl(m.key), thumb_url: thumbUrl(m.key), width: m.width, height: m.height })),
      attachment: r.attachment_type === 'listing' ? { type: 'listing', id: r.attachment_id, listing: listings.get(r.attachment_id) ?? null } : r.attachment_type ? { type: r.attachment_type, id: r.attachment_id } : null,
      counts: { likes: r.like_count, comments: r.comment_count, shares: r.share_count, saves: r.save_count },
      viewer: { liked: r.liked, saved: r.saved }, visibility: r.visibility, created_at: r.created_at,
    });
  }
  return out;
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
  return out;
}
