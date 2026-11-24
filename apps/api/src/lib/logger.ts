import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? (config.NODE_ENV === 'test' ? 'error' : 'info')] ?? 20;
/** One JSON object per line on stdout, easy for any log shipper. Never log secrets, tokens, passwords or full request bodies. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (order[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
declare module 'express-serve-static-core' { interface Request { id?: string } }

/** Gives every request an id (honouring a sane incoming x-request-id), echoes it back, and writes one access-log line when it finishes. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/ready') return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // path only: query strings can carry tokens (the realtime stream takes ?token=)
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'request', { id: req.id, method: req.method, path: req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), status: res.statusCode, ms: Math.round(ms), user: req.user?.id });
  });
  next();
}

// ---- error reporting: structured log always; optional webhook (Slack-compatible JSON) when ERROR_WEBHOOK_URL is set. Swap for Sentry's SDK here if you prefer.
let sent: number[] = [];
export function reportError(err: unknown, ctx: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  log('error', e.message, { stack: e.stack?.split('\n').slice(0, 8).join('\n'), ...ctx });
  const url = process.env.ERROR_WEBHOOK_URL; if (!url) return;
  const now = Date.now(); sent = sent.filter((t) => now - t < 60_000); if (sent.length >= 10) return;   // at most 10 reports a minute, so an outage doesn't flood the channel
  sent.push(now);
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `twiqo error: ${e.message}`, request_id: ctx.request_id, path: ctx.path, env: config.NODE_ENV }) }).catch(() => undefined);
}
