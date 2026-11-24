/* Development seed data. Safe to re-run (skips if already seeded). Never run in production. */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { pool } from './pool.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../lib/auth.js';
import { storage } from '../lib/storage.js';
import { config } from '../config.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { localProvider } from '../lib/video.js';

if (config.NODE_ENV === 'production') throw new Error('Refusing to seed production');

const PASSWORD = process.env.SEED_PASSWORD ?? 'Twiqo!Dev123';

const CATEGORIES: [string, string, string[], boolean?][] = [
  ['Furniture', 'furniture', ['Sofas', 'Tables', 'Beds', 'Storage']],
  ['Electronics', 'electronics', ['Phones', 'Computers', 'Audio', 'Gaming']],
  ['Vehicles & Parts', 'vehicles', ['Cars & Trucks', 'Tires & Wheels', 'Parts', 'Bikes & Scooters']],
  ['Home & Garden', 'home-garden', ['Appliances', 'Tools', 'Plants', 'Decor']],
  ['Sports & Recreation', 'sports', ['Bikes', 'Fitness', 'Camping', 'Winter sports']],
  ['Clothing & Fashion', 'fashion', ['Women', 'Men', 'Kids', 'Accessories']],
  ['Baby & Kids', 'baby-kids', ['Strollers', 'Toys', 'Clothing']],
  ['Books & Education', 'books', ['Textbooks', 'Fiction', 'Courses']],
  ['Art & Handmade', 'art', ['Art', 'Crafts', 'Collectibles']],
  ['Building Materials', 'building', ['Lumber', 'Flooring', 'Fixtures']],
  ['Business Inventory', 'business-inventory', ['Wholesale', 'Equipment']],
  ['Age-restricted & regulated', 'restricted', ['Alcohol', 'Vapes'], true],
];

type Art = (a: string, b: string) => string;
const svgs: Record<string, Art> = {
  sofa: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><rect x="180" y="400" width="540" height="200" rx="50" fill="#5B6B8F"/><rect x="130" y="440" width="110" height="220" rx="45" fill="#4A5A7D"/><rect x="660" y="440" width="110" height="220" rx="45" fill="#4A5A7D"/><rect x="230" y="320" width="440" height="130" rx="45" fill="#6C7DA3"/></svg>`,
  bike: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><g fill="none" stroke="#14213D" stroke-width="22" stroke-linecap="round"><circle cx="250" cy="560" r="130"/><circle cx="650" cy="560" r="130"/><path d="M250 560L390 330h180l90 230M390 330L450 560h200M530 290h70"/></g></svg>`,
  tires: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><circle cx="360" cy="400" r="200" fill="#0B1224"/><circle cx="360" cy="400" r="95" fill="#9AA5BF"/><circle cx="560" cy="520" r="200" fill="#14213D"/><circle cx="560" cy="520" r="95" fill="#B9C4E0"/></svg>`,
  laptop: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><rect x="200" y="260" width="500" height="320" rx="24" fill="#14213D"/><rect x="224" y="284" width="452" height="272" rx="10" fill="#246BFD"/><path d="M110 620h680l-50 70H160z" fill="#9AA5BF"/></svg>`,
  fridge: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><rect x="300" y="130" width="300" height="640" rx="30" fill="#fff" stroke="#14213D" stroke-width="18"/><path d="M300 330h300" stroke="#14213D" stroke-width="18"/><rect x="545" y="200" width="16" height="70" fill="#14213D"/><rect x="545" y="400" width="16" height="140" fill="#14213D"/></svg>`,
  plant: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="900" height="900" fill="url(#g)"/><path d="M300 700h300l-40-200H340z" fill="#9A6B3E"/><g fill="#2FA45F"><ellipse cx="450" cy="380" rx="70" ry="150"/><ellipse cx="350" cy="440" rx="60" ry="130" transform="rotate(-35 350 440)"/><ellipse cx="550" cy="440" rx="60" ry="130" transform="rotate(35 550 440)"/></g></svg>`,
  skyline: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="900" fill="url(#g)"/><g fill="#14213D" opacity=".85"><rect x="200" y="450" width="80" height="300"/><rect x="290" y="360" width="90" height="390"/><rect x="390" y="500" width="70" height="250"/><rect x="560" y="260" width="40" height="490"/><circle cx="580" cy="250" r="34"/><rect x="700" y="420" width="100" height="330"/><rect x="810" y="520" width="80" height="230"/></g><path d="M0 700C300 640 700 760 1200 680V900H0z" fill="#13B9B0"/><path d="M0 790C300 740 700 830 1200 770V900H0z" fill="#246BFD"/></svg>`,
  truck: (a, b) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1200" height="900" fill="url(#g)"/><rect x="250" y="400" width="480" height="210" rx="16" fill="#14213D"/><path d="M730 450h160l90 90v70H730z" fill="#246BFD"/><circle cx="400" cy="640" r="60" fill="#0B1224"/><circle cx="860" cy="640" r="60" fill="#0B1224"/></svg>`,
};
const PAL: [string, string][] = [['#EAF0FF', '#CFE0FF'], ['#FFF1D8', '#FFE0A8'], ['#DDF6F4', '#BFEDE9'], ['#F1E9FF', '#DCCBFF'], ['#FFE9E6', '#FFD0C9'], ['#E3F5E1', '#C8EBC4']];

async function image(owner: string, kind: keyof typeof svgs, pal = 0) {
  const [a, b] = PAL[pal % PAL.length];
  const id = crypto.randomUUID();
  const base = sharp(Buffer.from(svgs[kind](a, b)));
  const main = await base.clone().webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  const thumb = await base.clone().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  await storage.put(`img/${id}.webp`, main.data); await storage.put(`img/${id}_t.webp`, thumb);
  await pool.query(`INSERT INTO media_assets(id,owner_id,kind,storage_key,mime,bytes,width,height) VALUES ($1,$2,'image',$3,'image/webp',$4,$5,$6)`, [id, owner, `img/${id}.webp`, main.data.length, main.info.width, main.info.height]);
  return id;
}

await runMigrations();
if ((await pool.query(`SELECT 1 FROM users WHERE username='admin'`)).rowCount) { console.log('Already seeded.'); await pool.end(); process.exit(0); }

const pw = await hashPassword(PASSWORD);
const place = async (city: string) => (await pool.query(`SELECT city, province, location FROM places WHERE city=$1`, [city])).rows[0];
const mkUser = async (username: string, name: string, city: string, bio: string, role?: string, type = 'individual') => {
  const u = (await pool.query(`INSERT INTO users(email,username,password_hash,account_type,email_verified_at) VALUES ($1,$2,$3,$4,now()) RETURNING id`, [`${username}@example.com`, username, pw, type])).rows[0].id as string;
  const pl = await place(city);
  await pool.query(`INSERT INTO user_profiles(user_id,display_name,bio,city,province,location,verification_level) VALUES ($1,$2,$3,$4,$5,$6,'email')`, [u, name, bio, pl.city, pl.province, pl.location]);
  if (role) await pool.query(`INSERT INTO user_roles(user_id,role_key) VALUES ($1,$2)`, [u, role]);
  return u;
};

console.log('Seeding…');
const catId: Record<string, string> = {};
for (const [i, [name, slug, kids, restricted]] of CATEGORIES.entries()) {
  const r = await pool.query(`INSERT INTO categories(name,slug,position,is_restricted,restriction_note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, slug, i, !!restricted, restricted ? 'Listings in this category are reviewed before they go live.' : null]);
  catId[slug] = r.rows[0].id;
  for (const [j, k] of kids.entries()) {
    const kid = await pool.query(`INSERT INTO categories(name,slug,parent_id,position,is_restricted) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [k, `${slug}-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, r.rows[0].id, j, !!restricted]);
    catId[`${slug}/${k}`] = kid.rows[0].id;
  }
}

const admin = await mkUser('admin', 'twiqo admin', 'Calgary', 'Platform administrator', 'super_admin');
const mod = await mkUser('moderator', 'Mia Moderator', 'Calgary', 'Community safety', 'moderator');
const amara = await mkUser('amara', 'Amara O.', 'Calgary', 'Moving out — selling a few things. Open to offers.');
const marcus = await mkUser('marcus', 'Marcus T.', 'Calgary', 'Bike nerd. Weekend trail rider.');
const daniel = await mkUser('daniel', 'Daniel K.', 'Toronto', 'Pickup truck owner. Driving Toronto ⇄ Calgary a few times a year.');
const priya = await mkUser('priya', 'Priya S.', 'Edmonton', 'Interior designer, vintage furniture lover.');
const lena = await mkUser('lena', 'Lena W.', 'Vancouver', 'Photographer & plant parent.');
const omar = await mkUser('omar', 'Omar H.', 'Calgary', 'Electronics tinkerer.');
const calgaryLife = await mkUser('calgarylife', 'Calgary Life', 'Calgary', 'What\'s happening in YYC.');
const owner = await mkUser('brightside', 'Brightside Furniture', 'Calgary', 'Quality new & open-box furniture.', undefined, 'business');
const biz = (await pool.query(`INSERT INTO businesses(owner_id,name,slug,description,category,city,province,contact_email,service_radius_km,verification_status) VALUES ($1,'Brightside Furniture','brightside','Quality new & open-box furniture. Free delivery within Calgary on orders over $500.','Furniture store','Calgary','AB','hello@brightside.example',60,'verified') RETURNING id`, [owner])).rows[0].id;
await pool.query(`INSERT INTO business_members(business_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'listing_manager')`, [biz, owner, marcus]);

const mkListing = async (seller: string, cat: string, title: string, desc: string, price: number, type: string, cond: string, city: string, art: keyof typeof svgs, pal: number, tags: string[], business?: string, ageHours = 1) => {
  const pl = await place(city);
  const img = await image(seller, art, pal);
  const l = (await pool.query(
    `INSERT INTO listings(seller_id,business_id,category_id,title,description,price_cents,price_type,condition,city,province,location,tags,fulfillment,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() - ($14 || ' hours')::interval) RETURNING id`,
    [seller, business ?? null, catId[cat], title, desc, price, type, cond, pl.city, pl.province, pl.location, tags, JSON.stringify({ pickup: true, delivery: true, shipping: false }), String(ageHours)])).rows[0].id as string;
  await pool.query(`INSERT INTO listing_media(listing_id,media_id,position) VALUES ($1,$2,0)`, [l, img]);
  await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,business_id,visibility,status,location,created_at) VALUES ('listing',$1,$2,$3,'public','active',$4, now() - ($5 || ' hours')::interval)`, [l, seller, business ?? null, pl.location, String(ageHours)]);
  return l;
};
const sofa = await mkListing(amara, 'furniture/Sofas', 'Sofa – Great Condition', 'Three-seater grey sofa, smoke-free home. Moving out so need it gone this weekend.', 45000, 'negotiable', 'good', 'Calgary', 'sofa', 0, ['sofa', 'living room'], undefined, 2);
await mkListing(marcus, 'sports/Bikes', 'Road Bike 54cm', 'Carbon fork, Shimano 105. Serviced last month.', 29900, 'fixed', 'good', 'Calgary', 'bike', 1, ['bike', 'road'], undefined, 5);
await mkListing(daniel, 'vehicles/Tires & Wheels', 'Winter Tires ×4 · 225/65R17', 'Used one season. Great tread.', 52000, 'fixed', 'like_new', 'Toronto', 'tires', 2, ['tires', 'winter'], undefined, 20);
await mkListing(omar, 'electronics/Computers', 'MacBook Air M1 · 16GB', 'Battery health 92%. Includes charger.', 78000, 'negotiable', 'good', 'Calgary', 'laptop', 3, ['laptop', 'apple'], undefined, 26);
await mkListing(priya, 'home-garden/Appliances', 'Fridge – Stainless Steel', 'Counter-depth, works perfectly.', 35000, 'negotiable', 'fair', 'Edmonton', 'fridge', 4, ['fridge', 'appliance'], undefined, 48);
await mkListing(lena, 'home-garden/Plants', 'Monstera – large pot', 'Free to a good home, you pick up.', 0, 'free', 'good', 'Vancouver', 'plant', 5, ['plant'], undefined, 3);
for (const [t, p, a, pal, h] of [['Corner Sectional – Open Box', 119900, 'sofa', 2, 6], ['Oak Dining Table', 64900, 'sofa', 1, 30], ['Queen Bed Frame', 39900, 'sofa', 3, 50]] as const) {
  await mkListing(owner, 'furniture/Tables', t, 'Brand new / open-box. Delivery available in Calgary.', p, 'fixed', 'new', 'Calgary', a as keyof typeof svgs, pal, ['furniture'], biz, h);
}
await mkListing(daniel, 'vehicles/Parts', 'Roof rack (fits most SUVs)', 'Barely used.', 18000, 'negotiable', 'good', 'Toronto', 'truck', 0, ['rack'], undefined, 70);
await mkListing(marcus, 'sports/Fitness', 'Adjustable dumbbells 5–52 lb', 'Pair, like new.', 32000, 'fixed', 'like_new', 'Calgary', 'bike', 4, ['fitness'], undefined, 90);

const mkPost = async (author: string, body: string, art: keyof typeof svgs | null, city: string, hours: number, attach?: string, businessId?: string) => {
  const pl = await place(city);
  const p = (await pool.query(`INSERT INTO posts(author_id,business_id,kind,body,attachment_type,attachment_id,location,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' hours')::interval) RETURNING id`,
    [author, businessId ?? null, art ? 'photo' : attach ? 'share' : 'text', body, attach ? 'listing' : null, attach ?? null, pl.location, String(hours)])).rows[0].id as string;
  if (art) await pool.query(`INSERT INTO post_media(post_id,media_id,position) VALUES ($1,$2,0)`, [p, await image(author, art, 2)]);
  await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,business_id,status,location,created_at) VALUES ('post',$1,$2,$3,'active',$4, now() - ($5 || ' hours')::interval)`, [p, author, businessId ?? null, pl.location, String(hours)]);
  return p;
};
const skyline = await mkPost(calgaryLife, 'Beautiful day in Calgary! Chinook arch rolling in over the Bow. Anyone else out on the pathways?', 'skyline', 'Calgary', 2);
await mkPost(amara, 'Moving out — selling the sofa this weekend. Open to offers!', null, 'Calgary', 3, sofa);
await mkPost(daniel, 'Driving Toronto → Calgary Dec 12. Room in the truck bed for boxes, tires, small furniture. Message me!', 'truck', 'Toronto', 8);
await mkPost(owner, 'New arrivals in store this week. Free delivery in Calgary on orders over $500.', null, 'Calgary', 12, undefined, biz);
await mkPost(lena, 'Repotted everything today. Plant people, what is your favourite easy houseplant?', null, 'Vancouver', 14);

// social graph
const follow = async (a: string, b: string) => {
  await pool.query(`INSERT INTO follows(follower_id,target_type,target_id) VALUES ($1,'user',$2) ON CONFLICT DO NOTHING`, [a, b]);
  await pool.query(`UPDATE user_profiles SET following_count = following_count + 1 WHERE user_id=$1`, [a]);
  await pool.query(`UPDATE user_profiles SET follower_count = follower_count + 1 WHERE user_id=$1`, [b]);
};
for (const [a, b] of [[amara, calgaryLife], [marcus, calgaryLife], [omar, calgaryLife], [amara, marcus], [marcus, amara], [priya, daniel], [lena, amara], [omar, daniel], [marcus, daniel]]) await follow(a, b);
for (const [t, id, u] of [['post', skyline, amara], ['post', skyline, marcus], ['post', skyline, omar], ['listing', sofa, marcus], ['listing', sofa, omar]] as const) {
  await pool.query(`INSERT INTO reactions(user_id,target_type,target_id) VALUES ($1,$2,$3)`, [u, t, id]);
  await pool.query(`UPDATE ${t === 'post' ? 'posts' : 'listings'} SET like_count = like_count + 1 WHERE id=$1`, [id]);
}
const c1 = (await pool.query(`INSERT INTO comments(target_type,target_id,author_id,body) VALUES ('post',$1,$2,'Out on the Bow River pathway right now, it is gorgeous!') RETURNING id`, [skyline, marcus])).rows[0].id;
await pool.query(`INSERT INTO comments(target_type,target_id,author_id,parent_id,body) VALUES ('post',$1,$2,$3,'Jealous. Heading out after work.')`, [skyline, amara, c1]);
await pool.query(`UPDATE posts SET comment_count = 2 WHERE id=$1`, [skyline]);
await pool.query(`INSERT INTO comments(target_type,target_id,author_id,body) VALUES ('listing',$1,$2,'Is the delivery option available to Airdrie?')`, [sofa, omar]);
await pool.query(`UPDATE listings SET comment_count = 1 WHERE id=$1`, [sofa]);

// a conversation about the sofa
const conv = (await pool.query(`INSERT INTO conversations(kind,subject_type,subject_id,pair_key,created_by) VALUES ('listing','listing',$1,$2,$3) RETURNING id`, [sofa, [marcus, amara].sort().join(':'), marcus])).rows[0].id;
await pool.query(`INSERT INTO conversation_members(conversation_id,user_id) VALUES ($1,$2),($1,$3)`, [conv, marcus, amara]);
for (const [s, b, m] of [[marcus, 'Hi! Is the sofa still available?', 50], [amara, 'Yes it is! Pickup or I can arrange delivery.', 45], [marcus, 'Would you take $380?', 10]] as const) {
  await pool.query(`INSERT INTO messages(conversation_id,sender_id,body,created_at) VALUES ($1,$2,$3, now() - ($4 || ' minutes')::interval)`, [conv, s, b, String(m)]);
}
await pool.query(`UPDATE conversations SET last_message_at = now() - interval '10 minutes' WHERE id=$1`, [conv]);
await pool.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2`, [conv, marcus]);

// ------------------------------------------------------------------ Phase 2: transport
const pt = async (city: string) => (await pool.query(`SELECT city, province, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM places WHERE city=$1`, [city])).rows[0];
const day = (n: number, h = 12) => { const d = new Date(Date.now() + n * 864e5); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const ymd = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const mkJourney = async (driver: string, cities: string[], dep: number, o: { vehicle: string; kg: number; m3: number; price: number; type?: string; detour?: number; desc: string; restr?: string[]; loading?: boolean; arrive?: number }) => {
  const ps = await Promise.all(cities.map(pt)); const a = ps[0], z = ps[ps.length - 1];
  const wkt = `SRID=4326;LINESTRING(${ps.map((q) => `${q.lng} ${q.lat}`).join(', ')})`;
  const j = (await pool.query(
    `INSERT INTO journeys(driver_id,description,origin_city,origin_province,origin,dest_city,dest_province,dest,waypoints,route,distance_km,max_detour_km,departure_at,arrival_at,vehicle_type,capacity_kg,capacity_m3,remaining_kg,remaining_m3,
       max_length_cm,max_width_cm,max_height_cm,item_restrictions,price_cents,price_type,pickup_preferences,delivery_preferences,helps_loading)
     VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,ST_SetSRID(ST_MakePoint($9,$10),4326)::geography,$11,ST_GeogFromText($12),round(ST_Length(ST_GeogFromText($12))/1000),$13,$14,$15,$16,$17,$18,$17,$18,240,180,110,$19,$20,$21,'Pickup in the evening or weekend works best','Delivery to the door in city limits',$22) RETURNING id, location`.replace('RETURNING id, location','RETURNING id'),
    [driver, o.desc, a.city, a.province, a.lng, a.lat, z.city, z.province, z.lng, z.lat, JSON.stringify(ps.slice(1, -1)), wkt, o.detour ?? 20, day(dep), o.arrive ? day(o.arrive, 20) : null, o.vehicle, o.kg, o.m3, o.restr ?? [], o.price, o.type ?? 'negotiable', o.loading ?? false])).rows[0].id as string;
  await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,status,location,created_at) VALUES ('journey',$1,$2,'active',(SELECT origin FROM journeys WHERE id=$1), now() - interval '5 hours')`, [j, driver]);
  return j;
};
const mkRequest = async (req: string, o: { title: string; cat: string; kg: number; qty?: number; dims?: [number, number, number]; from: string; to: string; fromDay: number; toDay: number; budget?: number; desc?: string; status?: string; fragile?: boolean; help?: boolean; listing?: string; area?: string }) => {
  const a = await pt(o.from), z = await pt(o.to);
  const r = (await pool.query(
    `INSERT INTO transport_requests(requester_id,linked_listing_id,title,description,item_category,quantity,weight_kg,length_cm,width_cm,height_cm,fragile,needs_loading_help,origin_city,origin_province,origin,pickup_area,dest_city,dest_province,dest,pickup_from,pickup_to,budget_cents,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,ST_SetSRID(ST_MakePoint($15,$16),4326)::geography,$17,$18,$19,ST_SetSRID(ST_MakePoint($20,$21),4326)::geography,$22,$23,$24,$25) RETURNING id`,
    [req, o.listing ?? null, o.title, o.desc ?? '', o.cat, o.qty ?? 1, o.kg, o.dims?.[0] ?? null, o.dims?.[1] ?? null, o.dims?.[2] ?? null, o.fragile ?? false, o.help ?? false, a.city, a.province, a.lng, a.lat, o.area ?? null, z.city, z.province, z.lng, z.lat, ymd(o.fromDay), ymd(o.toDay), o.budget ?? null, o.status ?? 'open'])).rows[0].id as string;
  if ((o.status ?? 'open') === 'open') await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,status,location,created_at) VALUES ('transport_request',$1,$2,'active',(SELECT origin FROM transport_requests WHERE id=$1), now() - interval '9 hours')`, [r, req]);
  return r;
};

const tor = await mkJourney(daniel, ['Toronto', 'Thunder Bay', 'Winnipeg', 'Regina', 'Calgary'], 4, { vehicle: 'pickup_truck', kg: 600, m3: 4, price: 8500, arrive: 7, loading: true, desc: 'Driving my truck from Toronto to Calgary. Room for boxes, tires, small furniture and bikes. Happy to stop in Winnipeg or Regina.' });
const van = await mkJourney(daniel, ['Calgary', 'Kamloops', 'Vancouver'], 14, { vehicle: 'pickup_truck', kg: 500, m3: 3, price: 12000, type: 'fixed', arrive: 16, desc: 'Return trip Calgary → Vancouver. Fixed price per item up to 500 kg.' });
await mkJourney(omar, ['Calgary', 'Red Deer', 'Edmonton'], 2, { vehicle: 'cargo_van', kg: 900, m3: 9, price: 6000, detour: 30, arrive: 2, restr: ['fragile'], desc: 'Weekly Calgary → Edmonton run in a cargo van. Not suitable for fragile items.' });
const svc = (await pool.query(
  `INSERT INTO transport_services(provider_id,title,description,vehicle_type,service_city,service_province,service_center,service_radius_km,intercity,capacity_kg,max_length_cm,max_width_cm,max_height_cm,helps_loading,pricing_model,price_cents,price_type)
   VALUES ($1,'Pickup truck furniture delivery','Same-day furniture and appliance delivery around Calgary. I bring straps and blankets and can help carry.','pickup_truck','Calgary','AB',(SELECT location FROM places WHERE city='Calgary'),40,false,800,250,180,100,true,'flat',7500,'negotiable') RETURNING id`, [marcus])).rows[0].id as string;
await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,status,location,created_at) VALUES ('transport_service',$1,$2,'active',(SELECT service_center FROM transport_services WHERE id=$1), now() - interval '20 hours')`, [svc, marcus]);

const sofaReq = await mkRequest(amara, { title: 'Move my sofa to Airdrie', cat: 'furniture', kg: 55, dims: [210, 95, 90], from: 'Calgary', to: 'Airdrie', fromDay: 2, toDay: 5, budget: 9000, help: true, area: 'Beltline', desc: 'Three-seater sofa, second floor walk-up. Need help carrying.', listing: sofa });
await mkRequest(priya, { title: 'Stainless fridge Edmonton → Calgary', cat: 'appliances', kg: 85, dims: [70, 70, 170], from: 'Edmonton', to: 'Calgary', fromDay: 5, toDay: 10, budget: 15000, desc: 'Counter-depth fridge, upright transport only.' });
await mkRequest(lena, { title: 'Box of books Vancouver → Calgary', cat: 'boxes', kg: 18, dims: [50, 40, 40], from: 'Vancouver', to: 'Calgary', fromDay: 6, toDay: 14, budget: 4000 });
await mkRequest(omar, { title: 'Winter tires ×4 Winnipeg → Calgary', cat: 'tires', kg: 36, dims: [70, 70, 60], from: 'Winnipeg', to: 'Calgary', fromDay: 3, toDay: 7, budget: 9000 });

// a pending goods offer and a pending transport offer with a counter, so the inbox is not empty
const mkOffer = async (o: { kind: string; customer: string; provider: string; proposer: string; listing?: string; request?: string; journey?: string; service?: string; amount: number; qty?: number; msg?: string; parent?: string; status?: string }) =>
  (await pool.query(`INSERT INTO offers(kind,customer_id,provider_id,proposer_id,listing_id,request_id,journey_id,service_id,amount_cents,quantity,message,status,parent_offer_id,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + interval '40 hours') RETURNING id`,
    [o.kind, o.customer, o.provider, o.proposer, o.listing ?? null, o.request ?? null, o.journey ?? null, o.service ?? null, o.amount, o.qty ?? 1, o.msg ?? null, o.status ?? 'pending', o.parent ?? null])).rows[0].id as string;
await mkOffer({ kind: 'goods', customer: marcus, provider: amara, proposer: marcus, listing: sofa, amount: 38000, msg: 'Would you take $380?' });
const t1 = await mkOffer({ kind: 'transport', customer: amara, provider: marcus, proposer: amara, request: sofaReq, service: svc, amount: 6500, msg: 'Can you do $65 with help carrying?', status: 'countered' });
await mkOffer({ kind: 'transport', customer: amara, provider: marcus, proposer: marcus, request: sofaReq, service: svc, amount: 7500, msg: 'I can do $75 including carrying.', parent: t1 });

// history: completed deliveries and reviews so transporters have reputations
const doneShippers = [[priya, 5, 'Careful with a fragile mirror, kept me posted all the way.'], [lena, 5, 'Picked up on time, great communication.'], [omar, 4, 'Smooth. Arrived a day late but let me know early.']] as const;
for (const [i, [shipper, rating, comment]] of doneShippers.entries()) {
  const rq = await mkRequest(shipper, { title: `Past delivery ${i + 1}`, cat: 'boxes', kg: 20, from: 'Toronto', to: 'Calgary', fromDay: -30 - i, toDay: -25 - i, status: 'completed' });
  const of = await mkOffer({ kind: 'transport', customer: shipper, provider: daniel, proposer: shipper, request: rq, amount: 7000 + i * 500, status: 'accepted' });
  const bk = (await pool.query(`INSERT INTO bookings(offer_id,request_id,shipper_id,transporter_id,agreed_cents,pickup_pin,delivery_pin,status,pickup_confirmed_at,delivered_at,completed_at,created_at) VALUES ($1,$2,$3,$4,$5,'1111','2222','completed', now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval) RETURNING id`, [of, rq, shipper, daniel, 7000 + i * 500, String(25 + i)])).rows[0].id;
  await pool.query(`INSERT INTO reviews(booking_id,reviewer_id,reviewee_id,role,rating,comment) VALUES ($1,$2,$3,'transporter',$4,$5)`, [bk, shipper, daniel, rating, comment]);
  await pool.query(`INSERT INTO reviews(booking_id,reviewer_id,reviewee_id,role,rating,comment) VALUES ($1,$2,$3,'shipper',5,'Easy handover, accurate description.')`, [bk, daniel, shipper]);
}

// a live booking: amara is shipping boxes with daniel and the load is in transit (PINs 4821 / 1937 in dev data)
const liveReq = await mkRequest(amara, { title: 'Boxes: kitchen and books', cat: 'boxes', kg: 120, qty: 6, dims: [60, 40, 40], from: 'Toronto', to: 'Calgary', fromDay: -2, toDay: 0, status: 'booked', budget: 12000 });
const liveOffer = await mkOffer({ kind: 'transport', customer: amara, provider: daniel, proposer: amara, request: liveReq, journey: tor, amount: 10500, status: 'accepted' });
const live = (await pool.query(`INSERT INTO bookings(offer_id,request_id,journey_id,shipper_id,transporter_id,agreed_cents,reserved_kg,pickup_pin,delivery_pin,status,pickup_confirmed_at) VALUES ($1,$2,$3,$4,$5,10500,120,'4821','1937','in_transit', now() - interval '1 day') RETURNING id`, [liveOffer, liveReq, tor, amara, daniel])).rows[0].id as string;
await pool.query(`UPDATE journeys SET remaining_kg = remaining_kg - 120 WHERE id=$1`, [tor]);
await pool.query(`INSERT INTO booking_addresses(booking_id,pickup_address,pickup_notes,delivery_address,contact_phone) VALUES ($1,'12 Queen St W, Toronto','Buzz 402','88 8 Ave SW, Calgary','416-555-0142')`, [live]);
for (const [k, n, loc, h, a] of [['booked', 'Booking confirmed', null, 50, amara], ['address_set', 'Addresses shared with your transporter', null, 49, amara], ['pickup_confirmed', 'Pickup confirmed with PIN', null, 24, daniel], ['in_transit', 'On the way', 'Toronto, ON', 23, daniel], ['in_transit', 'Thunder Bay for the night', 'Thunder Bay, ON', 6, daniel]] as const) {
  await pool.query(`INSERT INTO delivery_events(booking_id,actor_id,kind,note,location_label,created_at) VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' hours')::interval)`, [live, a, k, n, loc, String(h)]);
}

// ------------------------------------------------------------------ Phase 3: circles, clips, stories
const mkVideo = async (owner: string, source: string, title: string, secs = 6) => {
  const id = crypto.randomUUID(); const prov = localProvider();
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-t', String(secs), '-f', 'lavfi', '-i', source, '-f', 'lavfi', '-i', `sine=frequency=${300 + Math.floor(Math.random() * 300)}:duration=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', prov.uploadPath(id) + '.mp4']);
  fs.renameSync(prov.uploadPath(id) + '.mp4', prov.uploadPath(id));
  await pool.query(`INSERT INTO videos(id,owner_id,provider,provider_video_id,title,status) VALUES ($1::uuid,$2,'local',$1::text,$3,'processing')`, [id, owner, title]);
  const st = await prov.process(id, 90);
  await pool.query(`UPDATE videos SET status=$2, duration_s=$3, width=$4, height=$5, ready_at=now() WHERE id=$1`, [id, st.status === 'ready' ? 'ready' : 'rejected', st.durationS ?? null, st.width ?? null, st.height ?? null]);
  return id;
};
const mkCircle = async (name: string, slug: string, owner: string, o: { desc: string; cat: string; city: string; vis?: string; join?: string; rules?: string; commerce?: boolean }) => {
  const pl = await place(o.city);
  const g = (await pool.query(`INSERT INTO groups(slug,name,description,category,city,province,location,visibility,join_policy,rules,allow_commerce,member_count,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12) RETURNING id`,
    [slug, name, o.desc, o.cat, pl.city, pl.province, pl.location, o.vis ?? 'public', o.vis === 'private' ? 'approval' : o.join ?? 'open', o.rules ?? '', o.commerce ?? true, owner])).rows[0].id as string;
  await pool.query(`INSERT INTO group_members(group_id,user_id,role,status) VALUES ($1,$2,'owner','active')`, [g, owner]);
  return g;
};
const addMember = async (g: string, u: string, role = 'member', status = 'active') => {
  await pool.query(`INSERT INTO group_members(group_id,user_id,role,status) VALUES ($1,$2,$3,$4)`, [g, u, role, status]);
  if (status === 'active') await pool.query(`UPDATE groups SET member_count = member_count + 1 WHERE id=$1`, [g]);
};
const gpost = async (g: string, author: string, body: string, hours: number, o: { attach?: [string, string]; poll?: string[]; video?: string; pin?: boolean; priv?: boolean } = {}) => {
  const p = (await pool.query(`INSERT INTO posts(author_id,group_id,kind,body,attachment_type,attachment_id,visibility,video_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9 || ' hours')::interval) RETURNING id`,
    [author, g, o.poll ? 'poll' : o.video ? 'video' : o.attach ? 'share' : 'text', body, o.attach?.[0] ?? null, o.attach?.[1] ?? null, o.priv ? 'group' : 'public', o.video ?? null, String(hours)])).rows[0].id as string;
  for (const [i, t] of (o.poll ?? []).entries()) await pool.query(`INSERT INTO poll_options(post_id,text,position) VALUES ($1,$2,$3)`, [p, t, i]);
  await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,group_id,visibility,status,created_at) VALUES ('post',$1,$2,$3,$4,'active', now() - ($5 || ' hours')::interval)`, [p, author, g, o.priv ? 'group' : 'public', String(hours)]);
  if (o.pin) await pool.query(`INSERT INTO group_pins(group_id,post_id,pinned_by) SELECT $1,$2,user_id FROM group_members WHERE group_id=$1 AND role='owner'`, [g, p]);
  return p;
};

const yycBuy = await mkCircle('Calgary Buy and Sell', 'calgary-buy-and-sell', calgaryLife, { desc: 'Buy, sell and swap with your Calgary neighbours. Be kind, be safe.', cat: 'Marketplace', city: 'Calgary', rules: '1. Be respectful.\n2. No scams, no prohibited items.\n3. Meet in public places.\n4. One listing per item, please.' });
for (const [u, r] of [[amara, 'member'], [marcus, 'moderator'], [omar, 'member'], [owner, 'admin']] as const) await addMember(yycBuy, u, r);
const yycFurn = await mkCircle('Calgary Furniture Marketplace', 'calgary-furniture-marketplace', owner, { desc: 'New, used and vintage furniture in and around Calgary.', cat: 'Furniture', city: 'Calgary' });
for (const u of [amara, priya, marcus]) await addMember(yycFurn, u);
const torCal = await mkCircle('Toronto to Calgary Transport', 'toronto-to-calgary-transport', daniel, { desc: 'Drivers and senders coordinating moves along the Toronto ⇄ Calgary corridor.', cat: 'Transport', city: 'Toronto', rules: 'Post real journeys and real requests. Agree prices clearly.' });
for (const u of [omar, amara, marcus, priya]) await addMember(torCal, u);
const biz2 = await mkCircle('Alberta Small Business Community', 'alberta-small-business', owner, { desc: 'Local business owners sharing tips, leads and events.', cat: 'Business', city: 'Calgary', join: 'approval' });
await addMember(biz2, marcus); await addMember(biz2, lena, 'member', 'pending');
const homeowners = await mkCircle('Calgary Homeowners', 'calgary-homeowners', amara, { desc: 'Private group for homeowners — renovations, trades and neighbourhood tips.', cat: 'Home', city: 'Calgary', vis: 'private' });
await addMember(homeowners, marcus);
await mkCircle('Canadian Road Trip Network', 'canadian-road-trip-network', daniel, { desc: 'Share routes, stops and spare space in the truck on long Canadian drives.', cat: 'Travel', city: 'Winnipeg' });

const welcome = await gpost(yycBuy, calgaryLife, 'Welcome to Calgary Buy and Sell! Please read the rules above before posting. Happy trading 👋', 70, { pin: true });
await gpost(yycBuy, amara, 'Selling my sofa this weekend — open to offers, delivery possible.', 3, { attach: ['listing', sofa] });
await gpost(yycBuy, marcus, 'Quick poll: what is the best way to move a sofa across town?', 20, { poll: ['Pickup truck', 'Cargo van', 'Borrow a friend\'s SUV', 'Pay a mover'] });
await gpost(torCal, daniel, 'Leaving Toronto Nov 28 → Calgary with space for boxes, tires and small furniture. Stopping in Winnipeg and Regina.', 9, { attach: ['journey', tor] });
await gpost(torCal, omar, 'Looking for someone to carry four winter tires Winnipeg → Calgary this week.', 14, { attach: ['transport_request', (await pool.query(`SELECT id FROM transport_requests WHERE title LIKE 'Winter tires%' LIMIT 1`)).rows[0].id] });
await gpost(homeowners, amara, 'Anyone recommend a good furnace technician? Ours is making a rattling noise.', 5, { priv: true });
await pool.query(`UPDATE group_members SET status='active' WHERE group_id=$1 AND user_id=$2 AND status='pending' AND false`, [biz2, lena]);
for (const [g, title, d, venue, host] of [[yycBuy, 'Community garage sale meetup', 5, 'Eau Claire Market', calgaryLife], [biz2, 'Small business networking night', 9, 'Beltline Co-working', owner], [torCal, 'Drivers & senders coffee chat', 12, 'Online', daniel]] as const) {
  const pl = await place('Calgary');
  const ev = (await pool.query(`INSERT INTO events(group_id,host_id,title,description,starts_at,city,province,location,venue) VALUES ($1,$2,$3,'Come say hi, meet your neighbours and trade.', $4, $5,$6,$7,$8) RETURNING id`, [g, host, title, day(d, 23), pl.city, pl.province, pl.location, venue])).rows[0].id;
  await pool.query(`INSERT INTO event_rsvps(event_id,user_id,status) SELECT $1, user_id, 'going' FROM group_members WHERE group_id=$2 AND status='active' LIMIT 3`, [ev, g]);
  await pool.query(`UPDATE events SET going_count = (SELECT count(*) FROM event_rsvps WHERE event_id=$1 AND status='going') WHERE id=$1`, [ev]);
}

// clips (real transcoded videos) tagged with a product, a journey and a service
const clipSrc = ['gradients=s=540x960:speed=0.04', 'testsrc2=s=540x960:rate=24', 'mandelbrot=s=540x960:rate=24'];
const clip = async (author: string, body: string, src: string, tag: [string, string], hours: number, group?: string) => {
  const v = await mkVideo(author, src, body.slice(0, 40)); const pl = await place('Calgary');
  const p = (await pool.query(`INSERT INTO posts(author_id,group_id,kind,body,attachment_type,attachment_id,video_id,view_count,location,created_at) VALUES ($1,$2,'video',$3,$4,$5,$6,$7,$8, now() - ($9 || ' hours')::interval) RETURNING id`,
    [author, group ?? null, body, tag[0], tag[1], v, 100 + Math.floor(Math.random() * 900), group ? null : pl.location, String(hours)])).rows[0].id as string;
  await pool.query(`INSERT INTO feed_items(item_type,item_id,author_id,group_id,status,location,created_at) VALUES ('post',$1,$2,$3,'active',(SELECT location FROM posts WHERE id=$1), now() - ($4 || ' hours')::interval)`, [p, author, group ?? null, String(hours)]);
  return p;
};
const clipA = await clip(amara, 'Apartment move-out sale: the sofa goes first! DM me an offer or get it delivered.', clipSrc[0], ['listing', sofa], 4);
await clip(daniel, 'Truck is packed and the route is set: Toronto → Calgary, Nov 28. Space for your boxes!', clipSrc[1], ['journey', tor], 7, torCal);
await clip(marcus, 'Same-day furniture delivery around Calgary — I bring the straps and help carry.', clipSrc[2], ['transport_service', svc], 11);
for (const [t, id, u] of [['post', clipA, marcus], ['post', clipA, omar], ['post', clipA, calgaryLife]] as const) { await pool.query(`INSERT INTO reactions(user_id,target_type,target_id) VALUES ($1,$2,$3)`, [u, t, id]); await pool.query(`UPDATE posts SET like_count = like_count + 1 WHERE id=$1`, [id]); }
void welcome;

// stories: expiry follows platform_settings story.expiry_hours (24h)
const mkStory = async (author: string, o: { kind: string; text?: string; bg?: string; media?: string; link?: [string, string]; hoursAgo: number }) =>
  (await pool.query(`INSERT INTO stories(author_id,kind,media_id,text_body,bg,link_type,link_id,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval, now() - ($9 || ' hours')::interval) RETURNING id`,
    [author, o.kind, o.media ?? null, o.text ?? null, o.bg ?? null, o.link?.[0] ?? null, o.link?.[1] ?? null, String(24 - o.hoursAgo), String(o.hoursAgo)])).rows[0].id as string;
await mkStory(calgaryLife, { kind: 'text', text: 'Chinook warning today ☀️ Expect wind and a 10°C jump by the afternoon.', bg: '#246BFD', hoursAgo: 2 });
await mkStory(amara, { kind: 'photo', media: await image(amara, 'sofa', 0), link: ['listing', sofa], hoursAgo: 3 });
await mkStory(daniel, { kind: 'text', text: 'Leaving Toronto Nov 28 — 480 kg of space left in the truck!', bg: '#13B9B0', hoursAgo: 5 });
await mkStory(owner, { kind: 'text', text: 'Weekend sale: free delivery in Calgary over $500', bg: '#8E6CF5', link: ['business', biz], hoursAgo: 8 });
await mkStory(marcus, { kind: 'text', text: 'Slots open for furniture delivery this Saturday', bg: '#F5A623', hoursAgo: 1 });

await pool.query(`UPDATE fee_rules SET percent_bps=500 WHERE scope='product_sale'`);
await pool.query(`UPDATE fee_rules SET percent_bps=1000 WHERE scope='transport_booking'`);
// ---- payments (fake provider: no real money). Fees below are applied from fee_rules at the time of each payment.
for (const [u, n] of [[amara, 'amara'], [daniel, 'daniel'], [marcus, 'marcus']] as const)
  await pool.query(`INSERT INTO payment_accounts(user_id,provider,provider_account_id,charges_enabled,payouts_enabled,details_submitted) VALUES ($1,'fake',$2,true,true,true)`, [u, `acct_fake_seed_${n}`]);
const feeBps = async (scope: string) => (await pool.query(`SELECT percent_bps FROM fee_rules WHERE scope=$1 AND active`, [scope])).rows[0]?.percent_bps ?? 0;
const mkPayment = async (o: { kind: 'order' | 'booking' | 'boost'; subject: string; payer: string; payee: string | null; amount: number; scope: string; status?: string; refunded?: number; days?: number }) => {
  const bps = o.kind === 'boost' ? 0 : await feeBps(o.scope); const fee = o.kind === 'boost' ? o.amount : Math.round(o.amount * bps / 10000);
  const col = { order: 'order_id', booking: 'booking_id', boost: 'boost_id' }[o.kind];
  return (await pool.query(`INSERT INTO payments(kind,${col},payer_id,payee_id,amount_cents,fee_cents,fee_scope,fee_percent_bps,provider,provider_payment_id,provider_charge_id,status,refunded_cents,succeeded_at,created_at,description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'fake',$9,$10,$11,$12, now() - ($13 || ' days')::interval, now() - ($13 || ' days')::interval, 'twiqo seed payment') RETURNING id`,
    [o.kind, o.subject, o.payer, o.payee, o.amount, fee, o.scope, bps, `pi_fake_seed_${Math.random().toString(36).slice(2, 10)}`, `ch_fake_seed_${Math.random().toString(36).slice(2, 8)}`, o.status ?? 'succeeded', o.refunded ?? 0, String(o.days ?? 1)])).rows[0].id as string;
};
const mkOrder = async (listingTitle: string, buyer: string, seller: string, amount: number, status = 'agreed') => {
  const l = (await pool.query(`SELECT id FROM listings WHERE title=$1`, [listingTitle])).rows[0].id as string;
  const offer = await mkOffer({ kind: 'goods', customer: buyer, provider: seller, proposer: buyer, listing: l, amount, status: 'accepted' });
  return (await pool.query(`INSERT INTO orders(offer_id,listing_id,buyer_id,seller_id,quantity,total_cents,status,completed_at) VALUES ($1,$2,$3,$4,1,$5,$6, CASE WHEN $6='completed' THEN now() - interval '2 days' END) RETURNING id`, [offer, l, buyer, seller, amount, status])).rows[0].id as string;
};
const paidOrder = await mkOrder('Road Bike 54cm', omar, marcus, 62000, 'completed');
await mkPayment({ kind: 'order', subject: paidOrder, payer: omar, payee: marcus, amount: 62000, scope: 'product_sale', days: 3 });
await pool.query(`UPDATE orders SET payment_status='paid' WHERE id=$1`, [paidOrder]);
const refundedOrder = await mkOrder('Adjustable dumbbells 5–52 lb', priya, marcus, 30000);
await mkPayment({ kind: 'order', subject: refundedOrder, payer: priya, payee: marcus, amount: 30000, scope: 'product_sale', status: 'partially_refunded', refunded: 5000, days: 2 });
await pool.query(`UPDATE orders SET payment_status='partially_refunded' WHERE id=$1`, [refundedOrder]);
await mkOrder('Roof rack (fits most SUVs)', lena, daniel, 16000);                                         // agreed, unpaid: shows "Pay by card"
await mkPayment({ kind: 'booking', subject: live, payer: amara, payee: daniel, amount: 10500, scope: 'transport_booking', days: 1 });
await pool.query(`UPDATE bookings SET payment_status='paid' WHERE id=$1`, [live]);
// boosts: a featured service and a sponsored business post (shown labelled in feeds)
const boostRow = async (owner_: string, type: string, target: string, placement: string, price: number) =>
  (await pool.query(`INSERT INTO boosts(owner_id,target_type,target_id,placement,status,days,price_cents,starts_at,ends_at) VALUES ($1,$2,$3,$4,'active',7,$5, now() - interval '1 day', now() + interval '6 days') RETURNING id`, [owner_, type, target, placement, price])).rows[0].id as string;
const b1 = await boostRow(marcus, 'transport_service', svc, 'featured', 999); await mkPayment({ kind: 'boost', subject: b1, payer: marcus, payee: null, amount: 999, scope: 'featured_service' });
const adPost = (await pool.query(`SELECT id FROM posts WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1`, [biz])).rows[0].id as string;
const b2 = await boostRow(owner, 'post', adPost, 'sponsored', 1499); await mkPayment({ kind: 'boost', subject: b2, payer: owner, payee: null, amount: 1499, scope: 'sponsored' });
// an open dispute on the live booking, for the admin queue
await pool.query(`INSERT INTO disputes(booking_id,opened_by,other_party_id,reason,description) VALUES ($1,$2,$3,'damaged','One of the boxes arrived crushed at the corner and a lamp inside is cracked.')`, [live, amara, daniel]);

// ---- growth (phase 5)
await pool.query(`UPDATE users SET referral_code = substr(md5(id::text || 'twiqo'), 1, 8) WHERE referral_code IS NULL`);
// priya joined through amara and finished a deal, so amara has earned credit; lena joined through amara and hasn't dealt yet
await pool.query(`UPDATE users SET referred_by=$1 WHERE id IN ($2,$3)`, [amara, priya, lena]);
const refRow = (await pool.query(`INSERT INTO referrals(referrer_id,referee_id,status,qualified_at,reward_cents) VALUES ($1,$2,'qualified', now() - interval '3 days', 500) RETURNING id`, [amara, priya])).rows[0].id as string;
await pool.query(`INSERT INTO referrals(referrer_id,referee_id) VALUES ($1,$2)`, [amara, lena]);
await pool.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,ref_type,ref_id) VALUES ($1,500,'referral_reward','referral',$2)`, [amara, refRow]);
// brightside is a Business Pro member (fake provider)
await pool.query(`INSERT INTO subscriptions(user_id,status,provider,provider_customer_id,provider_subscription_id,current_period_end) VALUES ($1,'active','fake','cus_fake_seed_brightside','sub_fake_seed_brightside', now() + interval '21 days')`, [owner]);
// a few follows so "people you may know" has something to say
for (const [a, b] of [[omar, amara], [lena, amara], [priya, marcus], [amara, marcus]] as const) await pool.query(`INSERT INTO follows(follower_id,target_type,target_id) VALUES ($1,'user',$2) ON CONFLICT DO NOTHING`, [a, b]);
// 30 days of listing/service views for the seller insights screens (synthetic, spread over the last month)
await pool.query(`INSERT INTO analytics_events(user_id,anon_id,name,target_type,target_id,created_at)
  SELECT NULL, 'seed-anon-' || (g % 40), 'view', t.type, t.id, now() - (random() * 29 || ' days')::interval
  FROM generate_series(1, 260) g CROSS JOIN LATERAL (SELECT 'listing' AS type, id FROM listings WHERE seller_id = ANY($1::uuid[]) ORDER BY random() LIMIT 1) t`, [[amara, marcus, daniel, owner]]);
await pool.query(`INSERT INTO analytics_events(user_id,anon_id,name,target_type,target_id,created_at) SELECT NULL, 'seed-anon-' || (g % 25), 'view', 'transport_service', $1, now() - (random() * 29 || ' days')::interval FROM generate_series(1, 60) g`, [svc]);
await pool.query(`INSERT INTO analytics_events(user_id,name,created_at) SELECT u.id, 'search', now() - (random() * 20 || ' days')::interval FROM users u CROSS JOIN generate_series(1,3)`);

await pool.query(`INSERT INTO banned_words(term,severity) VALUES ('counterfeit','block'),('western union','flag'),('wire transfer only','flag')`);

console.log(`Done. Sign in with any seeded username (admin, moderator, amara, marcus, daniel, priya, lena, omar, calgarylife, brightside) and password "${PASSWORD}".`);
await pool.end();
