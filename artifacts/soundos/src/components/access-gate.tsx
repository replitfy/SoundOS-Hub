import type { ReactNode } from "react";
import { Redirect, useLocation } from "wouter";
import { AlertTriangle, Lock, ShieldAlert } from "lucide-react";
import { requirementForPath } from "@workspace/access-areas";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";

function Notice({
  icon,
  title,
  description,
  actions,
  testId,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex justify-center py-12">
      <Card className="w-full max-w-lg shadow-sm border-border/50" data-testid={testId}>
        <CardContent className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          {icon}
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
          {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Decide, pelo endereço aberto, se o perfil do usuário pode ver a tela. Só
 * mostra o conteúdo depois que o perfil foi confirmado pelo servidor: durante
 * o carregamento ou em caso de erro nada restrito aparece. A proteção real dos
 * dados continua no servidor; isto evita telas quebradas e explica o motivo.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const access = useAccess();
  const [location] = useLocation();
  const { requestNavigate } = useUnsavedGuard();
  const { t } = useLang();

  if (access.status === "loading") {
    return (
      <div className="flex justify-center py-24" data-testid="access-loading">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (access.status === "error") {
    return (
      <Notice
        testId="access-error"
        icon={<AlertTriangle className="h-9 w-9 text-amber-500" />}
        title={t("access.error.title")}
        description={t("access.error.desc")}
        actions={<Button onClick={access.retry}>{t("access.error.retry")}</Button>}
      />
    );
  }

  const requirement = requirementForPath(location);
  if (requirement.kind !== "areas" || access.canPath(location)) return <>{children}</>;

  if (access.areas.length === 0) {
    return (
      <Notice
        testId="access-empty-profile"
        icon={<ShieldAlert className="h-9 w-9 text-amber-500" />}
        title={t("access.empty.title")}
        description={t("access.empty.desc")}
        actions={<Button variant="outline" onClick={() => requestNavigate("/meu-perfil")}>{t("access.empty.edit_profile")}</Button>}
      />
    );
  }

  // A página inicial do perfil é a primeira tela que ele pode abrir.
  if ((location === "/" || location === "/dashboard") && access.homeHref) {
    return <Redirect to={access.homeHref} />;
  }

  return (
    <Notice
      testId="access-denied"
      icon={<Lock className="h-9 w-9 text-muted-foreground" />}
      title={t("access.denied.title")}
      description={t("access.denied.desc")}
      actions={access.homeHref
        ? <Button variant="outline" onClick={() => requestNavigate(access.homeHref!)}>{t("access.denied.go_home")}</Button>
        : undefined}
    />
  );
}
