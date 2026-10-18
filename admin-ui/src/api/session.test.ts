import { afterEach, describe, expect, it } from "vitest";
import { clearApiKey, getApiKey, setApiKey } from "./session";

afterEach(() => {
  clearApiKey();
  window.localStorage.clear();
});

describe("API key session storage", () => {
  it("keeps a key in memory without persisting it by default", () => {
    setApiKey("memory-only-key", false);
    expect(getApiKey()).toBe("memory-only-key");
    expect(window.sessionStorage.getItem("ek_api_key")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("persists only in sessionStorage when the user opts in", () => {
    setApiKey("tab-key", true);
    expect(window.sessionStorage.getItem("ek_api_key")).toBe("tab-key");
    expect(window.localStorage.length).toBe(0);
    clearApiKey();
    expect(getApiKey()).toBeNull();
  });
});
