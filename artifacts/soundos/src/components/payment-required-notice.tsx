import { useLang } from "@/contexts/language";
import { ShieldCheck } from "lucide-react";
import logoPath from "@/assets/logotipo-soundos.png";

export function PaymentRequiredNotice({ eventName, embed = false }: { eventName?: string | null; embed?: boolean }) {
  const { t } = useLang();
  return (
    <div className={`min-h-[100dvh] ${embed ? "bg-transparent py-4" : "bg-background"}`}>
      {!embed && (
        <div className="border-b border-border/60 bg-background/95">
          <div className="max-w-xl mx-auto px-4 sm:px-6 py-3"><img src={logoPath} alt="Soundfulness" className="h-8 w-auto" /></div>
        </div>
      )}
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden" data-testid="notice-payment-required">
          <div className="px-6 pt-6 pb-5 border-b border-border bg-primary/5">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-primary flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> {t("pr.label")}
            </p>
            {eventName && <p className="text-sm font-medium text-foreground mt-2" data-testid="text-event-name">{eventName}</p>}
            <h1 className="text-xl font-semibold text-foreground mt-1">{t("pr.title")}</h1>
          </div>
          <div className="p-6 space-y-3 text-sm text-muted-foreground">
            <p>{t("pr.body")}</p>
            <p className="text-xs">{t("pr.interest_hint")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
