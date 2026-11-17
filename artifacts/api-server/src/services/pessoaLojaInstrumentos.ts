/**
 * Compras da loja (Wix) que aparecem na ficha de uma pessoa, em Histórico > Instrumentos.
 *
 * Nada é gravado em `pessoa_instrumentos`: as linhas são calculadas na leitura a partir do
 * último retrato do Painel Loja (nunca consulta a Wix) e ligadas à ficha pela mesma regra da
 * tela de Pedidos. Só vendas confirmadas contam como compra; pedidos aguardando pagamento,
 * cancelados ou reembolsados ficam de fora.
 */
import { saoPauloDate } from "../lib/saoPauloTime";
import { isConfirmedSale } from "./storePanel";
import { getStorePanelSnapshot } from "./storePanelSnapshot";
import { findOrdersOfPessoa, type OrderLinkMode } from "./storeOrderPessoa";

export interface LojaInstrumento {
  /** Estável entre leituras: pedido + posição do item no pedido. */
  id: string;
  item: string;
  quantidade: number;
  /** Dia da compra em São Paulo (AAAA-MM-DD). */
  dataCompra: string;
  /** Valor da linha do pedido em reais, já com desconto do item e sem frete. */
  valor: number;
  pedido: string;
  ligadoPor: OrderLinkMode;
  /** Semelhança de nome em %, só quando `ligadoPor` é "name". */
  semelhanca: number | null;
}

export interface LojaInstrumentosResult {
  /** Falso quando o Painel Loja ainda não carregou os pedidos nenhuma vez. */
  disponivel: boolean;
  /** Quando o retrato dos pedidos foi coletado (ISO). */
  coletadoEm: string | null;
  itens: LojaInstrumento[];
}

function dayKey(iso: string): string {
  const { year, month, day } = saoPauloDate(new Date(iso));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export async function listLojaInstrumentos(pessoaId: number): Promise<LojaInstrumentosResult> {
  const state = await getStorePanelSnapshot();
  if (!state.data) return { disponivel: false, coletadoEm: null, itens: [] };

  const confirmed = state.data.orders.filter(isConfirmedSale);
  const linked = await findOrdersOfPessoa(pessoaId, confirmed);
  const newestFirst = [...linked].sort(
    (a, b) => b.order.createdAt.localeCompare(a.order.createdAt) || a.order.id.localeCompare(b.order.id),
  );

  const itens = newestFirst.flatMap(({ order, mode, similarity }) =>
    order.items.map((item, index) => ({
      id: `${order.id}:${index}`,
      item: item.name,
      quantidade: item.quantity,
      dataCompra: dayKey(order.createdAt),
      valor: item.value,
      pedido: order.number,
      ligadoPor: mode,
      semelhanca: mode === "name" ? similarity : null,
    })),
  );

  return { disponivel: true, coletadoEm: state.collectedAt, itens };
}
