/**
 * Substituto de "@/contexts/access" para testes de telas que só precisam saber
 * se o perfil é administrador. Use dentro de vi.mock:
 *   vi.mock("@/contexts/access", async () => (await import("@/test/access-mock")).accessMock(() => state.isAdmin));
 */
export function accessMock(isAdmin: () => boolean) {
  return {
    useAccess: () => ({
      status: "ready" as const,
      areas: [] as string[],
      isAdmin: isAdmin(),
      profileName: isAdmin() ? "Admin" : "Usuário",
      can: () => true,
      canPath: () => true,
      homeHref: "/",
      retry: () => {},
    }),
  };
}
