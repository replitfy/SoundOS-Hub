import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { formatDateBR, formatDateTimeBR } from "@/lib/date";
import { formatBRL } from "@/lib/store-panel";

/** Compra da loja calculada na leitura (nada disso é gravado em Instrumentos). */
export interface LojaInstrumento {
  id: string;
  item: string;
  quantidade: number;
  dataCompra: string;
  valor: number;
  pedido: string;
  ligadoPor: "email" | "phone" | "both" | "name";
  semelhanca: number | null;
}

export interface LojaInstrumentosData {
  disponivel: boolean;
  coletadoEm: string | null;
  itens: LojaInstrumento[];
}

export function useLojaInstrumentos(pessoaId: number): UseQueryResult<LojaInstrumentosData> {
  const { authHeader } = useUserSession();
  return useQuery<LojaInstrumentosData>({
    queryKey: ["/api/pessoas", pessoaId, "instrumentos-loja"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/instrumentos-loja`, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
      const body = (await r.json()) as Partial<LojaInstrumentosData> | null;
      if (!body || typeof body.disponivel !== "boolean" || !Array.isArray(body.itens)) {
        throw new Error("Resposta inesperada");
      }
      return body as LojaInstrumentosData;
    },
  });
}

/** Mesmas colunas da tabela de Instrumentos em [id].tsx. */
export function LojaInstrumentoRow({ row }: { row: LojaInstrumento }) {
  const { t, lang } = useLang();
  const locale = lang === "fr" ? "fr-FR" : "pt-BR";
  const origem = [
    `${t("pessoa.loja_origem")} · ${t("pessoa.loja_pedido")} #${row.pedido}`,
    row.quantidade > 1 ? `${row.quantidade} ${t("pessoa.loja_unidades")}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="px-5 py-3" data-testid="instrumento-loja">
      <div className="grid grid-cols-[1.5fr_120px_100px_1fr_60px] gap-3 items-center">
        <span className="text-sm font-medium text-foreground">{row.item}</span>
        <span className="text-sm text-muted-foreground">{formatDateBR(row.dataCompra)}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{formatBRL(row.valor, locale)}</span>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground truncate" title={origem}>{origem}</p>
          {row.ligadoPor === "name" && row.semelhanca !== null && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
              {t("pessoa.loja_nome_aviso").replace("{pct}", String(row.semelhanca))}
            </p>
          )}
        </div>
        <div className="flex justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-medium">
                <Store className="h-3 w-3" />
                {t("pessoa.loja_origem")}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t("pessoa.loja_origem_dica")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** Rodapé do cartão: erro explícito, aviso de pedidos não carregados ou até quando vão os dados. */
export function LojaInstrumentosStatus({ query }: { query: UseQueryResult<LojaInstrumentosData> }) {
  const { t } = useLang();

  if (query.isError) {
    return (
      <div role="alert" className="flex items-center gap-2 px-5 py-2 border-t border-border/40 text-[11px] text-destructive">
        <span>{t("pessoa.loja_erro")}</span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void query.refetch()}>
          {t("pessoa.loja_tentar")}
        </Button>
      </div>
    );
  }
  if (!query.data) return null;
  if (!query.data.disponivel) {
    return (
      <p className="px-5 py-2 border-t border-border/40 text-[11px] text-muted-foreground">
        {t("pessoa.loja_indisponivel")}
      </p>
    );
  }
  if (!query.data.coletadoEm) return null;
  return (
    <p className="px-5 py-2 border-t border-border/40 text-[11px] text-muted-foreground/70">
      {t("pessoa.loja_atualizado").replace("{data}", formatDateTimeBR(query.data.coletadoEm))}
    </p>
  );
}
