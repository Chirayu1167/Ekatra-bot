import { clearApiKey, getApiKey, getOrganizationScope } from "./session";

export type ApiErrorBody = {
  code: string;
  message: string;
};

export class ApiRequestError extends Error {
  constructor(
    public readonly error: ApiErrorBody,
    public readonly status: number,
  ) {
    super(error.message);
    this.name = "ApiRequestError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function request<T>(input: string, init: RequestInit = {}): Promise<T> {
  const token = getApiKey();
  const scope = input.startsWith("/admin/") ? getOrganizationScope() : null;
  const separator = input.includes("?") ? "&" : "?";
  const hasOrg = new URLSearchParams(input.split("?")[1] ?? "").has("org");
  const scopedInput = scope && !hasOrg ? `${input}${separator}org=${encodeURIComponent(scope)}` : input;
  const response = await fetch(`${API_BASE}${scopedInput}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  });

  if (response.status === 401) {
    clearApiKey();
    window.dispatchEvent(new CustomEvent("ek:unauthorized"));
    throw new ApiRequestError({ code: "unauthorized", message: "Session expired" }, 401);
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const apiError =
      typeof body === "object" && body !== null && "error" in body
        ? (body as { error?: unknown }).error
        : undefined;
    if (
      typeof apiError === "object" &&
      apiError !== null &&
      "code" in apiError &&
      typeof apiError.code === "string" &&
      "message" in apiError &&
      typeof apiError.message === "string"
    ) {
      throw new ApiRequestError(
        { code: apiError.code, message: apiError.message },
        response.status,
      );
    }
    throw new ApiRequestError(
      { code: "request_failed", message: response.statusText || "Request failed" },
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
