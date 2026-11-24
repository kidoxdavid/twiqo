import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';

await runMigrations();
const app = createApp();
app.listen(config.PORT, () => console.log(`TWIQO API listening on :${config.PORT}`));

// Housekeeping (move to a real job runner when workers are introduced)
setInterval(async () => {
  try {
    const r = await pool.query(`UPDATE listings SET status='expired' WHERE status='active' AND expires_at < now() RETURNING id`);
    if (r.rowCount) await pool.query(`UPDATE feed_items SET status='pending' WHERE item_type='listing' AND item_id = ANY($1::uuid[])`, [r.rows.map((x) => x.id)]);
  } catch (e) { console.error('expiry job failed', e); }
}, 5 * 60_000).unref();
