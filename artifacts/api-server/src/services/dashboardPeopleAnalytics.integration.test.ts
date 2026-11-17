import { describe, expect, it } from "vitest";
import { collectPeopleAnalytics } from "./dashboardSnapshot";

interface Distribution {
  totalCount: number;
  filledCount: number;
  missingCount: number;
  missingPercentage: number;
  items: Array<{ label: string; count: number; percentage: number }>;
}

describe("dashboard people analytics integration", () => {
  it("returns internally consistent percentages based on filled values", async () => {
    const analytics = await collectPeopleAnalytics() as {
      totalPeople: number;
      sex: Distribution;
      cities: Distribution;
      states: Distribution;
      referralSources: Distribution;
    };

    expect(analytics.totalPeople).toBeGreaterThan(0);
    for (const distribution of [
      analytics.sex,
      analytics.cities,
      analytics.states,
      analytics.referralSources,
    ]) {
      expect(distribution.totalCount).toBe(analytics.totalPeople);
      expect(distribution.filledCount + distribution.missingCount).toBe(analytics.totalPeople);
      expect(distribution.items.every(item => item.label !== "Não informado")).toBe(true);
      expect(distribution.items.every(item => item.percentage >= 0 && item.percentage <= 100)).toBe(true);
      const representedCount = distribution.items.reduce((sum, item) => sum + item.count, 0);
      expect(representedCount).toBe(distribution.filledCount);
    }
  });
});