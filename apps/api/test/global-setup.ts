import pg from 'pg';

/** Start every run from an empty schema, then apply real migrations (no mocks). */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://twiqo:twiqo@localhost:5432/twiqo_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  process.env.DATABASE_URL = url; process.env.NODE_ENV = 'test';
  const { runMigrations } = await import('../src/db/migrate.js');
  const { pool } = await import('../src/db/pool.js');
  await runMigrations();
  await pool.end();
}
