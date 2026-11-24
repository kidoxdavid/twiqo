import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { errorMiddleware } from './lib/errors.js';
import { storage } from './lib/storage.js';
import { identity } from './modules/identity.js';
import { users } from './modules/users.js';
import { business } from './modules/business.js';
import { media } from './modules/media.js';
import { content } from './modules/content.js';
import { marketplace } from './modules/marketplace.js';
import { feed } from './modules/feed.js';
import { messaging } from './modules/messaging.js';
import { search } from './modules/search.js';
import { admin } from './modules/admin.js';
import { transport } from './modules/transport.js';
import { offers } from './modules/offers.js';
import { bookings } from './modules/bookings.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.WEB_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '200kb' }));
  app.use('/media', express.static(storage.root, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', identity, users, business, media, content, marketplace, feed, messaging, search, transport, offers, bookings, admin);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  app.use(errorMiddleware);
  return app;
}
