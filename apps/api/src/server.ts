import { createApp } from './app.js';
import { config } from './config.js';
import { startWorker } from './lib/jobs.js';
import { runMigrations } from './db/migrate.js';

await runMigrations();
const app = createApp();
app.listen(config.PORT, () => console.log(`twiqo API listening on :${config.PORT}`));

// Background work (emails, notifications, expiry, auto-completion) runs through the Postgres job queue
await startWorker();
