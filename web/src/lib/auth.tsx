import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { staffApi, tokens } from './api';
import type { User } from './types';

interface StaffAuth {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<StaffAuth | null>(null);

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!tokens.get('staff')) {
      setReady(true);
      return;
    }
    staffApi<{ role: string; user?: User }>('/auth/me')
      .then((me) => setUser(me.user ?? null))
      .catch(() => tokens.clear('staff'))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onExpired = (e: Event) => {
      if ((e as CustomEvent).detail === 'staff') setUser(null);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await staffApi<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email, password } });
    tokens.set('staff', res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    tokens.clear('staff');
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}

export function useStaffAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useStaffAuth outside StaffAuthProvider');
  return ctx;
}
