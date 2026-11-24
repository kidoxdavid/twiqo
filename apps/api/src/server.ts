import { createApp } from './app.js';
import { config } from './config.js';
import { runHousekeeping } from './lib/jobs.js';
import { runMigrations } from './db/migrate.js';

await runMigrations();
const app = createApp();
app.listen(config.PORT, () => console.log(`TWIQO API listening on :${config.PORT}`));

// Housekeeping: offer/listing/journey/request expiry and booking auto-completion
setInterval(() => { runHousekeeping().catch((e) => console.error('housekeeping failed', e)); }, 5 * 60_000).unref();
