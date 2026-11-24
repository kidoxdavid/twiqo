const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

let access: string | null = null;
let onAuthLost: () => void = () => {};
export const setAuthLostHandler = (f: () => void) => { onAuthLost = f; };
export const getAccessToken = () => access;

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
