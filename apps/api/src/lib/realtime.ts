import type { Response } from 'express';

/** In-process SSE hub. Replace with Redis pub/sub when running more than one API node. */
const clients = new Map<string, Set<Response>>();

export function subscribe(userId: string, res: Response) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(res);
  res.on('close', () => { clients.get(userId)?.delete(res); if (!clients.get(userId)?.size) clients.delete(userId); });
}
export function publish(userId: string, event: string, data: unknown) {
  for (const r of clients.get(userId) ?? []) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
