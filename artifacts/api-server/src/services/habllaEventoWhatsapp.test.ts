import { describe, expect, it } from "vitest";
import { hashEmHexadecimal, interpretarEventoWhatsapp, motivoDaFalhaDeEntrega, telefoneDoRemetente } from "./habllaEventoWhatsapp";
import { markdownParaWhatsapp, dividirParaWhatsapp } from "./whatsappTexto";

const esperado = { workspaceId: "ws-1", conexaoId: "con-1" };

function entrada(extra: Record<string, unknown> = {}, mensagem: Record<string, unknown> = {}) {
  return {
    workspace: "ws-1", connection: "con-1", meta_channel: "whatsapp",
    external_id: "wamid.AAA111", message_id: "interno-1",
    sender_name: "Maria Teste", sender_phone: "5511999990001", sender_user_id: "u-1",
    message: { type: "text", body: "Oi, quero saber do curso", is_echo: false, ...mensagem },
    ...extra,
  };
}

describe("interpretarEventoWhatsapp", () => {
  it("texto de cliente da conexão configurada vira mensagem", () => {
    expect(interpretarEventoWhatsapp(entrada(), esperado)).toMatchObject({
      tipo: "mensagem", externoId: "whatsapp:msg:wamid.AAA111", telefone: "5511999990001",
      nomePerfil: "Maria Teste", texto: "Oi, quero saber do curso",
    });
  });

  it("aceita telefone com +, espaços e hífens e guarda só os dígitos", () => {
    const e = interpretarEventoWhatsapp(entrada({ sender_phone: "+55 (11) 99999-0001" }), esperado);
    expect(e).toMatchObject({ tipo: "mensagem", telefone: "5511999990001" });
  });

  it("o nome de perfil 'unknown' não é guardado", () => {
    expect(interpretarEventoWhatsapp(entrada({ sender_name: "unknown" }), esperado)).toMatchObject({ tipo: "mensagem", nomePerfil: null });
  });

  it.each([
    ["outro workspace", { workspace: "ws-outro" }, "outro_workspace"],
    ["outra conexão", { connection: "con-outra" }, "outra_conexao"],
    ["outro canal da Meta", { meta_channel: "instagram" }, "outro_canal"],
  ])("%s é ignorado com motivo", (_nome, extra, motivo) => {
    expect(interpretarEventoWhatsapp(entrada(extra), esperado)).toMatchObject({ tipo: "ignorado", motivo });
  });

  it("texto sem workspace ou sem conexão não é respondido", () => {
    const semWorkspace = { ...entrada(), workspace: undefined };
    const semConexao = { ...entrada(), connection: undefined };
    expect(interpretarEventoWhatsapp(semWorkspace, esperado)).toMatchObject({ tipo: "ignorado", motivo: "workspace_ou_conexao_ausente" });
    expect(interpretarEventoWhatsapp(semConexao, esperado)).toMatchObject({ tipo: "ignorado", motivo: "workspace_ou_conexao_ausente" });
  });

  it("sem workspace ou conexão configurados no SoundOS nada é respondido", () => {
    expect(interpretarEventoWhatsapp(entrada(), { workspaceId: null, conexaoId: "con-1" })).toMatchObject({ tipo: "ignorado", motivo: "canal_nao_configurado" });
    expect(interpretarEventoWhatsapp(entrada(), { workspaceId: "ws-1", conexaoId: null })).toMatchObject({ tipo: "ignorado", motivo: "canal_nao_configurado" });
  });

  it.each([
    ["eco da própria conta", entrada({}, { is_echo: true }), "mensagem_enviada_pela_conta"],
    ["figurinha", entrada({}, { type: "sticker" }), "mensagem_sem_texto:sticker"],
    ["localização", entrada({}, { type: "location" }), "mensagem_sem_texto:location"],
    ["contato", entrada({}, { type: "contacts" }), "mensagem_sem_texto:contacts"],
    ["reação", entrada({}, { type: "reaction" }), "mensagem_sem_texto:reaction"],
    ["botão", entrada({}, { type: "button" }), "mensagem_sem_texto:button"],
    ["tipo desconhecido não copia o valor do payload", entrada({}, { type: "Tipo Estranho 123" }), "mensagem_sem_texto:desconhecido"],
    ["texto vazio", entrada({}, { body: "   " }), "texto_vazio"],
    ["sem telefone (só id de usuário)", entrada({ sender_phone: undefined }), "remetente_sem_telefone"],
    ["telefone inválido e sem id de usuário", entrada({ sender_phone: "abc", sender_user_id: undefined }), "telefone_invalido"],
    ["telefone curto demais", entrada({ sender_phone: "12345", sender_user_id: undefined }), "telefone_invalido"],
    ["sem objeto de mensagem", { ...entrada(), message: undefined }, "evento_sem_mensagem"],
    ["chamada de voz", entrada({ event: "CONNECT", call_id: "c1" }), "chamada_de_voz"],
    ["chamada de voz por direção", entrada({ direction: "USER_INITIATED" }), "chamada_de_voz"],
    ["evento de conta", entrada({ field: "account_update" }), "evento_de_conta"],
    ["evento de modelo de mensagem", entrada({ field: "message_template_status_update" }), "evento_de_conta"],
  ])("%s é ignorado com motivo", (_nome, payload, motivo) => {
    expect(interpretarEventoWhatsapp(payload, esperado)).toMatchObject({ tipo: "ignorado", motivo });
  });

  describe("arquivos recebidos (imagem, vídeo, áudio e documento)", () => {
    const hexa = "ab".repeat(32);

    it.each(["image", "video", "audio", "document"] as const)("%s vira mensagem com o arquivo, sem texto", tipo => {
      const e = interpretarEventoWhatsapp(entrada({}, {
        type: tipo, body: undefined, mime_type: "x/y", url: "https://cdn.astenir.com/a/b", sha256: hexa,
      }), esperado);
      expect(e).toMatchObject({
        tipo: "mensagem", externoId: "whatsapp:msg:wamid.AAA111", telefone: "5511999990001", texto: "",
        anexo: { tipo, mimeDeclarado: "x/y", sha256: hexa, url: "https://cdn.astenir.com/a/b", metaId: "wamid.AAA111" },
      });
    });

    it("a legenda vira o texto da mensagem; o nome do arquivo só vale para documento", () => {
      const imagem = interpretarEventoWhatsapp(entrada({}, { type: "image", body: undefined, caption: "  Comprovante  ", filename: "x.png" }), esperado);
      expect(imagem).toMatchObject({ tipo: "mensagem", texto: "Comprovante", anexo: { tipo: "image", nome: null } });
      const documento = interpretarEventoWhatsapp(entrada({}, { type: "document", filename: "contrato.pdf" }), esperado);
      expect(documento).toMatchObject({ tipo: "mensagem", anexo: { tipo: "document", nome: "contrato.pdf" } });
    });

    it("o corpo do aviso nunca é tomado como legenda de um arquivo", () => {
      expect(interpretarEventoWhatsapp(entrada({}, { type: "image", body: "https://exemplo.com/foto.jpg" }), esperado))
        .toMatchObject({ tipo: "mensagem", texto: "" });
    });

    it("endereço, hash e formato ausentes ficam nulos (a cópia falha de forma controlada depois)", () => {
      const e = interpretarEventoWhatsapp(entrada({}, { type: "audio", body: undefined }), esperado);
      expect(e).toMatchObject({ tipo: "mensagem", anexo: { url: null, sha256: null, mimeDeclarado: null } });
    });

    it("legenda gigante é cortada em 4000 caracteres", () => {
      const e = interpretarEventoWhatsapp(entrada({}, { type: "image", caption: "a".repeat(9000) }), esperado);
      expect((e as { texto: string }).texto).toHaveLength(4000);
    });

    it("as mesmas barreiras do texto valem: eco, outro canal, sem telefone, sem workspace", () => {
      const arquivo = { type: "image", body: undefined, url: "https://cdn.astenir.com/a" };
      expect(interpretarEventoWhatsapp(entrada({}, { ...arquivo, is_echo: true }), esperado)).toMatchObject({ tipo: "ignorado", motivo: "mensagem_enviada_pela_conta" });
      expect(interpretarEventoWhatsapp(entrada({ connection: "outra" }, arquivo), esperado)).toMatchObject({ tipo: "ignorado", motivo: "outra_conexao" });
      expect(interpretarEventoWhatsapp(entrada({ sender_phone: undefined }, arquivo), esperado)).toMatchObject({ tipo: "ignorado", motivo: "remetente_sem_telefone" });
      expect(interpretarEventoWhatsapp({ ...entrada({}, arquivo), workspace: undefined }, esperado)).toMatchObject({ tipo: "ignorado", motivo: "workspace_ou_conexao_ausente" });
    });

    it("hash em base64 (formato da Meta) vira hexadecimal; valor estranho vira nulo", () => {
      const base64 = Buffer.from(hexa, "hex").toString("base64");
      expect(hashEmHexadecimal(base64)).toBe(hexa);
      expect(hashEmHexadecimal(hexa.toUpperCase())).toBe(hexa);
      expect(hashEmHexadecimal("curto")).toBeNull();
      expect(hashEmHexadecimal(null)).toBeNull();
    });
  });

  it("payload que não é objeto é ignorado e o id vem do hash do corpo", () => {
    const a = interpretarEventoWhatsapp("texto solto", esperado);
    expect(a).toMatchObject({ tipo: "ignorado", motivo: "formato_invalido" });
    expect(a.externoId).toMatch(/^whatsapp:sha256:/);
    expect(interpretarEventoWhatsapp("texto solto", esperado).externoId).toBe(a.externoId);
  });

  describe("eventos de entrega", () => {
    it("o id inclui o canal e o status: o mesmo id da Meta com status diferente é outro evento", () => {
      const ids = (["sent", "delivered", "read", "failed"] as const).map(status =>
        interpretarEventoWhatsapp(entrada({ status }, { body: undefined }), esperado).externoId);
      expect(new Set(ids).size).toBe(4);
      expect(ids[0]).toBe("whatsapp:status:sent:wamid.AAA111");
      expect(interpretarEventoWhatsapp(entrada({ status: "read" }), esperado).externoId).toBe(ids[2]);
    });

    it("status vira atualização de entrega ligada ao id da mensagem na Meta", () => {
      expect(interpretarEventoWhatsapp(entrada({ status: "delivered", task_id: "fila-1" }), esperado)).toMatchObject({
        tipo: "status", status: "delivered", metaMessageId: "wamid.AAA111", filaId: "fila-1", erro: null,
      });
    });

    it("status tolera a ausência de workspace e conexão, mas não outra conexão", () => {
      const sem = { ...entrada({ status: "read" }), workspace: undefined, connection: undefined };
      expect(interpretarEventoWhatsapp(sem, esperado)).toMatchObject({ tipo: "status", status: "read" });
      expect(interpretarEventoWhatsapp(entrada({ status: "read", connection: "outra" }), esperado)).toMatchObject({ tipo: "ignorado", motivo: "outra_conexao" });
    });

    it("status desconhecido ou sem id da mensagem é ignorado", () => {
      expect(interpretarEventoWhatsapp(entrada({ status: "deleted" }), esperado)).toMatchObject({ tipo: "ignorado", motivo: "status_desconhecido" });
      expect(interpretarEventoWhatsapp(entrada({ status: "read", external_id: undefined }), esperado)).toMatchObject({ tipo: "ignorado", motivo: "status_sem_id_da_mensagem" });
    });

    it("falha de entrega traz o motivo e reconhece a janela de 24h (código 131047 da Meta)", () => {
      const janela = interpretarEventoWhatsapp(entrada({ status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] }), esperado);
      expect(janela).toMatchObject({ tipo: "status", status: "failed" });
      expect((janela as { erro: string }).erro).toContain("Fora da janela de 24h");
      const outra = interpretarEventoWhatsapp(entrada({ status: "failed", errors: [{ code: 131026, title: "Message undeliverable" }] }), esperado);
      expect((outra as { erro: string }).erro).toContain("O número não recebe WhatsApp (131026)");
      const foraDaLista = interpretarEventoWhatsapp(entrada({ status: "failed", errors: [{ code: 131030, title: "Recipient not in allowed list" }] }), esperado);
      expect((foraDaLista as { erro: string }).erro).toContain("Número fora da lista de teste da Meta (131030)");
      expect((foraDaLista as { erro: string }).erro).not.toContain("Recipient");
      expect(motivoDaFalhaDeEntrega({ status: "failed" })).toBeNull();
    });
  });

  describe("resultado do envio feito pelo SoundOS", () => {
    it("liga o id da fila ao id da mensagem na Meta", () => {
      const e = interpretarEventoWhatsapp(
        { workspace: "ws-1", connection: "con-1", event: "astenir.meta_api.whatsapp.message_send", task_id: "fila-9", status: "success",
          response: { messages: [{ id: "wamid.ZZZ9" }] } },
        esperado,
      );
      expect(e).toMatchObject({ tipo: "resultado_envio", filaId: "fila-9", metaMessageId: "wamid.ZZZ9", sucesso: true, externoId: "whatsapp:envio:fila-9:success" });
    });

    it("erro no envio carrega o motivo", () => {
      const e = interpretarEventoWhatsapp(
        { event: "astenir.meta_api.whatsapp.message_send", task_id: "fila-9", status: "error", error_data: { message: "Número fora da lista de teste" } },
        esperado,
      );
      expect(e).toMatchObject({ tipo: "resultado_envio", sucesso: false });
      expect((e as { erro: string }).erro).toContain("Número fora da lista de teste");
    });

    describe("erro da Meta que o Hablla devolve como texto em `data`", () => {
      const falha = (data: unknown) => interpretarEventoWhatsapp(
        { event: "astenir.meta_api.whatsapp.message_send", task_id: "fila-9", status: "error", date_time: "2026-11-03T12:30:45Z", data },
        esperado,
      ) as { tipo: string; sucesso: boolean; erro: string };

      const meta = (codigo: number, mensagem: string) => JSON.stringify({
        error: { message: mensagem, type: "OAuthException", code: codigo, fbtrace_id: "AbC130123xYz" },
      });

      it("traduz o código 131030 sem copiar a mensagem do provedor", () => {
        const e = falha(`API request failed with status 400: ${meta(131030, "(#131030) Recipient phone number not in allowed list")}`);
        expect(e).toMatchObject({ tipo: "resultado_envio", sucesso: false });
        expect(e.erro).toMatch(/lista de teste da Meta \(131030\)/);
        expect(e.erro).not.toContain("Recipient");
      });

      it("distingue token expirado (190) de número fora da lista", () => {
        const e = falha(`API request failed with status 401: ${meta(190, "Error validating access token: Session has expired")}`);
        expect(e.erro).toMatch(/token de acesso da Meta/);
        expect(e.erro).toContain("(190)");
        expect(e.erro).not.toContain("Session");
      });

      it("lê o código do campo, não de uma sequência de dígitos dentro de um id", () => {
        const e = falha(`API request failed with status 400: ${meta(131047, "Re-engagement message")}`);
        expect(e.erro).toMatch(/24h/);
      });

      it("dá o código dos demais erros e aceita `data` como objeto", () => {
        expect(falha(`API request failed with status 400: ${meta(100, "Invalid parameter")}`).erro).toBe("Falha da Meta, código 100.");
        expect(falha(JSON.parse(meta(131030, "x"))).erro).toMatch(/131030/);
      });

      it("sem código reconhecível mantém a mensagem genérica", () => {
        expect(falha("API request failed with status 500: erro interno").erro).toBe("O Hablla não conseguiu enviar a mensagem.");
        expect(falha(undefined).erro).toBe("O Hablla não conseguiu enviar a mensagem.");
      });
    });

    it("outros eventos da Astenir não são mensagens de cliente", () => {
      expect(interpretarEventoWhatsapp({ ...entrada(), event: "astenir.meta_api.whatsapp.template_sync" }, esperado))
        .toMatchObject({ tipo: "ignorado", motivo: "evento_de_conta" });
    });
  });
});

describe("telefoneDoRemetente", () => {
  it.each([
    ["5511999990001", "5511999990001"],
    ["+55 11 99999-0001", "5511999990001"],
    ["+1 (415) 555-0123", "14155550123"],
    ["abc", null],
    ["123", null],
    [null, null],
    ["5511999990001; DROP", null],
  ])("%s", (valor, esperadoDigitos) => {
    expect(telefoneDoRemetente(valor)).toBe(esperadoDigitos);
  });
});

describe("texto para WhatsApp", () => {
  it("converte markdown para o jeito do WhatsApp", () => {
    const texto = markdownParaWhatsapp("## Workshop\n\nO **valor** é por *pessoa*. Veja [aqui](https://exemplo.com/a).\n\n* item um\n* item dois");
    expect(texto).toBe("*Workshop*\n\nO *valor* é por _pessoa_. Veja aqui: https://exemplo.com/a.\n\n- item um\n- item dois");
  });

  it("não deixa símbolos de markdown soltos", () => {
    expect(markdownParaWhatsapp("**a** `b` ~~c~~")).toBe("*a* b ~c~");
  });

  it("divide respostas longas sem cortar o link de interesse", () => {
    const link = "https://soundfulness.com.br/interesse/workshop-de-teste-com-um-endereco-bem-comprido";
    const paragrafo = "Este é um parágrafo de apresentação bastante longo para ocupar espaço na mensagem. ".repeat(18);
    const texto = `${paragrafo}\n\nPara registrar seu interesse, use este link: ${link}\n\n${paragrafo}`;
    const partes = dividirParaWhatsapp(texto);
    expect(partes.length).toBeGreaterThan(1);
    for (const parte of partes) expect(parte.length).toBeLessThanOrEqual(1500);
    expect(partes.filter(p => p.includes(link))).toHaveLength(1);
    expect(partes.join("\n").replace(/\s+/g, " ")).toContain(link);
  });
});
