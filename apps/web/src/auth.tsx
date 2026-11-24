import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshSession, setAuthLostHandler, setTokens, storedRefresh } from './api';

export interface Me { id: string; locale?: 'en' | 'fr'; referral_code?: string; username: string; email: string; display_name: string; city: string | null; province: string | null; bio: string | null; permissions: string[]; roles: string[]; privacy: Record<string, any>; follower_count: number; following_count: number; account_type: string }
interface AuthCtx { me: Me | null; loading: boolean; login: (id: string, pw: string, otp?: string) => Promise<void>; register: (b: Record<string, unknown>) => Promise<void>; logout: () => Promise<void>; reload: () => Promise<void> }
const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const reload = useCallback(async () => { try { setMe((await api('/me')).user); } catch { setMe(null); } }, []);
  useEffect(() => {
    setAuthLostHandler(() => { setMe(null); qc.clear(); });
    (async () => { if (storedRefresh() && (await refreshSession())) await reload(); setLoading(false); })();
  }, [reload, qc]);

  const value = useMemo<AuthCtx>(() => ({
    me, loading, reload,
    login: async (identifier, password, otp) => { const j = await api('/auth/login', { body: { identifier, password, ...(otp ? { otp } : {}) } }); setTokens(j.access_token, j.refresh_token); setMe(j.user); qc.clear(); },
    register: async (b) => { const j = await api('/auth/register', { body: b }); setTokens(j.access_token, j.refresh_token); setMe(j.user); qc.clear(); },
    logout: async () => { await api('/auth/logout', { body: { refresh_token: storedRefresh() } }).catch(() => {}); setTokens(null, null); setMe(null); qc.clear(); },
  }), [me, loading, reload, qc]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
