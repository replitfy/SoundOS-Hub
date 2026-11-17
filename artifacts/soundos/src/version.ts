declare const __APP_VERSION__: string;

/** ddmmyyyy-hhmm da build (fuso de São Paulo); injetado pelo Vite, ausente nos testes. */
export const APP_VERSION: string = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;
