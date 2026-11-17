import { describe, expect, it } from "vitest";
import { inferNameFromEmail } from "./unnamedPeopleCleanup";

describe("inferNameFromEmail", () => {
  it("turns common email separators into a readable name", () => {
    expect(inferNameFromEmail("maria.da-silva_42@example.com")).toBe("Maria Da Silva");
  });

  it("removes generic mailbox words while preserving a personal token", () => {
    expect(inferNameFromEmail("contato.joana+evento@example.com")).toBe("Joana");
  });

  it("rejects malformed and generic addresses", () => {
    expect(inferNameFromEmail("contato@example.com")).toBeNull();
    expect(inferNameFromEmail("sem-arroba")).toBeNull();
  });
});