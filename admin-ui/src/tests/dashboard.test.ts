import { describe, expect, it } from "vitest";
import { computeStats } from "../routes/dashboard";

describe("dashboard learning and delivery metrics", () => {
  it("uses enrollment and failure totals rather than message page lengths", () => {
    const stats = computeStats([], 87, 14, [
      { reasonCode: "delivery_timeout", count: 3 },
      { reasonCode: "template_required", count: 2 },
    ]);

    expect(stats.map(({ name, value }) => [name, value])).toEqual([
      ["Total Courses", 0],
      ["Active Enrollments", 87],
      ["Recorded Completions", 14],
      ["Open Failures", 5],
    ]);
  });
});
