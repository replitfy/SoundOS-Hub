import { describe, expect, it } from "vitest";
import { SOFIA_MODEL_IDS } from "@workspace/sofia-models";
import { SOFIA_MODELS } from "./sofia-models";

describe("Sofia model selector", () => {
  it("shows exactly the models accepted by the shared contract", () => {
    expect(SOFIA_MODELS.map(model => model.value)).toEqual(SOFIA_MODEL_IDS);
  });
});