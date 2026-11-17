// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { LanguageProvider } from "@/contexts/language";
vi.mock("@/assets/logotipo-soundos.png", () => ({ default: "logo.png" }));
import FormalizacaoPage, { submissionErrorCode } from "./formalizacao";

function renderAt(path: string) {
  const { hook } = memoryLocation({ path });
  return render(<LanguageProvider><Router hook={hook}><FormalizacaoPage /></Router></LanguageProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("FormalizacaoPage", () => {
  it("shows invalid state on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    renderAt("/formalizacao/tok");
    expect(await screen.findByTestId("status-invalid")).toBeTruthy();
  });

  it("shows retry on server error and reloads", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed", evento: { nome: "Retiro" }, campos: [], expiresAt: "2099-01-01T00:00:00Z" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    renderAt("/formalizacao/tok");
    fireEvent.click(await screen.findByTestId("button-retry"));
    expect(await screen.findByTestId("status-completed")).toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("renders form for pending without prefilled values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "pending", evento: { nome: "Retiro" }, expiresAt: "2099-01-01T00:00:00Z",
      campos: [{ key: "cpf", label: "CPF", type: "text", required: true }],
    }), { status: 200 })));
    renderAt("/formalizacao/tok");
    expect((await screen.findByTestId("text-event-name")).textContent).toBe("Retiro");
    const inputs = document.querySelectorAll("input");
    inputs.forEach(i => expect(i.value).toBe(""));
  });

  it("maps stable error codes and ignores raw messages", () => {
    expect(submissionErrorCode({ code: "INVALID_CPF", error: "stack trace" })).toBe("INVALID_CPF");
    expect(submissionErrorCode({ error: { code: "PERSON_MISMATCH" } })).toBe("PERSON_MISMATCH");
    expect(submissionErrorCode({ error: "EVENT_FLOW_CONFLICT" })).toBe("EVENT_FLOW_CONFLICT");
    expect(submissionErrorCode({ error: "db exploded" })).toBeNull();
  });

  it("shows translated code error on submit", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending", evento: { nome: "Retiro" }, expiresAt: "2099-01-01T00:00:00Z", campos: [{ key: "cpf", label: "CPF", type: "text", required: false }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "INVALID_CPF", error: "internal detail xyz" }), { status: 422 }));
    vi.stubGlobal("fetch", f);
    renderAt("/formalizacao/tok");
    await screen.findByTestId("text-event-name");
    fireEvent.submit(document.querySelector("form")!);
    const err = await screen.findByTestId("text-submit-error");
    expect(err.textContent).toContain("CPF");
    expect(err.textContent).not.toContain("internal detail");
  });

  it("adds no-referrer meta", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    renderAt("/formalizacao/tok");
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
  });
});
