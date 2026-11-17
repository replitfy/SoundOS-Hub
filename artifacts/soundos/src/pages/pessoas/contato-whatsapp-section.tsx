import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { getGetPessoaContactQueryKey, useGetPessoaContact, useRegisterPessoaContact } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";
import { ContatoAutorizacao } from "../crm/components/contato-autorizacao";
import { AberturaModeloDialog } from "../crm/components/abertura-modelo-dialog";
import { usePessoaAbertura } from "../crm/abertura-hooks";
import { ConversaWhatsappDaFicha } from "./conversa-whatsapp-section";

/**
 * Autorização de contato por WhatsApp na ficha da pessoa. Registrar a autorização só exige a área Pessoas;
 * o modelo de abertura exige também CRM e Conversas (o servidor confere de novo ao enviar).
 */
export function ContatoWhatsappSection({ pessoaId }: { pessoaId: number }) {
  const { t } = useLang();
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const { data: estado } = useGetPessoaContact(pessoaId);
  const registrar = useRegisterPessoaContact();
  const [aberturaAberta, setAberturaAberta] = useState(false);
  const abertura = usePessoaAbertura(pessoaId, aberturaAberta);
  const podeAbrir = can("crm") && can("conversas");

  return (
    <div className="space-y-4">
      <Card className="shadow-sm border-border/50" data-testid="pessoa-contato-whatsapp">
        <CardHeader className="py-3 px-5 border-b border-border/40">
          <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
            <MessageCircle className="h-3.5 w-3.5" />
            {t("pessoa.whatsapp.titulo")}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 py-4 space-y-4">
          <ContatoAutorizacao
            estado={estado}
            pending={registrar.isPending}
            onRegister={async input => {
              await registrar.mutateAsync({ id: pessoaId, data: input });
              await queryClient.invalidateQueries({ queryKey: getGetPessoaContactQueryKey(pessoaId) });
            }}
          />
          {podeAbrir && (
            <Button size="sm" variant="outline" onClick={() => setAberturaAberta(true)} data-testid="pessoa-abertura">
              {t("crm.abertura.botao")}
            </Button>
          )}
        </CardContent>
        {podeAbrir && <AberturaModeloDialog open={aberturaAberta} onOpenChange={setAberturaAberta} controller={abertura} />}
      </Card>
      {can("conversas") && <ConversaWhatsappDaFicha pessoaId={pessoaId} />}
    </div>
  );
}
