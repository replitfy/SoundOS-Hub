import {
  DEFAULT_SOFIA_MODEL_ID,
  SOFIA_MODEL_IDS,
  type SofiaModelId,
} from "@workspace/sofia-models";

export { DEFAULT_SOFIA_MODEL_ID };

type SofiaModelPresentation = {
  label: string;
  descKey: string;
  color: string;
  dotColor: string;
};

const PRESENTATION_BY_MODEL = {
  "openai/gpt-5.6-sol": { label: "Sol", descKey: "sofia.prompt.desc_sol", color: "bg-orange-100 text-orange-800", dotColor: "bg-orange-500" },
  "openai/gpt-5.6-terra": { label: "Terra", descKey: "sofia.prompt.desc_terra", color: "bg-emerald-100 text-emerald-800", dotColor: "bg-emerald-500" },
  "gpt-5.4": { label: "gpt-5.4", descKey: "sofia.prompt.desc_mais_capaz", color: "bg-amber-100 text-amber-800", dotColor: "bg-amber-400" },
  "gpt-5.2": { label: "gpt-5.2", descKey: "sofia.prompt.desc_equilibrado", color: "bg-amber-50 text-amber-700", dotColor: "bg-amber-400" },
  "gpt-5": { label: "gpt-5", descKey: "sofia.prompt.desc_geral", color: "bg-stone-100 text-stone-700", dotColor: "bg-amber-400" },
  "gpt-5.4-mini": { label: "gpt-5.4-mini", descKey: "sofia.prompt.desc_rapido", color: "bg-sky-100 text-sky-700", dotColor: "bg-sky-400" },
  "gpt-5-mini": { label: "gpt-5-mini", descKey: "sofia.prompt.desc_leve", color: "bg-sky-50 text-sky-600", dotColor: "bg-sky-400" },
  "gpt-5-nano": { label: "gpt-5-nano", descKey: "sofia.prompt.desc_ultra_leve", color: "bg-slate-100 text-slate-600", dotColor: "bg-slate-400" },
  "o4-mini": { label: "o4-mini", descKey: "sofia.prompt.desc_raciocinio", color: "bg-violet-100 text-violet-700", dotColor: "bg-violet-400" },
} as const satisfies Record<SofiaModelId, SofiaModelPresentation>;

export const SOFIA_MODELS = SOFIA_MODEL_IDS.map(value => ({
  value,
  ...PRESENTATION_BY_MODEL[value],
}));

export function getSofiaModelLabel(model: string): string {
  return SOFIA_MODELS.find(option => option.value === model)?.label ?? model;
}