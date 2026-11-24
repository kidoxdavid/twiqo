import webpush from 'web-push';
import { config } from '../config.js';

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface PushSender { readonly enabled: boolean; publicKey(): string | null; send(t: PushTarget, payload: { title: string; body: string; url: string; tag?: string }): Promise<'ok' | 'gone'> }
export class WebPushSender implements PushSender {
  constructor() { if (this.enabled) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!); }
  get enabled() { return !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY); }
  publicKey() { return config.VAPID_PUBLIC_KEY ?? null; }
  async send(t: PushTarget, payload: { title: string; body: string; url: string; tag?: string }) {
    try { await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, JSON.stringify(payload), { TTL: 3600 }); return 'ok' as const; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) return 'gone' as const; throw e; }
  }
}
/** Test double: records what would have been pushed. */
export class FakePushSender implements PushSender { enabled = true; sent: { endpoint: string; payload: any }[] = []; gone = new Set<string>(); fail = false;
  publicKey() { return 'BFAKEPUBLICKEY'; }
  async send(t: PushTarget, payload: any) { if (this.fail) throw new Error('push service down'); if (this.gone.has(t.endpoint)) return 'gone' as const; this.sent.push({ endpoint: t.endpoint, payload }); return 'ok' as const; } }
let sender: PushSender | undefined;
export const pushSender = (): PushSender => (sender ??= new WebPushSender());
export const setPushSender = (s: PushSender | undefined) => { sender = s; };
