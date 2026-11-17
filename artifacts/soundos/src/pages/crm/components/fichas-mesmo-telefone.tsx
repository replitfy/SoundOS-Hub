import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import type { SharedPhonePessoa } from "@workspace/api-client-react";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";

interface Props {
  fichas: SharedPhonePessoa[];
  /** Ficha do cartão aberto: é nela que as outras são unidas. */
  pessoaId: number;
}

/**
 * Quando o telefone está em mais de uma ficha ativa a conversa não é ligada sozinha. Aqui a equipe vê quem são
 * as fichas, abre a certa e, sendo administradora, une a duplicada à ficha deste cartão.
 */
export function FichasMesmoTelefone({ fichas, pessoaId }: Props) {
  const { t } = useLang();
  const { canPath, isAdmin } = useAccess();
  const podeAbrir = canPath("/pessoas");
  const cartaoEstaNaLista = fichas.some(ficha => ficha.id === pessoaId);

  return (
    <div className="space-y-2" data-testid="crm-chat-fichas">
      <p className="text-xs font-medium text-muted-foreground">{t("crm.chat.fichas.titulo")}</p>
      <ul className="space-y-2">
        {fichas.map(ficha => {
          const doCartao = ficha.id === pessoaId;
          return (
            <li key={ficha.id} className="space-y-1 rounded-md border bg-background p-2.5 text-sm" data-testid={`crm-chat-ficha-${ficha.id}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{[ficha.nome, ficha.sobrenome].filter(Boolean).join(" ")}</span>
                <span className="text-xs text-muted-foreground">{ficha.codigo}</span>
                {doCartao && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" data-testid="crm-chat-ficha-do-cartao">
                    {t("crm.chat.fichas.deste_cartao")}
                  </span>
                )}
              </div>
              <p className="break-words text-xs text-muted-foreground">
                {ficha.email || t("crm.chat.fichas.sem_email")}{ficha.celular ? ` · ${ficha.celular}` : ""}
              </p>
              {podeAbrir && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <Link
                    href={`/pessoas/${ficha.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    data-testid={`crm-chat-ficha-abrir-${ficha.id}`}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t("crm.chat.fichas.abrir")}
                  </Link>
                  {isAdmin && cartaoEstaNaLista && !doCartao && (
                    <Link
                      href={`/pessoas/${pessoaId}?fundir=${ficha.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      data-testid={`crm-chat-ficha-unir-${ficha.id}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t("crm.chat.fichas.unir")}
                    </Link>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t("crm.chat.fichas.dica")}</p>
    </div>
  );
}
