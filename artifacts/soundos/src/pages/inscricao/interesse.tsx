import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { toast } from "sonner";
import { DynamicForm, type DynamicFormField } from "@/components/dynamic-form";
import { MapPin, CalendarDays } from "lucide-react";
import logoPath from "@/assets/logotipo-soundos.png";
import { formatDateBR } from "@/lib/date";
import { PaymentRequiredNotice } from "@/components/payment-required-notice";

interface FormDef {
  tipo: string;
  consentimento?: { texto: string };
  evento: {
    id: number;
    nome: string;
    descricao: string | null;
    local: string | null;
    dataInicio: string | null;
    dataFim: string | null;
  };
  versao: {
    campos: DynamicFormField[];
  };
}

export default function InteresseFormPage() {
  const params = useParams<{ slug?: string }>();
  const slug = params.slug;
  const isEmbed = new URLSearchParams(window.location.search).get("embed") === "1";

  const [formDef, setFormDef] = useState<FormDef | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/public/formularios/${slug}`)
      .then(r => {
        if (!r.ok) { setNotFound(true); return null; }
        return r.json();
      })
      .then(data => {
        if (data) {
          setFormDef(data);
        }
      });
  }, [slug]);

  const handleSubmit = async (respostas: Record<string, string>, consentimentoWhatsapp: boolean) => {
    const res = await fetch(`/api/public/formularios/${slug}/submissoes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ respostas, consentimentoWhatsapp })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const message = typeof err.error === "string" ? err.error : "Erro ao enviar formulário. Tente novamente.";
      toast.error(message);
      throw new Error("Failed");
    }
    setSuccess(true);
  };

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="text-center space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Formulário não encontrado</h2>
          <p className="text-sm text-muted-foreground">O link de interesse pode ter expirado ou é inválido.</p>
        </div>
      </div>
    );
  }

  if (!formDef) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="h-8 w-8 bg-muted rounded-full"></div>
          <div className="h-4 w-32 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  if (formDef.tipo === 'COMPLETO') {
    return <PaymentRequiredNotice eventName={formDef.evento.nome} embed={isEmbed} />;
  }

  if (success) {
    return (
      <div className={`min-h-screen flex items-center justify-center bg-background px-4 ${isEmbed ? 'bg-transparent' : ''}`}>
        <div className="text-center space-y-4 py-8 max-w-md w-full border border-border/50 rounded-xl bg-card shadow-sm p-8">
          <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center mx-auto">
            <svg className="h-8 w-8 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-foreground">Interesse registrado!</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Obrigado por registrar seu interesse em <strong>{formDef.evento.nome}</strong>.
              Entraremos em contato quando houver novidades.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-background ${isEmbed ? 'bg-transparent py-4' : 'py-8'}`}>
      {!isEmbed && (
        <div className="border-b border-border/60 bg-background/95 backdrop-blur-sm fixed top-0 left-0 right-0 z-10">
          <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
            <img src={logoPath} alt="Soundfulness" className="h-8 w-auto" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest">Lista de Interesse</p>
              <p className="text-sm font-semibold text-foreground truncate">
                {formDef.evento.nome}
              </p>
            </div>
          </div>
        </div>
      )}

      {formDef.evento && (
        <div className={`bg-primary/8 border-b border-primary/15 ${!isEmbed ? 'mt-14' : ''}`}>
          <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 space-y-1">
            {formDef.evento.local && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                <span>{formDef.evento.local}</span>
              </div>
            )}
            {(formDef.evento.dataInicio || formDef.evento.dataFim) && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" />
                <span>{formatDateBR(formDef.evento.dataInicio, "?")}{formDef.evento.dataFim ? ` → ${formatDateBR(formDef.evento.dataFim, "?")}` : ""}</span>
              </div>
            )}
            {formDef.evento.descricao && (
              <p className="text-xs text-muted-foreground mt-1.5">{formDef.evento.descricao}</p>
            )}
          </div>
        </div>
      )}

      <div className={`max-w-xl mx-auto px-4 sm:px-6 ${!isEmbed ? 'mt-6' : ''}`}>
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {!isEmbed && (
            <div className="mb-6 pb-6 border-b border-border">
              <h2 className="text-xl font-semibold text-foreground">Demonstrar Interesse</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Deixe seus contatos para ser avisado sobre novidades deste evento.
              </p>
            </div>
          )}

          <DynamicForm
            fields={formDef.versao.campos}
            onSubmit={handleSubmit}
            consentimento={formDef.consentimento}
            buttonText="Registrar Interesse"
          />
        </div>
      </div>
    </div>
  );
}