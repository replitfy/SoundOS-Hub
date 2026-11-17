// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialOpportunity } from "@workspace/api-client-react";
import { LanguageProvider } from "@/contexts/language";

const state = vi.hoisted(() => ({ lista: [] as unknown[] }));

vi.mock("@workspace/api-client-react", async importOriginal => {
  const original = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...original,
    useListCommercialOpportunities: () => ({ data: state.lista, isLoading: false, isError: false }),
  };
});

import { CrmCard } from "./crm-card";
import { CrmList } from "./crm-list";

const AGORA = new Date("2026-11-10T15:00:00.000Z");
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();
const horasDepois = (h: number) => new Date(AGORA.getTime() + h * 3_600_000).toISOString();

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AGORA); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function cartao(parcial: Partial<CommercialOpportunity> & { id: number }): CommercialOpportunity {
  return {
    pessoaId: 1,
    person: { name: `Pessoa ${parcial.id}` },
    nucleus: "EDUCATION",
    stage: "NEW_INTEREST",
    stageEnteredAt: horasAtras(1),
    createdAt: horasAtras(1),
    contactStatus: "NOT_STARTED",
    offerInterestStatus: "UNKNOWN",
    eligibilityStatus: "UNKNOWN",
    nextTaskType: "WHATSAPP",
    nextTaskText: "Contato inicial",
    nextTaskAt: horasAtras(1),
    version: 1,
    ...parcial,
  } as CommercialOpportunity;
}

function renderLista(cartoes: CommercialOpportunity[]) {
  state.lista = cartoes;
  return render(
    <LanguageProvider>
      <CrmList filters={{}} onOpen={() => {}} />
    </LanguageProvider>,
  );
}

function renderQuadro(item: CommercialOpportunity) {
  return render(
    <LanguageProvider>
      <CrmCard item={item} onClick={() => {}} onMoveToStage={() => {}} onClaim={() => {}} isClaiming={false} />
    </LanguageProvider>,
  );
}

/** O que cada visão mostra para o prazo do mesmo cartão: texto da data e se está em vermelho. */
function prazoNoQuadro(item: CommercialOpportunity) {
  const { unmount } = renderQuadro(item);
  const el = screen.getByTestId(`crm-card-prazo-${item.id}`);
  const resultado = { texto: el.textContent ?? "", atrasado: el.className.includes("text-destructive") };
  unmount();
  return resultado;
}

function prazoNaLista(item: CommercialOpportunity) {
  const { unmount } = renderLista([item]);
  const el = screen.getByTestId(`crm-lista-acao-${item.id}`);
  const texto = el.textContent ?? "";
  const resultado = { texto, atrasado: el.getAttribute("data-atrasado") === "true", destacado: el.className.includes("text-destructive") };
  unmount();
  return resultado;
}

/** Só a parte "rótulo + data" (a lista a coloca depois do tipo e do texto da ação). */
const parteDoPrazo = (texto: string) => texto.split(" · ").at(-1)!.trim();

describe("próxima ação na lista e no quadro", () => {
  const casos: Array<{ nome: string; cartao: CommercialOpportunity; atrasado: boolean; rotulo: "Atrasado" | "Prazo" | null }> = [
    {
      nome: "cartão novo, contato não iniciado, data da ação igual à criação: dentro das 34 horas",
      cartao: cartao({ id: 1, createdAt: horasAtras(1), nextTaskAt: horasAtras(1) }),
      atrasado: false,
      rotulo: "Prazo",
    },
    {
      nome: "contato não iniciado e já passaram as 34 horas: atrasado",
      cartao: cartao({ id: 2, createdAt: horasAtras(40), nextTaskAt: horasAtras(40) }),
      atrasado: true,
      rotulo: "Atrasado",
    },
    {
      nome: "ação marcada de propósito para antes do fim das 34 horas: as duas visões seguem a mesma regra",
      cartao: cartao({ id: 3, createdAt: horasAtras(20), nextTaskAt: horasAtras(10) }),
      atrasado: false,
      rotulo: "Prazo",
    },
    {
      nome: "contato já iniciado com data passada: atrasado",
      cartao: cartao({ id: 4, contactStatus: "REACHED", createdAt: horasAtras(2), nextTaskAt: horasAtras(1) }),
      atrasado: true,
      rotulo: "Atrasado",
    },
    {
      nome: "contato já iniciado com data futura: neutro e sem rótulo",
      cartao: cartao({ id: 5, contactStatus: "ATTEMPTED", createdAt: horasAtras(50), nextTaskAt: horasDepois(3) }),
      atrasado: false,
      rotulo: null,
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      const quadro = prazoNoQuadro(caso.cartao);
      const lista = prazoNaLista(caso.cartao);

      expect(lista.atrasado).toBe(caso.atrasado);
      expect(lista.destacado).toBe(caso.atrasado);
      expect(quadro.atrasado).toBe(caso.atrasado);
      // A mesma data e o mesmo rótulo nas duas visões.
      expect(parteDoPrazo(lista.texto)).toBe(parteDoPrazo(quadro.texto));
      if (caso.rotulo) expect(parteDoPrazo(lista.texto).startsWith(caso.rotulo)).toBe(true);
      else expect(parteDoPrazo(lista.texto)).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
    });
  }

  it("a lista mostra o tipo e o texto da ação junto com o prazo, e traço quando não há ação", () => {
    renderLista([
      cartao({ id: 10, contactStatus: "REACHED", nextTaskType: "CALL", nextTaskText: "Ligar para confirmar", nextTaskAt: horasDepois(5) }),
      cartao({ id: 11, nextTaskType: "NONE", nextTaskText: null, nextTaskAt: null }),
    ]);
    expect(screen.getByTestId("crm-lista-acao-10").textContent).toMatch(/^Ligação · Ligar para confirmar · \d{2}\/\d{2}\/\d{4}/);
    expect(screen.getByTestId("crm-lista-acao-11").textContent).toBe("—");
  });
});
