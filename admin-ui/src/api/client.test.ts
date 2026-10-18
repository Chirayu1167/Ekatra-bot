import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, request } from "./client";
import { clearApiKey, setApiKey, setOrganizationScope } from "./session";

afterEach(() => {
  clearApiKey();
  setOrganizationScope(null);
  vi.unstubAllGlobals();
});

describe("admin API client", () => {
  it("sends the bearer key and returns successful JSON", async () => {
    setApiKey("test-key", false);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(request<{ ok: boolean }>("/admin/session")).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });

  it("maps structured API errors into typed errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "conflict", message: "Cannot pause" } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(request("/admin/enrollments/1/pause")).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 409,
      error: { code: "conflict", message: "Cannot pause" },
    });
  });

  it("clears the key and emits unauthorized on 401", async () => {
    setApiKey("expired-key", true);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(request("/admin/session")).rejects.toBeInstanceOf(ApiRequestError);
    expect(window.sessionStorage.getItem("ek_api_key")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ek:unauthorized" }));
  });

  it("adds the selected org scope to admin requests only", async () => {
    setOrganizationScope("acme");
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await request("/admin/courses");
    await request("/ready");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/admin/courses?org=acme");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/ready");
  });
});
