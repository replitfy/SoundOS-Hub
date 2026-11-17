import { MessageCircle } from "lucide-react";
import { useGetPessoaWhatsappConversation } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLang, type TranslationKey } from "@/contexts/language";
import { Bolha } from "../crm/components/card-chat";

/**
 * Conversa de WhatsApp completa da pessoa, só para leitura (arquivos incluídos). Quem precisa da área Conversas
 * além de Pessoas; o servidor confere de novo. Ver aqui não dá os arquivos como vistos: isso só acontece ao abrir
 * a conversa em Conversas ou o cartão do CRM.
 */
export function ConversaWhatsappDaFicha({ pessoaId }: { pessoaId: number }) {
  const { t } = useLang();
  const { data, isLoading, isError, refetch } = useGetPessoaWhatsappConversation(pessoaId);

  return (
    <Card className="shadow-sm border-border/50" data-testid="pessoa-conversa-whatsapp">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5" />
          {t("pessoa.whatsapp.conversa_titulo")}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 py-4 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("crm.chat.carregando")}</p>
        ) : isError || !data ? (
          <p className="text-sm text-destructive" data-testid="pessoa-conversa-erro">{t("pessoa.whatsapp.conversa_erro")}</p>
        ) : data.vinculo.tipo === "a_confirmar" ? (
          <p className="text-sm text-muted-foreground" data-testid="pessoa-conversa-a-confirmar">{t("pessoa.whatsapp.conversa_a_confirmar")}</p>
        ) : data.vinculo.tipo === "bloqueada" ? (
          <p className="text-sm text-muted-foreground">{t("pessoa.whatsapp.conversa_bloqueada")}</p>
        ) : data.vinculo.tipo === "nenhuma" ? (
          <p className="text-sm text-muted-foreground" data-testid="pessoa-conversa-sem-vinculo">{t("pessoa.whatsapp.conversa_sem_vinculo")}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {data.conversa ? `${t(`crm.chat.status.${data.conversa.status}` as TranslationKey)} · ` : ""}{t("pessoa.whatsapp.conversa_nota")}
            </p>
            <div className="max-h-[480px] space-y-2 overflow-y-auto rounded-md border bg-muted/20 p-3" data-testid="pessoa-conversa-mensagens">
              {data.mensagens.length === 0
                ? <p className="text-sm italic text-muted-foreground">{t("pessoa.whatsapp.conversa_vazia")}</p>
                : data.mensagens.map(m => (
                  <Bolha key={m.id} mensagem={m} destacar={m.anexo?.naoVisto ?? false} onRecopiado={() => void refetch()} />
                ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
