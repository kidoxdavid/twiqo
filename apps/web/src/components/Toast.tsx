import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
const Ctx = createContext<(msg: string, kind?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(Ctx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const show = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => { setT({ msg, kind }); setTimeout(() => setT(null), 3200); }, []);
  return <Ctx.Provider value={show}>{children}{t && <div className={`toast ${t.kind === 'err' ? 'err' : ''}`} role="status">{t.msg}</div>}</Ctx.Provider>;
}
