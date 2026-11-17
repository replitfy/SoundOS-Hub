import { createContext, useContext, useMemo, type ReactNode } from "react";
import { getGetMyAccessQueryKey, useGetMyAccess } from "@workspace/api-client-react";
import { canAccessPath, firstAllowedHref } from "@workspace/access-areas";
import { useUserSession } from "@/contexts/user-session";

type AccessStatus = "loading" | "ready" | "error";

interface AccessContextType {
  /** "loading" e "error" nunca liberam nada: o menu e as telas só aparecem com o perfil confirmado. */
  status: AccessStatus;
  areas: readonly string[];
  isAdmin: boolean;
  profileName: string | null;
  can: (areaId: string) => boolean;
  canPath: (pathname: string) => boolean;
  /** Primeira tela permitida na ordem do menu (a "inicial" do perfil), ou null se não há nenhuma. */
  homeHref: string | null;
  retry: () => void;
}

const AccessContext = createContext<AccessContextType | null>(null);

const NO_AREAS: readonly string[] = [];

/** Revalida o perfil quando a janela volta ao foco e a cada minuto: o administrador pode mudar perfis a qualquer hora. */
const REFRESH_MS = 60_000;

export function AccessProvider({ children }: { children: ReactNode }) {
  const { user } = useUserSession();
  const userId = user?.id ?? null;

  const query = useGetMyAccess({
    query: {
      // A chave inclui o usuário para que quem entra depois nunca veja o perfil de quem saiu.
      queryKey: [...getGetMyAccessQueryKey(), userId],
      enabled: userId !== null,
      staleTime: 0,
      refetchOnWindowFocus: "always",
      refetchInterval: REFRESH_MS,
      retry: 1,
    },
  });

  const data = query.data && query.data.userId === userId ? query.data : undefined;
  const status: AccessStatus = data ? "ready" : query.isError ? "error" : "loading";
  const areas = data?.areas ?? NO_AREAS;
  const refetch = query.refetch;

  const value = useMemo<AccessContextType>(() => ({
    status,
    areas,
    isAdmin: data?.isAdmin === true,
    profileName: data?.profileName ?? null,
    can: (areaId: string) => areas.includes(areaId),
    canPath: (pathname: string) => canAccessPath(pathname, areas),
    homeHref: firstAllowedHref(areas),
    retry: () => { void refetch(); },
  }), [status, areas, data?.isAdmin, data?.profileName, refetch]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessContextType {
  const ctx = useContext(AccessContext);
  if (!ctx) throw new Error("useAccess must be used within AccessProvider");
  return ctx;
}
