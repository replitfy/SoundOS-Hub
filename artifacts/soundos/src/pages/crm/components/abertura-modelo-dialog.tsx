import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLang, type TranslationKey } from "@/contexts/language";
import { apiErrorBlockers, errorText } from "../atendimento-errors";
import type { AberturaController } from "../abertura-hooks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: AberturaController;
  /** Depois de um envio aceito (recarrega o que a tela mostra). */
  onSent?: () => void;
  /** Depois de confirmar o vínculo da conversa. */
  onLinked?: () => void;
}

/**
 * Confirmação do modelo de abertura do WhatsApp. Mostra o texto exato que a pessoa vai receber e o que
 * bloqueia o envio agora; o servidor confere tudo de novo ao enviar. O envio acontece só pelo clique aqui.
 */
export function AberturaModeloDialog({ open, onOpenChange, controller, onSent, onLinked }: Props) {
  const { t } = useLang();
  const { preview } = controller;

  const enviar = async () => {
    try {
      await controller.send();
      toast.success(t("crm.abertura.enviado"));
      onOpenChange(false);
      onSent?.();
    } catch (err) {
      const bloqueios = apiErrorBlockers(err);
      toast.error(bloqueios.length > 0 ? t("crm.err.OPENING_BLOCKED") : errorText(err, t));
    }
  };

  const vincular = async () => {
    if (preview?.vinculo.tipo !== "a_confirmar" || preview.vinculo.conversationId === undefined) return;
    try {
      await controller.link(preview.vinculo.conversationId);
      toast.success(t("crm.vinculo.confirmado"));
      onLinked?.();
    } catch (err) {
      toast.error(errorText(err, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="crm-abertura-dialog">
        <DialogHeader>
          <DialogTitle>{t("crm.abertura.titulo")}</DialogTitle>
          <DialogDescription>{t("crm.abertura.descricao")}</DialogDescription>
        </DialogHeader>

        {controller.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("crm.abertura.verificando")}</p>
        ) : controller.isError || !preview ? (
          <p className="text-sm text-destructive">{t("crm.abertura.erro_previa")}</p>
        ) : (
          <div className="space-y-3">
            {preview.texto ? (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t("crm.abertura.texto_enviado")}</p>
                <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-sm" data-testid="crm-abertura-texto">{preview.texto}</p>
              </div>
            ) : null}
            {preview.bloqueios.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3" data-testid="crm-abertura-bloqueios">
                <p className="mb-1 text-sm font-medium text-destructive">{t("crm.abertura.bloqueado")}</p>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {preview.bloqueios.map(b => <li key={b}>{t(`crm.abertura.bloqueio.${b}` as TranslationKey)}</li>)}
                </ul>
                {preview.bloqueios.includes("sem_telefone") && preview.celularInformadoNaoGravado && (
                  <p className="mt-2 text-sm" data-testid="crm-abertura-celular-nao-gravado">{t("crm.sem_telefone.conferencia")}</p>
                )}
              </div>
            )}
            {preview.vinculo.tipo === "a_confirmar" && (
              <Button size="sm" variant="outline" onClick={vincular} disabled={controller.linking} data-testid="crm-abertura-vincular">
                {t("crm.vinculo.confirmar")}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancelar")}</Button>
          <Button onClick={enviar} disabled={!preview?.podeEnviar || controller.sending} data-testid="crm-abertura-enviar">
            {controller.sending ? t("crm.abertura.enviando") : t("crm.abertura.enviar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
