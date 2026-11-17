import { APP_VERSION } from "@/version";

export function VersionBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="Versão do deploy (data e hora, ddmmyyyy-hhmm)"
      data-testid="app-version"
      className={`font-mono tabular-nums ${className}`}
    >
      Versão {APP_VERSION}
    </span>
  );
}
