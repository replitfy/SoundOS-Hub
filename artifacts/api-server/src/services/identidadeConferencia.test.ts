import { describe, expect, it } from "vitest";
import {
  coincidenciasDaFicha, impressaoDaConferencia, montarNotaConferencia, montarResumoDoCartao, notaRegistraCelularNaoGravado, textoDaProximaAcao,
} from "./identidadeConferencia";

const ids = { cpf: null, email: "maria@example.test", phone: "11987654321" };

describe("conferência de cadastro vinda de formulário público", () => {
  it("a impressão do caso ignora acento, caixa e espaços do nome, mas muda com qualquer identificador", () => {
    const base = impressaoDaConferencia("Maria Silva", ids);
    expect(impressaoDaConferencia("  maria   SILVA ", ids)).toBe(base);
    expect(impressaoDaConferencia("María Silva", ids)).toBe(base);
    expect(impressaoDaConferencia("Maria Souza", ids)).not.toBe(base);
    expect(impressaoDaConferencia("Maria Silva", { ...ids, phone: "11911112222" })).not.toBe(base);
    expect(impressaoDaConferencia("Maria Silva", { ...ids, cpf: "52998224725" })).not.toBe(base);
  });

  it("diz por que cada ficha candidata entrou na lista", () => {
    const detalhes = { cpfIds: [1], emailIds: [1, 2], phoneIds: [2, 3] };
    expect(coincidenciasDaFicha(1, detalhes)).toEqual(["mesmo CPF", "mesmo e-mail"]);
    expect(coincidenciasDaFicha(2, detalhes)).toEqual(["mesmo e-mail", "mesmo celular"]);
    expect(coincidenciasDaFicha(3, detalhes)).toEqual(["mesmo celular"]);
    expect(coincidenciasDaFicha(9, detalhes)).toEqual([]);
  });

  it("a nota da ficha em conferência lista as fichas, o que não foi gravado e o próximo passo", () => {
    const nota = montarNotaConferencia({
      origem: "formulário de interesse geral (Água)",
      motivo: "Contatos ambíguos ou divergentes. Peça conferência à equipe.".replace(/\s*Peça conferência à equipe\.?$/, ""),
      desfecho: "ficha_em_conferencia",
      fichas: [
        { codigo: "PS-100001", nome: "Maria Silva", arquivada: false, coincide: ["mesmo e-mail"] },
        { codigo: "PS-100002", nome: "João Silva", arquivada: true, coincide: ["mesmo celular"] },
      ],
      naoGravados: [{ rotulo: "e-mail", valor: "maria@example.test" }, { rotulo: "celular", valor: "(11) 98765-4321" }],
    });
    expect(nota).toContain("Conferência de cadastro — formulário de interesse geral (Água).");
    expect(nota).toContain("Motivo: Contatos ambíguos ou divergentes.");
    expect(nota).toContain("- PS-100001 — Maria Silva (mesmo e-mail)");
    expect(nota).toContain("- PS-100002 — João Silva (mesmo celular, arquivada)");
    expect(nota).toContain("Informado e não gravado: e-mail maria@example.test; celular (11) 98765-4321.");
    expect(nota).toContain("mescle as fichas");
    expect(nota).not.toContain("..");
  });

  it("a nota da ficha certa explica que só o celular ficou de fora", () => {
    const nota = montarNotaConferencia({
      origem: "formulário de interesse do evento \"Água\"",
      motivo: "Contatos ambíguos ou divergentes.",
      desfecho: "ficha_existente",
      fichas: [{ codigo: "PS-100002", nome: "João Silva", arquivada: false, coincide: ["mesmo celular"] }],
      naoGravados: [{ rotulo: "celular", valor: "11987654321" }],
    });
    expect(nota).toContain("O celular informado pertence a outra ficha e não foi gravado aqui.");
    expect(nota).toContain("Outras fichas relacionadas:");
    expect(nota).not.toContain("mescle as fichas");
  });

  it("o resumo do cartão cita os códigos e manda olhar as notas; a tarefa pede a conferência", () => {
    const resumo = montarResumoDoCartao("Contatos ambíguos ou divergentes.", [
      { codigo: "PS-100001", nome: "A", arquivada: false, coincide: [] },
      { codigo: "PS-100002", nome: "B", arquivada: false, coincide: [] },
    ]);
    expect(resumo).toBe("Cadastro a conferir: Contatos ambíguos ou divergentes. Fichas relacionadas: PS-100001, PS-100002. Detalhes nas notas da ficha.");
    expect(textoDaProximaAcao({ resumo })).toMatch(/^Conferir o cadastro/);
    expect(textoDaProximaAcao(null)).toBe("Retornar ao interesse recebido pelo formulário");
    expect(textoDaProximaAcao()).toBe("Retornar ao interesse recebido pelo formulário");
  });
  it("reconhece na nota se o celular informado ficou de fora, sem confundir com outros dados", () => {
    const nota = (naoGravados: Array<{ rotulo: string; valor: string }>, desfecho: "ficha_em_conferencia" | "ficha_existente" = "ficha_em_conferencia") =>
      montarNotaConferencia({ origem: "formulário", motivo: "Contatos ambíguos ou divergentes.", desfecho, fichas: [], naoGravados });

    expect(notaRegistraCelularNaoGravado(nota([{ rotulo: "celular", valor: "11987654321" }], "ficha_existente"))).toBe(true);
    expect(notaRegistraCelularNaoGravado(nota([{ rotulo: "e-mail", valor: "maria@example.test" }, { rotulo: "celular", valor: "(11) 98765-4321" }]))).toBe(true);
    expect(notaRegistraCelularNaoGravado(nota([{ rotulo: "e-mail", valor: "maria@example.test" }]))).toBe(false);
    // O valor de outro dado que menciona "celular" não conta.
    expect(notaRegistraCelularNaoGravado(nota([{ rotulo: "e-mail", valor: "celular 11@example.test" }]))).toBe(false);
    expect(notaRegistraCelularNaoGravado(nota([]))).toBe(false);
    expect(notaRegistraCelularNaoGravado(null)).toBe(false);
    expect(notaRegistraCelularNaoGravado("")).toBe(false);
  });
});
