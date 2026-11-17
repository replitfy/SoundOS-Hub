import { describe, expect, it } from "vitest";
import { PRAZO_PRIMEIRO_CONTATO_HORAS, prazoDoCartao } from "./prazo-primeiro-contato";

const HORA = 60 * 60 * 1000;
const criacao = new Date("2026-11-10T22:00:00.000Z");
const emHoras = (horas: number) => new Date(criacao.getTime() + horas * HORA);

function cartao(
  contactStatus: string,
  nextTaskAt: Date | null,
  createdAt: Date = criacao,
) {
  return {
    contactStatus,
    nextTaskAt: nextTaskAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
  } as Parameters<typeof prazoDoCartao>[0];
}

describe("prazoDoCartao", () => {
  it("usa 34 horas como prazo de primeiro contato", () => {
    expect(PRAZO_PRIMEIRO_CONTATO_HORAS).toBe(34);
  });

  it("cartão novo com próxima ação igual à criação está dentro do prazo", () => {
    const prazo = prazoDoCartao(cartao("NOT_STARTED", criacao), emHoras(1));
    expect(prazo).toEqual({
      limite: emHoras(34),
      atrasado: false,
      emPrazoDePrimeiroContato: true,
    });
  });

  it("cartão novo continua dentro do prazo até o fim das 34 horas", () => {
    const prazo = prazoDoCartao(cartao("NOT_STARTED", criacao), emHoras(34));
    expect(prazo?.atrasado).toBe(false);
    expect(prazo?.emPrazoDePrimeiroContato).toBe(true);
  });

  it("cartão novo fica atrasado depois das 34 horas e mostra a data limite", () => {
    const prazo = prazoDoCartao(cartao("NOT_STARTED", criacao), emHoras(34.01));
    expect(prazo).toEqual({
      limite: emHoras(34),
      atrasado: true,
      emPrazoDePrimeiroContato: false,
    });
  });

  it("próxima ação marcada depois das 34 horas vale no lugar do prazo", () => {
    const marcada = emHoras(60);
    const dentro = prazoDoCartao(cartao("NOT_STARTED", marcada), emHoras(50));
    expect(dentro?.limite).toEqual(marcada);
    expect(dentro?.atrasado).toBe(false);

    const depois = prazoDoCartao(cartao("NOT_STARTED", marcada), emHoras(61));
    expect(depois?.limite).toEqual(marcada);
    expect(depois?.atrasado).toBe(true);
  });

  it("próxima ação marcada antes das 34 horas não encurta o prazo", () => {
    const prazo = prazoDoCartao(cartao("NOT_STARTED", emHoras(5)), emHoras(10));
    expect(prazo?.limite).toEqual(emHoras(34));
    expect(prazo?.atrasado).toBe(false);
  });

  it.each(["ATTEMPTED", "REACHED", "UNREACHABLE", "OPTED_OUT"])(
    "contato %s com data passada fica atrasado, mesmo dentro das 34 horas",
    status => {
      const prazo = prazoDoCartao(cartao(status, criacao), emHoras(1));
      expect(prazo).toEqual({
        limite: criacao,
        atrasado: true,
        emPrazoDePrimeiroContato: false,
      });
    },
  );

  it.each(["ATTEMPTED", "REACHED", "UNREACHABLE", "OPTED_OUT"])(
    "contato %s com data futura não fica atrasado e não mostra o rótulo de prazo",
    status => {
      const prazo = prazoDoCartao(cartao(status, emHoras(48)), emHoras(1));
      expect(prazo).toEqual({
        limite: emHoras(48),
        atrasado: false,
        emPrazoDePrimeiroContato: false,
      });
    },
  );

  it("cartão antigo sem contato iniciado continua vencido", () => {
    const antigo = new Date("2026-09-21T00:19:00.000Z");
    const prazo = prazoDoCartao(cartao("NOT_STARTED", antigo, antigo), emHoras(0));
    expect(prazo?.atrasado).toBe(true);
    expect(prazo?.limite).toEqual(new Date(antigo.getTime() + 34 * HORA));
  });

  it("sem próxima ação ou com data inválida não há prazo", () => {
    expect(prazoDoCartao(cartao("NOT_STARTED", null), emHoras(1))).toBeNull();
    const invalido = { ...cartao("NOT_STARTED", criacao), nextTaskAt: "não é data" };
    expect(prazoDoCartao(invalido, emHoras(1))).toBeNull();
  });
});
