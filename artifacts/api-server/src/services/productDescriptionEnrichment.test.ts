import { describe, expect, it, vi } from "vitest";
import {
  findSimilarProducts,
  generateProductDescription,
  getProductDescriptionEnrichment,
  hydrateProductDescriptionEnrichments,
  resetProductDescriptionEnrichmentForTests,
  sanitizeGeneratedDescription,
  scheduleProductDescriptionEnrichment,
  type DescriptionEnrichmentRepository,
  type DescriptionProduct,
} from "./productDescriptionEnrichment";

function product(
  id: string,
  name: string,
  description: string | null,
  sku = `SKU-${id}`,
): DescriptionProduct {
  return { id, name, description, sku, skus: [sku] };
}

describe("product description enrichment", () => {
  it("selects relevant catalog references and ignores generic words", () => {
    const target = product("target", "Hand Pan Kurd 10 Notas com Bag", null, "HP-KURD-10");
    const handPan = product("handpan", "Hand Pan Kurd 9 Notas", "Instrumento melódico de percussão.", "HP-KURD-9");
    const genericKit = product("kit", "Kit musical com Bag", "Conjunto de acessórios.");
    const unrelated = product("udu", "Udu", "Instrumento de percussão em cerâmica.");

    expect(findSimilarProducts(target, [target, genericKit, unrelated, handPan]))
      .toEqual([handPan]);
  });

  it("uses catalog references before the web fallback", async () => {
    const target = product("target", "Diapasão 128 Hz", null);
    const reference = product("reference", "Diapasão 64 Hz", "Diapasão de baixa frequência.");
    const generateFromCatalog = vi.fn().mockResolvedValue("Diapasão de baixa frequência usado em práticas sonoras.");
    const generateFromWeb = vi.fn();

    const result = await generateProductDescription(target, [target, reference], {
      generateFromCatalog,
      generateFromWeb,
    });

    expect(result).toEqual({
      description: "Diapasão de baixa frequência usado em práticas sonoras.",
      source: "sofia-catalog",
    });
    expect(generateFromCatalog).toHaveBeenCalledWith(target, [reference]);
    expect(generateFromWeb).not.toHaveBeenCalled();
  });

  it("uses web search only when no catalog reference is reliable", async () => {
    const target = product("target", "Chakapa", null);
    const generateFromCatalog = vi.fn();
    const generateFromWeb = vi.fn().mockResolvedValue(
      "Chocalho tradicional feito com folhas secas, usado para criar texturas rítmicas.",
    );

    const result = await generateProductDescription(target, [target], {
      generateFromCatalog,
      generateFromWeb,
    });

    expect(result?.source).toBe("sofia-web");
    expect(generateFromCatalog).not.toHaveBeenCalled();
    expect(generateFromWeb).toHaveBeenCalledOnce();
  });

  it("falls back to web when catalog context is insufficient", async () => {
    const target = product("target", "Kalimba Sansula", null);
    const reference = product("reference", "Kalimba 17 Notas", "Instrumento de lâminas metálicas.");
    const generateFromWeb = vi.fn().mockResolvedValue(
      "Kalimba montada sobre membrana, com timbre suave e ressonância prolongada.",
    );

    const result = await generateProductDescription(target, [target, reference], {
      generateFromCatalog: vi.fn().mockResolvedValue("INSUFICIENTE"),
      generateFromWeb,
    });

    expect(result?.source).toBe("sofia-web");
    expect(generateFromWeb).toHaveBeenCalledOnce();
  });

  it("caps excessive output and removes line breaks", () => {
    const target = product("target", "Udu", null);
    const raw = `Instrumento de percussão em cerâmica com sonoridade grave e ressonante.
      Seu corpo permite explorar diferentes timbres por meio de toques e variações de pressão, criando paisagens sonoras expressivas e orgânicas.`;

    const description = sanitizeGeneratedDescription(raw, target);

    expect(description).not.toContain("\n");
    expect(description!.length).toBeLessThanOrEqual(160);
    expect(description!.endsWith("…")).toBe(true);
  });

  it("rejects commercial claims, URLs and product SKUs", () => {
    const target = product("target", "Udu", null, "UDU-001");

    expect(sanitizeGeneratedDescription("Compre o Udu por R$ 500 com frete grátis.", target)).toBeNull();
    expect(sanitizeGeneratedDescription("Veja detalhes em https://example.com sobre este instrumento.", target)).toBeNull();
    expect(sanitizeGeneratedDescription("Modelo UDU-001 com timbre grave e ressonante.", target)).toBeNull();
  });

  it("preserves original descriptions by skipping generation", async () => {
    const target = product("target", "Udu", "Descrição oficial da Wix.");
    const generateFromCatalog = vi.fn();
    const generateFromWeb = vi.fn();

    expect(await generateProductDescription(target, [target], {
      generateFromCatalog,
      generateFromWeb,
    })).toBeNull();
    expect(generateFromCatalog).not.toHaveBeenCalled();
    expect(generateFromWeb).not.toHaveBeenCalled();
  });

  it("propagates a failed web lookup so the caller can schedule a retry", async () => {
    const target = product("target", "Udu", null);

    await expect(generateProductDescription(target, [target], {
      generateFromCatalog: vi.fn(),
      generateFromWeb: vi.fn().mockRejectedValue(new Error("timeout")),
    })).rejects.toThrow("timeout");
  });

  it("rehydrates a completed description after an in-memory reset", async () => {
    resetProductDescriptionEnrichmentForTests();
    const target = product("persistent", "Udu", null);
    const repository = {
      load: vi.fn().mockResolvedValue([{
        productId: target.id,
        fingerprint: "v1:persistent:udu:sku persistent",
        description: "Instrumento de percussão em cerâmica com timbre grave e ressonante.",
        source: "sofia-web",
        status: "ready",
        retryAfter: null,
        leaseUntil: null,
      }]),
      claim: vi.fn(),
      saveReady: vi.fn(),
      saveError: vi.fn(),
    } satisfies DescriptionEnrichmentRepository;

    await hydrateProductDescriptionEnrichments([target], repository);

    expect(getProductDescriptionEnrichment(target)).toEqual({
      description: "Instrumento de percussão em cerâmica com timbre grave e ressonante.",
      source: "sofia-web",
    });
  });

  it("claims and generates only once for concurrent schedules", async () => {
    resetProductDescriptionEnrichmentForTests();
    const target = product("concurrent", "Udu", null);
    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>(resolve => {
      releaseGeneration = resolve;
    });
    const repository = {
      load: vi.fn().mockResolvedValue([]),
      claim: vi.fn().mockResolvedValue(true),
      saveReady: vi.fn().mockResolvedValue(true),
      saveError: vi.fn().mockResolvedValue(undefined),
    } satisfies DescriptionEnrichmentRepository;
    const dependencies = {
      generateFromCatalog: vi.fn(),
      generateFromWeb: vi.fn().mockImplementation(async () => {
        await generationGate;
        return "Instrumento de percussão em cerâmica com timbre grave e ressonante.";
      }),
    };

    const first = scheduleProductDescriptionEnrichment([target], dependencies, repository);
    const second = scheduleProductDescriptionEnrichment([target], dependencies, repository);
    releaseGeneration();
    await Promise.all([first, second]);

    expect(repository.claim).toHaveBeenCalledOnce();
    expect(dependencies.generateFromWeb).toHaveBeenCalledOnce();
    expect(repository.saveReady).toHaveBeenCalledOnce();
  });

  it("rejects health and therapeutic claims from generated text", () => {
    const target = product("target", "Chakapa", null);

    expect(sanitizeGeneratedDescription(
      "Chocalho de folhas usado em cerimônias de cura e terapia sonora.",
      target,
    )).toBeNull();
  });
});