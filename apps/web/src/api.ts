const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

let access: string | null = null;
let onAuthLost: () => void = () => {};
export const setAuthLostHandler = (f: () => void) => { onAuthLost = f; };
export const getAccessToken = () => access;

const ANON_KEY = 'twiqo.anon';
/** Random per-browser id used only to de-duplicate views for signed-out visitors. It is not linked to any account. */
export const anonId = () => { try { let v = localStorage.getItem(ANON_KEY); if (!v) { v = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36); localStorage.setItem(ANON_KEY, v); } return v; } catch { return null; } };
const optedOut = () => typeof navigator !== 'undefined' && (navigator.doNotTrack === '1' || (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
/** Fire-and-forget product analytics. Skipped entirely when the browser sends Do Not Track / Global Privacy Control. */
export function track(name: 'view' | 'search' | 'share' | 'contact_click', target?: { type: string; id: string }, props?: Record<string, string | number | boolean>) {
  if (optedOut()) return;
  void api('/analytics/events', { body: { events: [{ name, target_type: target?.type, target_id: target?.id, props }] } }).catch(() => undefined);
}

const REFRESH_KEY = 'twiqo.refresh';
export const storedRefresh = () => { try { return localStorage.getItem(REFRESH_KEY); } catch { return null; } };
export function setTokens(a: string | null, r: string | null) {
  access = a;
  try { r ? localStorage.setItem(REFRESH_KEY, r) : localStorage.removeItem(REFRESH_KEY); } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: { path: string; message: string }[]) { super(message); }
}

let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const r = storedRefresh();
    if (!r) return false;
    const res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: r }) });
    if (!res.ok) { setTokens(null, null); return false; }
    const j = await res.json();
    setTokens(j.access_token, j.refresh_token);
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; query?: Record<string, unknown> } = {}, retry = true): Promise<T> {
  const qs = opts.query ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => [k, String(v)])).toString() : '';
  const headers: Record<string, string> = {};
  if (access) headers.Authorization = `Bearer ${access}`;
  const aid = anonId(); if (aid && !optedOut()) headers['x-anon-id'] = aid;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}${qs}`, { method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'), headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  if (res.status === 401 && retry && storedRefresh()) {
    if (await refreshSession()) return api<T>(path, opts, false);
    onAuthLost();
  }
  if (res.status === 204) return undefined as T;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, j?.error?.message ?? 'Something went wrong', j?.error?.code, j?.error?.details);
  return j as T;
}
