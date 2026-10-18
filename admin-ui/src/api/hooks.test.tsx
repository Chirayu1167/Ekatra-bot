import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCourses } from "./hooks";
import { clearApiKey } from "./session";

afterEach(() => {
  clearApiKey();
  vi.unstubAllGlobals();
});

describe("admin query hooks", () => {
  it("loads courses from the typed API client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            courses: [
              {
                id: 1,
                orgId: 2,
                slug: "intro",
                title: "Intro",
                description: "",
                status: "draft",
                lessonCount: 0,
                createdAt: "",
                updatedAt: "",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCourses(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.courses[0]?.title).toBe("Intro");
  });
});
