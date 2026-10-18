import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";
import { clearApiKey } from "./session";

function AuthProbe() {
  const { session, signIn, signOut } = useAuth();
  return (
    <div>
      <span>{session?.role ?? "signed out"}</span>
      <button onClick={() => void signIn("valid-key", false)}>Sign in</button>
      <button onClick={signOut}>Sign out</button>
    </div>
  );
}

afterEach(() => {
  clearApiKey();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("auth context", () => {
  it("validates a key before exposing the session and clears it on sign-out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 7,
            name: "Instructor",
            role: "instructor",
            orgId: 2,
            orgSlug: "school",
          }),
          { status: 200 },
        ),
      ),
    );
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("instructor");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.getItem("ek_api_key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByText("signed out")).toBeTruthy());
  });
});
