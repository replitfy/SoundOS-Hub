import { describe, expect, it } from "vitest";
import {
  crawlUpcomingEvents,
  discoverUpcomingEventUrls,
  extractEventDocument,
  hasExplicitStoreProductIntent,
  isCatalogProductFactRequest,
  isPotentialCatalogProductFactRequest,
  isBareCatalogAvailabilityProbe,
  isGeneralStoreCatalogQuestion,
  hasCompleteEnoughEventSnapshot,
  eventAbsenceErrorMessage,
  isDirectInformationalQuestion,
  planEventAbsenceConfirmation,
} from "./soundfulnessEvents";

describe("isDirectInformationalQuestion", () => {
  it("trata pedidos nominais de vídeo como informação, mesmo sem verbo", () => {
    expect(isDirectInformationalQuestion("vídeo de prática de respiração")).toBe(true);
    expect(isDirectInformationalQuestion("vídeo sobre meditação guiada")).toBe(true);
    expect(isDirectInformationalQuestion("vídeo introdutório de prática de respiração")).toBe(true);
    expect(isDirectInformationalQuestion("vídeo para respiração")).toBe(true);
  });
  it.each([
    "Quando é o Ciclo Ar?",
    "Onde acontece o retiro?",
    "O que está incluído no curso de Sound Healing?",
    "Qual o preço da tigela tibetana?",
    "Me fale sobre o evento de cacau",
    "Tem algum vídeo para eu entender melhor essa formação?",
    "Me envie um vídeo sobre o curso Fogo",
  ])("reconhece pergunta factual: %s", message => {
    expect(isDirectInformationalQuestion(message)).toBe(true);
  });

  it.each([
    "Quero me inscrever no Ciclo Ar",
    "Quero comprar a tigela",
    "Eu trabalho com terapias",
    "Qual é o meu perfil?",
    "Você recomenda o Ciclo Ar para mim?",
    "O curso Fogo é indicado para o meu perfil?",
    "Posso participar do Ciclo Terra?",
    "Esse curso vai me ajudar com minha ansiedade?",
    "O Ciclo Ar combina comigo?",
    "Qual vídeo você recomenda para o meu perfil?",
  ])("não confunde transação ou triagem com pergunta factual: %s", message => {
    expect(isDirectInformationalQuestion(message)).toBe(false);
  });
});

describe("hasExplicitStoreProductIntent", () => {
  it.each([
    "Qual o preço da tigela?",
    "Me mande a página do produto",
    "Quanto custa o instrumento?",
    "Vocês têm Cajon Elétrico Bluetooth?",
    "Marimba de Vidro Bluetooth: preço e link",
  ])("reconhece consulta de loja: %s", message => {
    expect(hasExplicitStoreProductIntent(message)).toBe(true);
  });

  it.each([
    "Quanto custa o Ciclo Ar?",
    "Qual o preço do curso de Sound Healing?",
    "Qual o valor do próximo evento?",
  ])("não envia curso ou evento para o catálogo de produtos: %s", message => {
    expect(hasExplicitStoreProductIntent(message)).toBe(false);
  });
});

describe("isCatalogProductFactRequest", () => {
  it.each([
    "Qual é o preço da tigela?",
    "A tigela está disponível?",
    "Quero o link para comprar o gong",
    "Consulte o SKU deste produto na loja",
    "Vocês têm Cajon Elétrico Bluetooth?",
    "Qual o preço da Marimba de Vidro Bluetooth?",
  ])("recognizes catalog/commercial product facts: %s", message => {
    expect(isCatalogProductFactRequest(message)).toBe(true);
  });

  it.each([
    "Para que serve este instrumento?",
    "Como funciona uma tigela tibetana?",
    "Qual instrumento é melhor para meditação?",
    "A tigela tibetana é adequada para mim?",
    "Você recomenda comprar a tigela?",
    "Quero contratar a tigela tibetana",
  ])("leaves descriptive instrument questions outside the product fast path: %s", message => {
    expect(isCatalogProductFactRequest(message)).toBe(false);
  });
});

describe("isPotentialCatalogProductFactRequest", () => {
  it.each([
    "Vocês vendem Pandeiro Astral Bluetooth? Qual o preço e o link?",
    "Vocês vendem Pandeiro Astral Bluetooth?",
    "Vocês têm Pandeiro Astral Bluetooth?",
    "Estou procurando o produto Pandeiro Astral Bluetooth",
  ])("routes an unknown named product to the catalog: %s", message => {
    expect(isPotentialCatalogProductFactRequest(message)).toBe(true);
  });

  it.each([
    "Vocês vendem o curso Ciclo Ar?",
    "Vocês têm vídeo de respiração?",
    "Estou procurando um serviço de terapia",
    "Qual o preço do próximo evento?",
    "Vocês têm vagas para sábado?",
    "Vocês têm João da Silva?",
    "vocês têm joão da silva?",
    "Vocês têm João?",
  ])("does not confuse explicit non-product domains with catalog items: %s", message => {
    expect(isPotentialCatalogProductFactRequest(message)).toBe(false);
  });

  it("allows ambiguous short availability language only as a silent literal-catalog probe", () => {
    expect(isBareCatalogAvailabilityProbe("Vocês têm João?")).toBe(true);
    expect(isBareCatalogAvailabilityProbe("vocês têm joão da silva?")).toBe(true);
    expect(isBareCatalogAvailabilityProbe("Vocês têm vagas para sábado?")).toBe(false);
  });
});

describe("isGeneralStoreCatalogQuestion", () => {
  it.each([
    "Oi! Quais produtos vocês vendem na loja da Soundfulness?",
    "O que vocês vendem na loja?",
    "Que tipos de produtos a Soundfulness oferece?",
  ])("recognizes a broad question about the store assortment: %s", message => {
    expect(isGeneralStoreCatalogQuestion(message)).toBe(true);
  });

  it.each([
    "Vocês vendem tigela tibetana?",
    "Qual é o preço da tigela?",
    "Quero o link do gong.",
  ])("does not replace a specific product lookup: %s", message => {
    expect(isGeneralStoreCatalogQuestion(message)).toBe(false);
  });
});

describe("event extraction", () => {
  it("descobre somente links event-details depois do marcador", () => {
    const html = `
      <a href="/curso-antigo">Antigo</a>
      <div aria-label="Próximos Eventos" id="proximos-eventos"></div>
      <a href="/event-details/ciclo-ar?lang=pt&amp;ref=home">Ciclo Ar</a>
      <a href="https://example.com/event-details/falso">Externo</a>`;
    expect(discoverUpcomingEventUrls(html)).toEqual([
      "https://www.soundfulness.online/event-details/ciclo-ar?lang=pt&ref=home",
    ]);
  });

  it("transforma a página em documento pesquisável com fonte", () => {
    const body = "Imersão com programação completa, práticas sonoras e informações de local. ".repeat(5);
    const structuredEvent = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Ciclo Ar",
      description: "Imersão residencial completa.",
      startDate: "2026-10-07T16:00:00-03:00",
      endDate: "2026-10-12T16:00:00-03:00",
      location: {
        "@type": "Place",
        name: "Campos do Jordão",
        address: "Campos do Jordão, SP, Brasil",
      },
    };
    const doc = extractEventDocument(
      `<html><head>
        <meta property="og:title" content="Ciclo Ar | Soundfulness">
        <script type="application/ld+json">${JSON.stringify(structuredEvent)}</script>
      </head><body><h1>Ciclo Ar</h1><p>${body}</p></body></html>`,
      "https://www.soundfulness.online/event-details/ciclo-ar",
    );
    expect(doc.title).toBe("Ciclo Ar");
    expect(doc.markdown).toContain("Fonte oficial:");
    expect(doc.markdown).toContain("programação completa");
    expect(doc.event).toEqual({
      name: "Ciclo Ar",
      description: "Imersão residencial completa.",
      startDate: "2026-10-07",
      endDate: "2026-10-12",
      location: "Campos do Jordão",
      address: "Campos do Jordão, SP, Brasil",
      sourceUrl: "https://www.soundfulness.online/event-details/ciclo-ar",
    });
  });

  it("mantém sucessos quando uma página falha", async () => {
    const home = `<div>Próximos Eventos</div>
      <a href="/event-details/ok">Ok</a><a href="/event-details/falha">Falha</a>`;
    const structuredEvent = {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Evento OK",
      startDate: "2026-10-07T16:00:00-03:00",
      endDate: "2026-10-07T18:00:00-03:00",
      location: { "@type": "Place", name: "São Paulo" },
    };
    const page = `<script type="application/ld+json">${JSON.stringify(structuredEvent)}</script>
      <h1>Evento OK</h1><p>${"Conteúdo oficial detalhado. ".repeat(15)}</p>`;
    const result = await crawlUpcomingEvents(async url => {
      if (url.endsWith("/")) return home;
      if (url.includes("falha")) throw new Error("indisponível");
      return page;
    });
    expect(result.documents).toHaveLength(1);
    expect(result.failures).toEqual([
      { url: "https://www.soundfulness.online/event-details/falha", error: "indisponível" },
    ]);
  });

  it("rejeita página sem os dados estruturados necessários para a agenda", () => {
    const body = "Conteúdo visual sem data estruturada. ".repeat(10);
    expect(() => extractEventDocument(
      `<h1>Evento incompleto</h1><p>${body}</p>`,
      "https://www.soundfulness.online/event-details/incompleto",
    )).toThrow("dados estruturados");
  });

  it("só autoriza remoção com snapshot completo e plausível", () => {
    expect(hasCompleteEnoughEventSnapshot(7, 7, 0)).toBe(true);
    expect(hasCompleteEnoughEventSnapshot(7, 6, 0)).toBe(true);
    expect(hasCompleteEnoughEventSnapshot(8, 6, 0)).toBe(false);
    expect(hasCompleteEnoughEventSnapshot(7, 2, 0)).toBe(false);
    expect(hasCompleteEnoughEventSnapshot(7, 7, 1)).toBe(false);
  });

  it("exige duas ausências completas separadas no tempo antes de remover", () => {
    const now = new Date("2026-09-19T18:00:00.000Z");
    const sourceUrl = "https://www.soundfulness.online/event-details/encerrado?lang=pt";
    const first = planEventAbsenceConfirmation({
      previousItems: [{ id: 10, sourceUrl, errorMessage: null }],
      discoveredUrls: [],
      snapshotComplete: true,
      now,
    });
    expect(first).toEqual({
      firstMissingIds: [10],
      confirmedMissingIds: [],
      confirmedMissingSourceUrls: [],
    });

    const tooSoon = planEventAbsenceConfirmation({
      previousItems: [{
        id: 10,
        sourceUrl,
        errorMessage: eventAbsenceErrorMessage(new Date("2026-09-19T17:00:00.000Z")),
      }],
      discoveredUrls: [],
      snapshotComplete: true,
      now,
    });
    expect(tooSoon.confirmedMissingIds).toEqual([]);

    const confirmed = planEventAbsenceConfirmation({
      previousItems: [{
        id: 10,
        sourceUrl,
        errorMessage: eventAbsenceErrorMessage(new Date("2026-09-19T12:00:00.000Z")),
      }],
      discoveredUrls: [],
      snapshotComplete: true,
      now,
    });
    expect(confirmed).toEqual({
      firstMissingIds: [],
      confirmedMissingIds: [10],
      confirmedMissingSourceUrls: [sourceUrl],
    });
  });

  it("não avança confirmação quando o snapshot está incompleto", () => {
    expect(planEventAbsenceConfirmation({
      previousItems: [{
        id: 10,
        sourceUrl: "https://www.soundfulness.online/event-details/encerrado",
        errorMessage: null,
      }],
      discoveredUrls: [],
      snapshotComplete: false,
      now: new Date("2026-09-19T18:00:00.000Z"),
    })).toEqual({
      firstMissingIds: [],
      confirmedMissingIds: [],
      confirmedMissingSourceUrls: [],
    });
  });
});