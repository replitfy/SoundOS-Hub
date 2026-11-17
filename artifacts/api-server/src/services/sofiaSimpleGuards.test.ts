import { describe, expect, it } from "vitest";
import { fatosPermitidos, sanitizeUrls, urlsPermitidas, validarValoresEDatas } from "./sofiaSimpleGuards.js";

const saidas = [
  JSON.stringify({
    evento: { nome: "CICLO ÁGUA", data_inicio: "2027-01-13", preco: 2800, url_evento: "https://www.soundfulness.online/event-details/ciclo-agua" },
  }),
  JSON.stringify({
    produtos: [{ nome: "Mama Cocha 10 min", preco: 189.9, url: "https://www.soundfulness.online/product-page/mama-cocha-10" }],
  }),
  JSON.stringify({ videos: [{ texto: "📹 *Ciclo Água*\nhttps://youtu.be/abc123", link: "https://youtu.be/abc123" }] }),
];

describe("sanitizeUrls", () => {
  const permitidas = urlsPermitidas(saidas);

  it("mantém URLs vindas das tools, mesmo com pontuação ou barra final", () => {
    const texto = "Inscrição: https://www.soundfulness.online/event-details/ciclo-agua/. Vídeo: https://youtu.be/abc123!";
    expect(sanitizeUrls(texto, permitidas)).toEqual({ texto, removidas: 0 });
  });

  it("remove só a URL inventada e mantém o resto da resposta", () => {
    const texto = "O Ciclo Água começa em 13/01/2027.\nLink: https://soundfulness.com.br/inscricao-falsa\nQualquer dúvida, me chama!";
    expect(sanitizeUrls(texto, permitidas)).toEqual({
      texto: "O Ciclo Água começa em 13/01/2027.\nQualquer dúvida, me chama!",
      removidas: 1,
    });
  });

  it("URL inventada no meio da frase sai sem levar a frase", () => {
    const r = sanitizeUrls("Veja em https://exemplo.com/x e também https://youtu.be/abc123 para conhecer.", permitidas);
    expect(r).toEqual({ texto: "Veja em e também https://youtu.be/abc123 para conhecer.", removidas: 1 });
  });

  it("link markdown inválido vira só o rótulo", () => {
    expect(sanitizeUrls("Clique [aqui](https://falso.com/pagar) para ver.", permitidas).texto).toBe("Clique aqui para ver.");
  });
});

describe("validação suave de valores e datas", () => {
  const permitidos = fatosPermitidos(saidas, "2026-10-06");

  it("aceita preço e data das tools em formatos brasileiros", () => {
    const texto = "Custa R$ 2.800,00 e começa em 13/01/2027. O Mama Cocha sai por R$ 189,90. Hoje é 06/10/2026.";
    expect(validarValoresEDatas(texto, permitidos)).toEqual({ texto, valoresTrocados: 0, datasTrocadas: 0 });
  });

  it("troca só o valor e a data que não vieram das tools", () => {
    const r = validarValoresEDatas("Custa R$ 2.500 com início em 20/02/2027, e o kit R$ 189,90.", permitidos);
    expect(r).toEqual({
      texto: "Custa esse valor eu confirmo com o time interno com início em essa data eu confirmo com o time interno, e o kit R$ 189,90.",
      valoresTrocados: 1,
      datasTrocadas: 1,
    });
  });
});
