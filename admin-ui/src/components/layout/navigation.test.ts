import { describe, expect, it } from "vitest";
import { navigationForRole } from "./navigation";

describe("role navigation", () => {
  it("limits instructors to courses and read-only learners", () => {
    expect(navigationForRole("instructor").map((item) => item.label)).toEqual([
      "Courses",
      "Learners",
    ]);
  });

  it("shows only implemented screens to org admins and platform admins", () => {
    for (const role of ["org_admin", "platform_admin"] as const) {
      expect(navigationForRole(role).map((item) => item.label)).toEqual([
        "Courses",
        "Learners",
        "Broadcasts",
        "Schedules",
        "Delivery",
        "Failures",
        "Certificates",
        "Broadcast",
        "Users and API keys",
        "Status",
      ]);
    }
  });
});
