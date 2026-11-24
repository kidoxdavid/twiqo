/* Drops everything in the dev database, re-applies migrations and re-seeds. Development only. */
import { config } from '../config.js';
import { pool } from './pool.js';

if (config.NODE_ENV === 'production') throw new Error('Refusing to reset production');
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await import('./seed.js');
