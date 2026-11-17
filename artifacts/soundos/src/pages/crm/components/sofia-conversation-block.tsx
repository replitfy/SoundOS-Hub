import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { useLang } from "@/contexts/language";
import { sofiaConversationHref, type SofiaConversationMeta } from "@/lib/formalizacao";

interface SofiaConversationBlockProps {
  conversation: SofiaConversationMeta;
  eventId: number | string;
  pessoaId: number | null | undefined;
  /** Quem não tem a tela de conversa no perfil não vê o botão. */
  canOpenConversation: boolean;
}

/** "Conversa com a Sofia": o que a pessoa escreveu, o que a ficha já sabe e o caminho para a conversa completa. */
export function SofiaConversationBlock({ conversation, eventId, pessoaId, canOpenConversation }: SofiaConversationBlockProps) {
  const { t } = useLang();
  return (
    <div className="mt-2 rounded-md border border-primary/20 bg-background/70 p-2.5 space-y-2" data-testid={`sofia-conversation-${eventId}`}>
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-primary">{t("crm.sofia_conversation.title" as any)}</span>
      {conversation.mensagens.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">{t("crm.sofia_conversation.messages" as any)}</p>
          <ul className="space-y-1">
            {conversation.mensagens.map((mensagem, index) => (
              <li key={index} className="text-xs border-l-2 border-primary/30 pl-2 break-words">{mensagem}</li>
            ))}
          </ul>
        </div>
      )}
      {conversation.ficha.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">{t("crm.sofia_conversation.ficha" as any)}</p>
          <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-2 gap-y-1 text-[11px]">
            {conversation.ficha.map(({ chave, valor }) => (
              <div key={chave} className="contents">
                <dt className="text-muted-foreground">{t(`crm.sofia_conversation.field.${chave}` as any)}</dt>
                <dd className="break-words">{valor}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {conversation.conversationId !== null && canOpenConversation && (
        <Link
          href={sofiaConversationHref(pessoaId, conversation.conversationId)}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          data-testid={`sofia-conversation-open-${eventId}`}
        >
          <ExternalLink className="h-3 w-3" />
          {t("crm.sofia_conversation.open" as any)}
        </Link>
      )}
    </div>
  );
}
