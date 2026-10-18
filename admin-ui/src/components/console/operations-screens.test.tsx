import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import {
  CertificatesScreen,
  DeliveryScreen,
  FailuresScreen,
  StatusScreen,
  UsersAuditScreen,
} from "./operations-screens";

const api = vi.hoisted(() => ({
  organisations: vi.fn(),
  deliveryList: vi.fn(),
  deliveryGet: vi.fn(),
  failureList: vi.fn(),
  failureGet: vi.fn(),
  failureReplay: vi.fn(),
  failureDiscard: vi.fn(),
  certificateList: vi.fn(),
  certificateResend: vi.fn(),
  userList: vi.fn(),
  userCreate: vi.fn(),
  userRotate: vi.fn(),
  userRevoke: vi.fn(),
  audit: vi.fn(),
  readiness: vi.fn(),
  worker: vi.fn(),
}));

vi.mock("@/api/auth-context", () => ({
  useAuth: () => ({
    session: { id: 3, name: "Admin", role: "org_admin", orgId: 1, orgSlug: "demo" },
    loading: false,
    error: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    setOrganization: vi.fn(),
  }),
}));

vi.mock("@/api/admin", () => ({
  adminApi: {
    organisations: api.organisations,
    delivery: { list: api.deliveryList, get: api.deliveryGet },
    failures: { list: api.failureList, get: api.failureGet, replay: api.failureReplay, discard: api.failureDiscard },
    certificates: { list: api.certificateList, resend: api.certificateResend },
    users: { list: api.userList, create: api.userCreate, rotate: api.userRotate, revoke: api.userRevoke },
    audit: api.audit,
    status: { readiness: api.readiness, worker: api.worker },
  },
}));

const delivery = {
  id: 8, status: "sent", kind: "scheduled_lesson", providerMessageId: "SM123",
  attempts: 1, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  nextRetryAt: null, learnerId: 10,
};
const failure = {
  id: 9, kind: "outbound" as const, status: "open" as const, reason: "Connection timed out",
  reasonCode: "delivery_timeout", createdAt: "2025-01-01T00:00:00.000Z",
  resolutionNote: "", userId: null, messageStatus: "dead_letter", attempts: 2,
};
const certificate = {
  id: 12, enrollmentId: 10, code: "CERT-12", learnerName: "Asha", courseTitle: "Basics",
  issuedAt: "2025-01-01T00:00:00.000Z",
};
const user = {
  id: 5, orgId: 1, name: "Operator", role: "instructor" as const,
  createdAt: "2025-01-01T00:00:00.000Z", keys: [],
};
const groups: Array<{
  name: string;
  component: ComponentType;
  load: () => ReturnType<typeof vi.fn>;
  empty: () => void;
  success: string;
}> = [
  {
    name: "Delivery",
    component: DeliveryScreen,
    load: () => api.deliveryList,
    empty: () => api.deliveryList.mockResolvedValue({ messages: [], page: 1, pageSize: 20, total: 0 }),
    success: "scheduled lesson",
  },
  {
    name: "Failures",
    component: FailuresScreen,
    load: () => api.failureList,
    empty: () => api.failureList.mockResolvedValue({ failures: [], counts: [] }),
    success: "delivery timeout",
  },
  {
    name: "Certificates",
    component: CertificatesScreen,
    load: () => api.certificateList,
    empty: () => api.certificateList.mockResolvedValue({ certificates: [], page: 1, pageSize: 20, total: 0 }),
    success: "Asha",
  },
  {
    name: "Users and audit",
    component: UsersAuditScreen,
    load: () => api.userList,
    empty: () => {
      api.userList.mockResolvedValue({ users: [] });
      api.audit.mockResolvedValue({ entries: [] });
    },
    success: "Operator",
  },
  {
    name: "Status",
    component: StatusScreen,
    load: () => api.readiness,
    empty: () => {
      api.readiness.mockResolvedValue({ status: "not_ready", database: false, migration: false, heartbeatAgeMs: null });
      api.worker.mockResolvedValue({ status: "stale", heartbeatAgeMs: null });
    },
    success: "ready",
  },
];

function renderScreen(Screen: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><Screen /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.organisations.mockResolvedValue({ organisations: [] });
  api.deliveryList.mockResolvedValue({ messages: [delivery], page: 1, pageSize: 20, total: 1 });
  api.deliveryGet.mockResolvedValue({ ...delivery, attemptCount: 1, attempts: [], messages: [] });
  api.failureList.mockResolvedValue({ failures: [failure], counts: [{ reasonCode: "delivery_timeout", count: 1 }] });
  api.failureGet.mockResolvedValue({ failure, attempts: [], event: null });
  api.failureReplay.mockResolvedValue({ replayed: true });
  api.failureDiscard.mockResolvedValue({ discarded: true });
  api.certificateList.mockResolvedValue({ certificates: [certificate], page: 1, pageSize: 20, total: 1 });
  api.certificateResend.mockResolvedValue({ ok: true, messageId: 15 });
  api.userList.mockResolvedValue({ users: [user] });
  api.userCreate.mockResolvedValue({ user, apiKey: "one-time-test-key", keyId: 1, prefix: "ek_live_te" });
  api.userRotate.mockResolvedValue({ apiKey: "rotated-test-key", keyId: 2, prefix: "ek_live_ro", revoked: 1 });
  api.userRevoke.mockResolvedValue(undefined);
  api.audit.mockResolvedValue({ entries: [] });
  api.readiness.mockResolvedValue({ status: "ready", database: true, migration: true, heartbeatAgeMs: 100 });
  api.worker.mockResolvedValue({ status: "live", heartbeatAgeMs: 100, thresholdMs: 60000 });
});

describe.each(groups)("$name screen states", ({ component, load, empty, success }) => {
  it("renders loading", () => {
    load().mockReturnValue(new Promise(() => undefined));
    renderScreen(component);
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("renders errors clearly", async () => {
    load().mockRejectedValue(new Error("Service unavailable"));
    renderScreen(component);
    expect((await screen.findByRole("alert")).textContent).toContain("Service unavailable");
  });

  it("renders an empty state", async () => {
    empty();
    renderScreen(component);
    const expected = component === StatusScreen ? "not ready" : "No";
    expect((await screen.findAllByText(new RegExp(expected, "i"))).length).toBeGreaterThan(0);
  });

  it("renders successful data", async () => {
    renderScreen(component);
    expect(await screen.findByText(new RegExp(success, "i"))).toBeTruthy();
  });
});
