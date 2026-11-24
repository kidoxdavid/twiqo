/* Development seed data. Safe to re-run (skips if already seeded). Never run in production. */
import crypto from 'node:crypto';
import sharp from 'sharp';
import { pool } from './pool.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../lib/auth.js';
import { storage } from '../lib/storage.js';
import { config } from '../config.js';

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

const admin = await mkUser('admin', 'TWIQO Admin', 'Calgary', 'Platform administrator', 'super_admin');
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

await pool.query(`INSERT INTO banned_words(term,severity) VALUES ('counterfeit','block'),('western union','flag'),('wire transfer only','flag')`);
await pool.query(`UPDATE fee_rules SET percent_bps=500 WHERE scope='product_sale'`);
await pool.query(`UPDATE fee_rules SET percent_bps=1000 WHERE scope='transport_booking'`);

console.log(`Done. Sign in with any seeded username (admin, moderator, amara, marcus, daniel, priya, lena, omar, calgarylife, brightside) and password "${PASSWORD}".`);
await pool.end();
