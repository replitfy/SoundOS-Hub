import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HabllaErro, credenciaisHabllaConfiguradas, enviarMensagemInstagram, enviarMensagemWhatsapp, limparCacheHablla, verificarCredenciaisHablla,
} from "./habllaClient";

const WS = "ws1";
const INSTA = "c-insta";
const ZAP = "c-zap";
const env = {
  HABLLA_API_TOKEN: "tok",
  HABLLA_WORKSPACE_ID: WS,
  HABLLA_INSTAGRAM_CONNECTION_ID: INSTA,
  HABLLA_WHATSAPP_CONNECTION_ID: ZAP,
  HABLLA_API_URL: "https://hablla.test",
} as NodeJS.ProcessEnv;

function resposta(status: number, corpo: unknown) {
  return { status, text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)) } as Response;
}

// Corpo real de uma conexão traz credenciais e webhooks: os testes provam que nada disso vaza.
function conexao(id: string, scope: string, extra: Record<string, unknown> = {}) {
  return {
    id, workspace: WS, name: `Conta ${id}`, scope, status: "active",
    credential: "credencial-secreta", webhooks: [{ url: "https://x", token: "token-do-webhook" }], ...extra,
  };
}

type Rota = (init?: RequestInit) => Response;
function api(rotas: Record<string, Rota | Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const caminho = url.replace("https://hablla.test", "");
    const chave = `${init?.method ?? "GET"} ${caminho}`;
    const rota = rotas[chave];
    if (!rota) throw new Error(`chamada inesperada: ${chave}`);
    return typeof rota === "function" ? rota(init) : rota;
  });
  return { fn, fetch: fn as unknown as typeof fetch, chamadas: () => fn.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u).replace("https://hablla.test", "")}`) };
}

const ROTA_CONEXAO_INSTA = `GET /v1/workspace/${WS}/connection/${INSTA}`;
const ROTA_CONEXAO_ZAP = `GET /v1/workspace/${WS}/connection/${ZAP}`;
const ROTA_ENVIO_ZAP = `POST /v1/workspace/${WS}/meta/connection/${ZAP}/whatsapp-messaging/messages/send`;
const ROTA_ENVIO_INSTA = `POST /v1/workspace/${WS}/meta/connection/${INSTA}/instagram-messaging/messages/send`;

describe("cliente do Hablla (Astenir)", () => {
  beforeEach(() => limparCacheHablla());

  describe("credenciais", () => {
    it("sem token ou workspace falha explicitamente, sem chamar a rede", async () => {
      const fetchMock = vi.fn();
      await expect(enviarMensagemInstagram({ para: "1", texto: "oi" }, { env: {} as NodeJS.ProcessEnv, fetch: fetchMock as unknown as typeof fetch }))
        .rejects.toMatchObject({ codigo: "sem_credenciais" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sem o ID da conexão de Instagram não adivinha: falha sem chamar a rede", async () => {
      const fetchMock = vi.fn();
      const semConexao = { ...env, HABLLA_INSTAGRAM_CONNECTION_ID: "" } as NodeJS.ProcessEnv;
      await expect(enviarMensagemInstagram({ para: "1", texto: "oi" }, { env: semConexao, fetch: fetchMock as unknown as typeof fetch }))
        .rejects.toMatchObject({ codigo: "sem_credenciais", message: expect.stringContaining("HABLLA_INSTAGRAM_CONNECTION_ID") });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("credenciaisHabllaConfiguradas exige token, workspace e a conexão do canal", () => {
      expect(credenciaisHabllaConfiguradas("instagram", env)).toBe(true);
      expect(credenciaisHabllaConfiguradas("whatsapp", env)).toBe(true);
      expect(credenciaisHabllaConfiguradas("instagram", { ...env, HABLLA_INSTAGRAM_CONNECTION_ID: undefined } as NodeJS.ProcessEnv)).toBe(false);
      expect(credenciaisHabllaConfiguradas("instagram", { ...env, HABLLA_WORKSPACE_ID: undefined } as NodeJS.ProcessEnv)).toBe(false);
      expect(credenciaisHabllaConfiguradas("instagram", { ...env, HABLLA_API_TOKEN: undefined } as NodeJS.ProcessEnv)).toBe(false);
    });
  });

  describe("envio pelo WhatsApp", () => {
    it("confere a conexão e envia JSON com type, phone e body (não text); 202 devolve só o id da fila", async () => {
      const { fn, fetch, chamadas } = api({
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
        [ROTA_ENVIO_ZAP]: resposta(202, { task_id: "fila-wa-1", message: "queued", date_time: "2026-10-31T10:00:00Z" }),
      });
      const resultado = await enviarMensagemWhatsapp({ para: "5511999990001", texto: "Olá!" }, { env, fetch });
      expect(resultado).toEqual({ externoId: "fila-wa-1" });
      expect(chamadas()).toEqual([ROTA_CONEXAO_ZAP, ROTA_ENVIO_ZAP]);
      const envio = fn.mock.calls.find(([, init]) => init?.method === "POST")!;
      expect(JSON.parse(String(envio[1]!.body))).toEqual({ type: "text", phone: "5511999990001", body: "Olá!" });
      expect((envio[1]!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    });

    it("não envia se a conexão configurada não é de WhatsApp", async () => {
      const { chamadas, fetch } = api({ [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "INSTAGRAM")) });
      await expect(enviarMensagemWhatsapp({ para: "5511999990001", texto: "a" }, { env, fetch })).rejects.toMatchObject({ codigo: "conexao_tipo_errado" });
      expect(chamadas()).toEqual([ROTA_CONEXAO_ZAP]);
    });

    it("sem o ID da conexão de WhatsApp falha sem chamar a rede", async () => {
      const fetchMock = vi.fn();
      const semConexao = { ...env, HABLLA_WHATSAPP_CONNECTION_ID: "" } as NodeJS.ProcessEnv;
      await expect(enviarMensagemWhatsapp({ para: "5511999990001", texto: "a" }, { env: semConexao, fetch: fetchMock as unknown as typeof fetch }))
        .rejects.toMatchObject({ codigo: "sem_credenciais", message: expect.stringContaining("HABLLA_WHATSAPP_CONNECTION_ID") });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("janela de sessão fechada (código 126 do catálogo da Astenir) vira janela_24h, sem repetir nem trocar por modelo", async () => {
      const { chamadas, fetch } = api({
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
        [ROTA_ENVIO_ZAP]: resposta(400, { error_code: 126, error_data: {}, message: "The service session is closed. Send a template to re-engage the customer" }),
      });
      const erro = await enviarMensagemWhatsapp({ para: "5511999990001", texto: "a" }, { env, fetch }).catch(e => e);
      expect(erro).toMatchObject({ codigo: "janela_24h", status: 400 });
      expect(chamadas().filter(c => c === ROTA_ENVIO_ZAP)).toHaveLength(1);
      expect(chamadas().every(c => !c.includes("template"))).toBe(true);
    });

    it("403 no envio é falta de permissão do usuário de sistema; erro genérico não é janela", async () => {
      const semPermissao = api({
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
        [ROTA_ENVIO_ZAP]: resposta(403, { message: "forbidden" }),
      });
      await expect(enviarMensagemWhatsapp({ para: "5511999990001", texto: "a" }, { env, fetch: semPermissao.fetch }))
        .rejects.toMatchObject({ codigo: "sem_permissao", status: 403 });

      limparCacheHablla();
      const generico = api({
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
        [ROTA_ENVIO_ZAP]: resposta(500, "boom"),
      });
      await expect(enviarMensagemWhatsapp({ para: "5511999990001", texto: "a" }, { env, fetch: generico.fetch }))
        .rejects.toMatchObject({ codigo: "http", status: 500 });
      expect(generico.chamadas().filter(c => c === ROTA_ENVIO_ZAP)).toHaveLength(1);
    });
  });

  describe("envio pelo Instagram", () => {
    it("confere a conexão e envia pela rota de DM de Instagram da Astenir, com Bearer e corpo JSON", async () => {
      const { fn, fetch, chamadas } = api({
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_ENVIO_INSTA]: resposta(202, { task_id: "tarefa-9", message: "queued", date_time: "2026-10-31T12:00:00Z" }),
      });
      const r = await enviarMensagemInstagram({ para: "IG1", texto: "Olá" }, { env, fetch });
      // 202 = aceito na fila; o ID devolvido é o da fila, não da mensagem entregue.
      expect(r).toEqual({ externoId: "tarefa-9" });
      expect(chamadas()).toEqual([ROTA_CONEXAO_INSTA, ROTA_ENVIO_INSTA]);
      const [, init] = fn.mock.calls[1]!;
      expect(JSON.parse(String(init?.body))).toEqual({ instagram_id: "IG1", text: "Olá" });
      const cabecalhos = init?.headers as Record<string, string>;
      expect(cabecalhos.authorization).toBe("Bearer tok");
      expect(cabecalhos["content-type"]).toBe("application/json");
    });

    it("sem HABLLA_API_URL usa a API da Astenir", async () => {
      const urls: string[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        urls.push(url);
        return url.endsWith(`/connection/${INSTA}`) ? resposta(200, conexao(INSTA, "INSTAGRAM")) : resposta(202, { task_id: "t" });
      });
      const semUrl = { ...env, HABLLA_API_URL: undefined } as NodeJS.ProcessEnv;
      await enviarMensagemInstagram({ para: "1", texto: "a" }, { env: semUrl, fetch: fetchMock as unknown as typeof fetch });
      expect(urls[0]).toBe(`https://api.astenir.com/v1/workspace/${WS}/connection/${INSTA}`);
      expect(urls[1]).toBe(`https://api.astenir.com/v1/workspace/${WS}/meta/connection/${INSTA}/instagram-messaging/messages/send`);
    });

    it("a conferência da conexão fica em cache: o segundo envio faz uma chamada só", async () => {
      const { chamadas, fetch } = api({
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_ENVIO_INSTA]: resposta(202, { task_id: "t" }),
      });
      await enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch });
      await enviarMensagemInstagram({ para: "1", texto: "b" }, { env, fetch });
      expect(chamadas()).toEqual([ROTA_CONEXAO_INSTA, ROTA_ENVIO_INSTA, ROTA_ENVIO_INSTA]);
    });

    it.each([
      ["conexão inexistente neste workspace", resposta(404, { error_code: 31, message: "Connection not found" }), "conexao_nao_encontrada"],
      ["conexão de outro workspace", resposta(200, conexao(INSTA, "INSTAGRAM", { workspace: "outro-ws" })), "conexao_nao_encontrada"],
      ["conexão de WhatsApp no lugar do Instagram", resposta(200, conexao(INSTA, "WHATSAPP_MESSAGING")), "conexao_tipo_errado"],
      ["conexão de Facebook no lugar do Instagram", resposta(200, conexao(INSTA, "FACEBOOK_PAGE")), "conexao_tipo_errado"],
      ["conexão desativada", resposta(200, conexao(INSTA, "INSTAGRAM", { status: "inactive" })), "conexao_inativa"],
    ])("%s: rejeita sem enviar e sem guardar a falha em cache", async (_nome, resp, codigo) => {
      const { chamadas, fetch } = api({ [ROTA_CONEXAO_INSTA]: resp });
      await expect(enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch })).rejects.toMatchObject({ codigo });
      expect(chamadas()).toEqual([ROTA_CONEXAO_INSTA]);
      // Falha não vira cache: a próxima tentativa confere de novo.
      await expect(enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch })).rejects.toMatchObject({ codigo });
      expect(chamadas()).toEqual([ROTA_CONEXAO_INSTA, ROTA_CONEXAO_INSTA]);
    });

    it("token recusado (401) vira erro claro de autorização, sem repetir", async () => {
      const { chamadas, fetch } = api({ [ROTA_CONEXAO_INSTA]: resposta(401, { error_code: 17, message: "Unauthorized" }) });
      const erro = await enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch }).catch(e => e);
      expect(erro).toBeInstanceOf(HabllaErro);
      expect(erro).toMatchObject({ codigo: "nao_autorizado", status: 401 });
      expect(erro.message).toContain("outro workspace");
      expect(chamadas()).toHaveLength(1);
    });

    it("403 no envio é falta de permissão do usuário de sistema, não token inválido", async () => {
      const { chamadas, fetch } = api({
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_ENVIO_INSTA]: resposta(403, { message: "forbidden" }),
      });
      await expect(enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch }))
        .rejects.toMatchObject({ codigo: "sem_permissao", status: 403 });
      expect(chamadas().filter(c => c === ROTA_ENVIO_INSTA)).toHaveLength(1);
    });

    it("janela de 24h e outros erros HTTP são distinguidos e o envio nunca é repetido", async () => {
      const janela = api({
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_ENVIO_INSTA]: resposta(400, { error_code: 9, message: "Message sent outside of allowed window", error_data: "24 hours" }),
      });
      const erroJanela = await enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch: janela.fetch }).catch(e => e);
      expect(erroJanela).toMatchObject({ codigo: "janela_24h", status: 400 });
      expect(erroJanela.message).toContain("outside of allowed window");
      expect(janela.chamadas().filter(c => c === ROTA_ENVIO_INSTA)).toHaveLength(1);

      limparCacheHablla();
      const generico = api({
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_ENVIO_INSTA]: resposta(500, "boom"),
      });
      await expect(enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch: generico.fetch }))
        .rejects.toMatchObject({ codigo: "http", status: 500 });
      expect(generico.chamadas().filter(c => c === ROTA_ENVIO_INSTA)).toHaveLength(1);
    });

    it("falha de rede no envio vira HabllaErro e não repete", async () => {
      let envios = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith(`/connection/${INSTA}`)) return resposta(200, conexao(INSTA, "INSTAGRAM"));
        envios += 1;
        throw new Error("ECONNRESET");
      });
      const erro = await enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch: fetchMock as unknown as typeof fetch }).catch(e => e);
      expect(erro).toBeInstanceOf(HabllaErro);
      expect(erro.codigo).toBe("rede");
      expect(envios).toBe(1);
    });
  });

  describe("verificação de credenciais", () => {
    const ROTA_EU = `GET /v1/workspace/${WS}/me`;
    const ROTA_LISTA = `GET /v1/workspace/${WS}/connection`;
    const ROTA_CONEXAO_ZAP = `GET /v1/workspace/${WS}/connection/${ZAP}`;
    const lista = { page: 1, results: [conexao("a", "FACEBOOK_PAGE"), conexao(INSTA, "INSTAGRAM"), conexao("b", "INSTAGRAM"), conexao(ZAP, "WHATSAPP_MESSAGING")] };

    it("tudo certo: token aceito, conexões confirmadas e nenhum segredo na resposta", async () => {
      const { fetch } = api({
        [ROTA_EU]: resposta(200, { id: "u", workspace: WS, role: "user" }),
        [ROTA_LISTA]: resposta(200, lista),
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
      });
      const v = await verificarCredenciaisHablla({ env, fetch });
      expect(v).toEqual({
        token: "ok",
        conexoes: { instagram: { estado: "ok", nome: `Conta ${INSTA}` }, whatsapp: { estado: "ok", nome: `Conta ${ZAP}` } },
        conexoesNoWorkspace: [
          { nome: "Conta a", tipo: "FACEBOOK_PAGE" }, { nome: `Conta ${INSTA}`, tipo: "INSTAGRAM" },
          { nome: "Conta b", tipo: "INSTAGRAM" }, { nome: `Conta ${ZAP}`, tipo: "WHATSAPP_MESSAGING" },
        ],
      });
      const texto = JSON.stringify(v);
      for (const segredo of ["tok", "credencial-secreta", "token-do-webhook", "https://x", INSTA, ZAP]) {
        expect(texto).not.toContain(`"${segredo}"`);
      }
      expect(texto).not.toContain("credencial-secreta");
      expect(texto).not.toContain("token-do-webhook");
    });

    it("marca a conexão de WhatsApp como número de teste só quando o nome do negócio é o do número de teste da Meta", async () => {
      const verificar = async (extra: Record<string, unknown>) => {
        const { fetch } = api({
          [ROTA_EU]: resposta(200, { workspace: WS }),
          [ROTA_LISTA]: resposta(200, lista),
          [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
          [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING", extra)),
        });
        return (await verificarCredenciaisHablla({ env, fetch })).conexoes;
      };

      const teste = await verificar({ additional_info: { whatsapp_business_name: "Test Number" } });
      expect(teste.whatsapp).toMatchObject({ estado: "ok", numeroDeTeste: true });
      expect(teste.instagram).not.toHaveProperty("numeroDeTeste");

      expect((await verificar({ additional_info: { whatsapp_business_name: " test number " } })).whatsapp.numeroDeTeste).toBe(true);
      expect((await verificar({ additional_info: { whatsapp_business_name: "Soundfulness" } })).whatsapp.numeroDeTeste).toBe(false);
      // Sem o nome do negócio não se sabe: o campo fica ausente, e a tela não afirma nada.
      expect((await verificar({})).whatsapp).not.toHaveProperty("numeroDeTeste");
      expect((await verificar({ additional_info: {} })).whatsapp).not.toHaveProperty("numeroDeTeste");
    });

    it("não usa o cache: uma conexão desativada depois de conferida aparece como inativa", async () => {
      const ok = api({
        [ROTA_EU]: resposta(200, { workspace: WS }),
        [ROTA_LISTA]: resposta(200, lista),
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
        [ROTA_ENVIO_INSTA]: resposta(202, { task_id: "t" }),
      });
      await enviarMensagemInstagram({ para: "1", texto: "a" }, { env, fetch: ok.fetch });
      const depois = api({
        [ROTA_EU]: resposta(200, { workspace: WS }),
        [ROTA_LISTA]: resposta(200, lista),
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM", { status: "inactive" })),
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
      });
      const v = await verificarCredenciaisHablla({ env, fetch: depois.fetch });
      expect(v.conexoes.instagram.estado).toBe("inativa");
    });

    it("token recusado: não consulta mais nada e marca as conexões como não verificadas", async () => {
      const { fetch, chamadas } = api({ [ROTA_EU]: resposta(401, { error_code: 17, message: "Unauthorized" }) });
      const v = await verificarCredenciaisHablla({ env, fetch });
      expect(v.token).toBe("recusado");
      expect(v.conexoes.instagram.estado).toBe("nao_verificada");
      expect(v.conexoes.whatsapp.estado).toBe("nao_verificada");
      expect(v.conexoesNoWorkspace).toEqual([]);
      expect(chamadas()).toEqual([ROTA_EU]);
    });

    it("o workspace do token difere do configurado", async () => {
      const { fetch } = api({ [ROTA_EU]: resposta(200, { workspace: "outro" }) });
      expect((await verificarCredenciaisHablla({ env, fetch })).token).toBe("workspace_diferente");
    });

    it("sem credenciais: nenhuma chamada de rede", async () => {
      const fetchMock = vi.fn();
      const v = await verificarCredenciaisHablla({
        env: { HABLLA_INSTAGRAM_CONNECTION_ID: INSTA } as NodeJS.ProcessEnv,
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect(v.token).toBe("sem_credenciais");
      expect(v.conexoes).toEqual({ instagram: { estado: "nao_verificada", nome: null }, whatsapp: { estado: "nao_configurada", nome: null } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a API fora do ar não vira acusação de token errado", async () => {
      const fetchMock = vi.fn(async () => { throw new Error("ECONNRESET"); });
      expect((await verificarCredenciaisHablla({ env, fetch: fetchMock as unknown as typeof fetch })).token).toBe("indisponivel");
      const erro500 = api({ [ROTA_EU]: resposta(500, "boom") });
      expect((await verificarCredenciaisHablla({ env, fetch: erro500.fetch })).token).toBe("indisponivel");
    });

    it("conexão inexistente, de tipo errado ou não configurada é apontada por canal", async () => {
      const { fetch } = api({
        [ROTA_EU]: resposta(200, { workspace: WS }),
        [ROTA_LISTA]: resposta(200, lista),
        [ROTA_CONEXAO_INSTA]: resposta(404, { message: "Connection not found" }),
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "INSTAGRAM")),
      });
      const v = await verificarCredenciaisHablla({ env, fetch });
      expect(v.token).toBe("ok");
      expect(v.conexoes.instagram).toEqual({ estado: "nao_encontrada", nome: null });
      expect(v.conexoes.whatsapp).toEqual({ estado: "tipo_errado", nome: null });

      const semZap = api({
        [ROTA_EU]: resposta(200, { workspace: WS }),
        [ROTA_LISTA]: resposta(200, lista),
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
      });
      const v2 = await verificarCredenciaisHablla({ env: { ...env, HABLLA_WHATSAPP_CONNECTION_ID: undefined } as NodeJS.ProcessEnv, fetch: semZap.fetch });
      expect(v2.conexoes.whatsapp).toEqual({ estado: "nao_configurada", nome: null });
      expect(v2.conexoes.instagram.estado).toBe("ok");
    });

    it("não consegue listar as conexões: a verificação das configuradas continua valendo", async () => {
      const { fetch } = api({
        [ROTA_EU]: resposta(200, { workspace: WS }),
        [ROTA_LISTA]: resposta(500, "boom"),
        [ROTA_CONEXAO_INSTA]: resposta(200, conexao(INSTA, "INSTAGRAM")),
        [ROTA_CONEXAO_ZAP]: resposta(200, conexao(ZAP, "WHATSAPP_MESSAGING")),
      });
      const v = await verificarCredenciaisHablla({ env, fetch });
      expect(v.conexoesNoWorkspace).toEqual([]);
      expect(v.conexoes.instagram.estado).toBe("ok");
    });
  });
});
