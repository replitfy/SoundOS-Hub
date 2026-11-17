import { describe, expect, it } from "vitest";
import { OpportunityRuleError } from "./commercialOpportunities";
import { exigirHumano, linkOpcional, textoObrigatorio } from "./crmAtendimento";
import { derivarEstadoDeContato } from "./contatoAutorizacao";
import { telefoneDeEnvio } from "./conversaWhatsappDaPessoa";
import { renderizarModelo } from "./whatsappModeloAbertura";

function codigoDe(fn: () => unknown): string | undefined {
  try { fn(); } catch (erro) { return erro instanceof OpportunityRuleError ? erro.code : `outro:${String(erro)}`; }
  return undefined;
}

describe("autorização de contato: estado derivado dos registros", () => {
  it("sem registros: nem autorizado nem 'não quer receber'", () => {
    expect(derivarEstadoDeContato([])).toEqual({ autorizado: false, naoQuerReceber: false });
  });

  it("'não quer receber' sempre vence a autorização, em qualquer ordem", () => {
    expect(derivarEstadoDeContato([{ kind: "AUTORIZOU" }, { kind: "NAO_QUER_RECEBER" }])).toEqual({ autorizado: true, naoQuerReceber: true });
    expect(derivarEstadoDeContato([{ kind: "NAO_QUER_RECEBER" }, { kind: "AUTORIZOU" }])).toEqual({ autorizado: true, naoQuerReceber: true });
  });

  it("desfazer o 'não quer receber' libera de novo, e um novo pedido volta a bloquear", () => {
    expect(derivarEstadoDeContato([{ kind: "AUTORIZOU" }, { kind: "NAO_QUER_RECEBER" }, { kind: "NAO_QUER_RECEBER_DESFEITO" }]))
      .toEqual({ autorizado: true, naoQuerReceber: false });
    expect(derivarEstadoDeContato([{ kind: "NAO_QUER_RECEBER" }, { kind: "NAO_QUER_RECEBER_DESFEITO" }, { kind: "NAO_QUER_RECEBER" }]).naoQuerReceber).toBe(true);
  });

  it("desfazer não cria autorização que não existia", () => {
    expect(derivarEstadoDeContato([{ kind: "NAO_QUER_RECEBER" }, { kind: "NAO_QUER_RECEBER_DESFEITO" }]))
      .toEqual({ autorizado: false, naoQuerReceber: false });
  });
});

describe("telefone de envio do WhatsApp", () => {
  it("celular brasileiro vira 55 + DDD + número, só dígitos", () => {
    const a = telefoneDeEnvio("(11) 98765-4321");
    expect(a).toMatchObject({ ok: true, destino: "5511987654321" });
    expect(telefoneDeEnvio("+55 11 98765-4321")).toMatchObject({ ok: true, destino: "5511987654321" });
  });

  it("número de outro país não recebe", () => {
    expect(telefoneDeEnvio("+351 912 345 678")).toEqual({ ok: false, motivo: "telefone_estrangeiro" });
    expect(telefoneDeEnvio("+1 415 555 2671")).toEqual({ ok: false, motivo: "telefone_estrangeiro" });
  });

  it("ficha sem celular (ausente, vazio ou só espaços) é 'sem telefone', não 'inválido'", () => {
    expect(telefoneDeEnvio(null)).toEqual({ ok: false, motivo: "sem_telefone" });
    expect(telefoneDeEnvio(undefined)).toEqual({ ok: false, motivo: "sem_telefone" });
    expect(telefoneDeEnvio("")).toEqual({ ok: false, motivo: "sem_telefone" });
    expect(telefoneDeEnvio("   ")).toEqual({ ok: false, motivo: "sem_telefone" });
  });

  it("preenchido e malformado continua inválido, nunca adivinhado", () => {
    expect(telefoneDeEnvio("1234")).toEqual({ ok: false, motivo: "telefone_invalido" });
    expect(telefoneDeEnvio("abc")).toEqual({ ok: false, motivo: "telefone_invalido" });
    expect(telefoneDeEnvio("---")).toEqual({ ok: false, motivo: "telefone_invalido" });
  });
});
