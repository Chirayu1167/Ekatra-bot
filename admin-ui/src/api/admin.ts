import { request } from "./client";

export type AdminRole = "platform_admin" | "org_admin" | "instructor";
export type EnrollmentStatus = "pending" | "active" | "paused" | "completed";
export type CourseStatus = "draft" | "published";

export interface AdminSession {
  id: number | null;
  name: string;
  role: AdminRole;
  orgId: number | null;
  orgSlug: string | null;
}

export interface Organisation {
  id: number;
  slug: string;
  name: string;
}

export interface CourseItem {
  kind: "text" | "image" | "document" | "video" | "audio" | "link" | "quiz";
  text?: string;
  caption?: string;
  url?: string;
  label?: string;
  explanation?: string | null;
  options?: Array<{ label: string; correct?: boolean }>;
}

export interface CourseLesson {
  id: number;
  courseId: number;
  position: number;
  title: string;
  items: CourseItem[];
}

export interface Course {
  id: number;
  orgId: number;
  slug: string;
  title: string;
  description: string;
  status: CourseStatus;
  lessonCount: number;
  createdAt: string;
  updatedAt: string;
  lessons?: CourseLesson[];
}

export interface PageResult {
  page: number;
  pageSize: number;
  total: number;
}

export interface Learner {
  id: number;
  name: string;
  phone: string;
  course: string;
  progress: number;
  status: EnrollmentStatus;
  optedOut: boolean;
}

export interface LearnerDetail {
  id: number;
  phone: string;
  name: string;
  optedOut: boolean;
  enrollments: Array<{
    id: number;
    courseId: number;
    courseTitle: string;
    status: EnrollmentStatus;
    progress: number;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
  }>;
}

export interface Enrollment {
  id: number;
  userId: string;
  courseId: number;
  courseTitle: string;
  status: EnrollmentStatus;
  progress: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Schedule {
  dailyTime: string | null;
  timezone: string;
  slots: Array<{ dow: number; time: string }>;
  kind?: "daily" | "custom";
  enabled?: boolean;
  graceHours?: number;
}

export interface User {
  id: number;
  orgId: number | null;
  name: string;
  role: AdminRole;
  createdAt: string;
  keys?: Array<{ id: number; prefix: string; createdAt: string; revokedAt: string | null }>;
}

export interface AuditEntry {
  id: number;
  actorUserId: number | null;
  orgId: number | null;
  action: string;
  target: string;
  createdAt: string;
}

export interface DeliveryMessage {
  id: number;
  status: string;
  kind: string;
  providerMessageId: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
  learnerId: number | null;
}

export interface FailureCount {
  reasonCode: string;
  count: number;
}

export interface Failure {
  id: number;
  kind: "inbound" | "outbound";
  status: "open" | "replayed" | "discarded";
  reason: string;
  reasonCode: string;
  createdAt: string;
  resolutionNote: string;
  userId: string | null;
  messageStatus: string | null;
  attempts: number | null;
  [key: string]: unknown;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const adminApi = {
  session: () => request<AdminSession>("/admin/session"),
  organisations: () => request<{ organisations: Organisation[] }>("/admin/orgs"),
  courses: {
    list: (status?: CourseStatus) =>
      request<{ courses: Course[] }>(`/admin/courses${queryString({ status })}`),
    get: (id: number) => request<{ course: Course }>(`/admin/courses/${id}`),
    create: (body: { title: string; description?: string; lessons?: Array<{ title: string; items: CourseItem[] }> }) =>
      request<{ course: Course }>(`/admin/courses`, { method: "POST", body: JSON.stringify(body) }),
    update: (id: number, body: { title?: string; description?: string }) =>
      request<{ course: Course }>(`/admin/courses/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    delete: (id: number) => request<void>(`/admin/courses/${id}`, { method: "DELETE" }),
    publish: (id: number) =>
      request<{ course: Course }>(`/admin/courses/${id}/publish`, { method: "POST" }),
    unpublish: (id: number) =>
      request<{ course: Course }>(`/admin/courses/${id}/unpublish`, { method: "POST" }),
    addLesson: (id: number, body: { title: string; items: CourseItem[] }) =>
      request<{ course: Course }>(`/admin/courses/${id}/lessons`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateLesson: (courseId: number, lessonId: number, body: { title?: string; items?: CourseItem[] }) =>
      request<{ course: Course }>(`/admin/courses/${courseId}/lessons/${lessonId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    deleteLesson: (courseId: number, lessonId: number) =>
      request<{ course: Course }>(`/admin/courses/${courseId}/lessons/${lessonId}`, {
        method: "DELETE",
      }),
    getSchedule: (id: number) => request<{ schedule: Schedule | null }>(`/admin/courses/${id}/schedule`),
    setSchedule: (id: number, schedule: Schedule & { kind: "daily" | "custom" }) =>
      request<{ schedule: Schedule }>(`/admin/courses/${id}/schedule`, {
        method: "PUT",
        body: JSON.stringify(schedule),
      }),
    deleteSchedule: (id: number) =>
      request<void>(`/admin/courses/${id}/schedule`, { method: "DELETE" }),
  },
  learners: {
    list: (params: { courseId?: number; status?: EnrollmentStatus; optedOut?: boolean; search?: string; page?: number; pageSize?: number } = {}) =>
      request<{ learners: Learner[] } & PageResult>(`/admin/learners${queryString(params)}`),
    get: (id: number) => request<LearnerDetail>(`/admin/learners/${id}`),
  },
  enrollments: {
    list: (params: { courseId?: number; status?: EnrollmentStatus; page?: number; pageSize?: number } = {}) =>
      request<{ enrollments: Enrollment[] } & PageResult>(`/admin/enrollments${queryString(params)}`),
    create: (body: { phone: string; courseId: number; consent: true }) =>
      request<{ enrollment: Enrollment; created: boolean }>("/admin/enrollments", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    pause: (id: number) =>
      request<{ ok: true; status: "paused" }>(`/admin/enrollments/${id}/pause`, { method: "POST" }),
    resume: (id: number) =>
      request<{ ok: true; status: "active" }>(`/admin/enrollments/${id}/resume`, { method: "POST" }),
    getSchedule: (id: number) => request<{ schedule: Schedule | null }>(`/admin/enrollments/${id}/schedule`),
    setSchedule: (id: number, schedule: Partial<Schedule>) =>
      request<{ schedule: Schedule }>(`/admin/enrollments/${id}/schedule`, {
        method: "PUT",
        body: JSON.stringify(schedule),
      }),
  },
  scheduleDefaults: {
    get: () => request<{ defaults: { timezone: string; dailyTime: string | null; graceHours: number } }>("/admin/schedule-defaults"),
    set: (schedule: { timezone?: string; dailyTime?: string | null; graceHours?: number }) =>
      request<{ defaults: { timezone: string; dailyTime: string | null; graceHours: number } }>("/admin/schedule-defaults", {
        method: "PUT",
        body: JSON.stringify(schedule),
      }),
  },
  schedulePreview: (enrollmentId: number, count = 5) =>
    request<{ times: Array<{ utc: string; local: string }>; timezone?: string; note?: string }>(
      `/admin/schedule-preview${queryString({ enrollmentId, count })}`,
    ),
  delivery: {
    list: (params: { status?: string; courseId?: number; learnerId?: number; page?: number; pageSize?: number } = {}) =>
      request<{ messages: DeliveryMessage[] } & PageResult>(`/admin/delivery${queryString(params)}`),
    get: (id: number) =>
      request<DeliveryMessage & { attemptCount: number; attempts: Array<{ attemptNo: number; status: string; providerMessageId: string | null; errorCode: string | null }>; messages?: Array<{ text?: string; mediaUrl?: string }> }>(
        `/admin/delivery/${id}`,
      ),
  },
  certificates: {
    list: (params: { courseId?: number; status?: EnrollmentStatus; page?: number; pageSize?: number } = {}) =>
      request<{ certificates: Array<{ id: number; code: string; learnerName: string; courseTitle: string; issuedAt: string; enrollmentId: number }> } & PageResult>(
        `/admin/certificates${queryString(params)}`,
      ),
    resend: (id: number) =>
      request<{ ok: true; messageId: number }>(`/admin/certificates/${id}/resend`, { method: "POST" }),
  },
  users: {
    list: (org?: string) => request<{ users: User[] }>(`/admin/users${queryString({ org })}`),
    create: (body: { name: string; role: AdminRole; org?: string }) =>
      request<{ user: User; apiKey: string; keyId: number; prefix: string }>("/admin/users", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    rotate: (id: number) =>
      request<{ apiKey: string; keyId: number; prefix: string; revoked: number }>(
        `/admin/users/${id}/keys`,
        { method: "POST", body: "{}" },
      ),
    revoke: (id: number, keyId: number) =>
      request<void>(`/admin/users/${id}/keys/${keyId}`, { method: "DELETE" }),
    recover: (id: number) =>
      request<{ apiKey: string; keyId: number; prefix: string; revoked: number }>(
        `/admin/users/${id}/recover`,
        { method: "POST", body: "{}" },
      ),
  },
  audit: (org?: string) => request<{ entries: AuditEntry[] }>(`/admin/audit${queryString({ org })}`),
  failures: {
    list: (params: { kind?: "inbound" | "outbound"; status?: "open" | "replayed" | "discarded"; limit?: number } = {}) =>
      request<{ failures: Failure[]; counts: FailureCount[] }>(`/admin/failures${queryString(params)}`),
    get: (id: number) => request<{ failure: Failure; attempts: Array<{ attemptNo: number; status: string; providerMessageId: string | null; errorCode: string | null }>; event: unknown | null }>(`/admin/failures/${id}`),
    replay: (id: number, note = "") =>
      request<{ replayed: true }>(`/admin/failures/${id}/replay`, {
        method: "POST",
        body: JSON.stringify({ note }),
      }),
    discard: (id: number, reason: string) =>
      request<{ discarded: true }>(`/admin/failures/${id}/discard`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  },
  status: {
    readiness: () => request<Record<string, unknown>>("/ready"),
    worker: () => request<Record<string, unknown>>("/worker-status"),
  },
};
