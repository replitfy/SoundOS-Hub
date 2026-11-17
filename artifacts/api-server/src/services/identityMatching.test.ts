import { describe, expect, it } from "vitest";
import { namesLikelySame, resolveContactMatches } from "./identityMatching";

describe("identity matching for shared contacts", () => {
  const ana = { id: 1, nome: "Ana", sobrenome: "Silva" };
  const bia = { id: 2, nome: "Beatriz", sobrenome: "Souza" };

  it("uses the intersection when email disambiguates a shared phone", () => {
    expect(resolveContactMatches([ana], [ana, bia])).toEqual({
      kind: "match",
      person: ana,
      matchedBy: "both",
    });
  });

  it("rejects email and phone that point to different people", () => {
    expect(resolveContactMatches([ana], [bia])).toEqual({
      kind: "conflict",
      reason: "contradictory",
    });
  });

  it("rejects an ambiguous phone without another identifier", () => {
    expect(resolveContactMatches([], [ana, bia])).toEqual({
      kind: "conflict",
      reason: "ambiguous",
    });
  });

  it("accepts a first name expansion but rejects another person's name", () => {
    expect(namesLikelySame("Ana Silva", "Ana")).toBe(true);
    expect(namesLikelySame("Ana Silva", "Beatriz Souza")).toBe(false);
  });
});