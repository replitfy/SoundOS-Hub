import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

const USER_SESSION_KEY = "soundos_user_session";

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  /** Token de sessão assinado pelo servidor (POST /auth/login). Deve ser
   * enviado como "Authorization: Bearer <sessionToken>" em toda chamada
   * autenticada — o servidor não confia mais em um id de usuário bruto. */
  sessionToken: string;
}

interface UserSessionContextType {
  user: SessionUser | null;
  login: (user: SessionUser) => void;
  logout: () => void;
  /** Header pronto para uso em fetch(): {} se não estiver logado. */
  authHeader: Record<string, string>;
}

const UserSessionContext = createContext<UserSessionContextType | null>(null);

function readSession(): SessionUser | null {
  try {
    const raw = sessionStorage.getItem(USER_SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

/**
 * Lê o token de sessão diretamente do sessionStorage, fora de um componente
 * React. Usado para registrar um `setAuthTokenGetter` global no bootstrap do
 * app (main.tsx) — assim TODA chamada feita pelos hooks gerados
 * (@workspace/api-client-react) carrega automaticamente o Authorization
 * header, sem depender de cada página lembrar de passar `authHeader`.
 */
export function getStoredSessionToken(): string | null {
  return readSession()?.sessionToken ?? null;
}

export function UserSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(readSession);

  const login = useCallback((u: SessionUser) => {
    sessionStorage.setItem(USER_SESSION_KEY, JSON.stringify(u));
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(USER_SESSION_KEY);
    setUser(null);
  }, []);

  const authHeader: Record<string, string> = user?.sessionToken ? { Authorization: `Bearer ${user.sessionToken}` } : {};

  return (
    <UserSessionContext.Provider value={{ user, login, logout, authHeader }}>
      {children}
    </UserSessionContext.Provider>
  );
}

export function useUserSession(): UserSessionContextType {
  const ctx = useContext(UserSessionContext);
  if (!ctx) throw new Error("useUserSession must be used within UserSessionProvider");
  return ctx;
}
