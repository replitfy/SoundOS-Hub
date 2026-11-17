export const SOFIA_MODEL_IDS = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-5-nano",
  "o4-mini",
] as const;

export type SofiaModelId = (typeof SOFIA_MODEL_IDS)[number];

export const DEFAULT_SOFIA_MODEL_ID: SofiaModelId = "gpt-5.4";

const SOFIA_MODEL_ID_SET = new Set<string>(SOFIA_MODEL_IDS);

const PROVIDER_MODEL_BY_ALIAS: Readonly<Partial<Record<SofiaModelId, string>>> = {
  "openai/gpt-5.6-terra": "gpt-5.6-terra",
  "openai/gpt-5.6-sol": "gpt-5.6-sol",
};

export function isSofiaModelId(model: string): model is SofiaModelId {
  return SOFIA_MODEL_ID_SET.has(model);
}

export function toSofiaProviderModel(model: string): string {
  return PROVIDER_MODEL_BY_ALIAS[model as SofiaModelId] ?? model;
}