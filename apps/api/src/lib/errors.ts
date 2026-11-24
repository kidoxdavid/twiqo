import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') { super(message); }
}
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m, 'forbidden');
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const conflict = (m: string, code = 'conflict') => new HttpError(409, m, code);

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'validation', message: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr?.code === '23505') return res.status(409).json({ error: { code: 'conflict', message: 'That already exists' } });
  if (pgErr?.code === '23514' || pgErr?.code === '23503') return res.status(400).json({ error: { code: 'constraint', message: 'Invalid data' } });
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
