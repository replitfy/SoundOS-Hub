import { AlertTriangle, CheckCircle2 } from "lucide-react";

// Pedaços compartilhados pelos cartões de canal (Instagram e WhatsApp) da página de conduta.

export const TIPOS_CONEXAO: Record<string, string> = {
  INSTAGRAM: "Instagram",
  WHATSAPP_MESSAGING: "WhatsApp",
  FACEBOOK_PAGE: "Facebook",
};

export const STATUS_CLASSES: Record<string, string> = {
  respondido: "border-emerald-400 text-emerald-700 bg-emerald-50",
  ignorado: "border-border text-muted-foreground bg-muted/40",
  falhou: "border-destructive/50 text-destructive bg-destructive/5",
  recebido: "border-amber-400 text-amber-700 bg-amber-50",
};

export function LinhaVerificacao({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-1.5 text-xs ${ok ? "" : "text-amber-800"}`}>
      {ok
        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" />
        : <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}
