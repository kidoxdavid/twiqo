import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://twiqo:twiqo@localhost:5432/twiqo_dev'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('./uploads'),
  RATE_LIMIT_DISABLED: z.enum(['true', 'false']).default('false'),
  // Video: 'local' = ffmpeg on this server (dev / small scale), 'bunny' = Bunny Stream
  VIDEO_PROVIDER: z.enum(['local', 'bunny']).default('local'),
  BUNNY_LIBRARY_ID: z.string().optional(),
  BUNNY_API_KEY: z.string().optional(),           // library API key (server side only)
  BUNNY_CDN_HOSTNAME: z.string().optional(),      // e.g. vz-xxxxxxxx-xxx.b-cdn.net
  BUNNY_WEBHOOK_SECRET: z.string().optional(),    // random string you append to the webhook URL as ?secret=
  // Payments: 'fake' = in-memory test provider (development only), 'stripe' = Stripe Connect
  PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),            // endpoint for account events (payments, refunds)
  STRIPE_PRICE_BUSINESS_PRO: z.string().optional(),        // Stripe Price id (price_...) for the Business Pro monthly subscription
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),    // endpoint for events from connected accounts (account.updated, payouts)
});

export const config = schema.parse(process.env);
if (config.VIDEO_PROVIDER === 'bunny' && !(config.BUNNY_LIBRARY_ID && config.BUNNY_API_KEY && config.BUNNY_CDN_HOSTNAME)) {
  throw new Error('VIDEO_PROVIDER=bunny needs BUNNY_LIBRARY_ID, BUNNY_API_KEY and BUNNY_CDN_HOSTNAME');
}
if (config.PAYMENT_PROVIDER === 'stripe' && !(config.STRIPE_SECRET_KEY && config.STRIPE_PUBLISHABLE_KEY && config.STRIPE_WEBHOOK_SECRET)) {
  throw new Error('PAYMENT_PROVIDER=stripe needs STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET');
}
if (config.NODE_ENV === 'production' && config.PAYMENT_PROVIDER === 'fake') {
  throw new Error('The fake payment provider cannot be used in production. Set PAYMENT_PROVIDER=stripe.');
}
if (config.NODE_ENV === 'production' && config.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
