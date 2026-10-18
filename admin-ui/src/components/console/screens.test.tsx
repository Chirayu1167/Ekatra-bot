import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import { CoursesScreen } from "./courses-screen";
import { LearnersScreen } from "./learners-screen";
import { SchedulesScreen } from "./schedules-screen";

const mockRole = vi.hoisted(() => ({ value: "org_admin" }));
const api = vi.hoisted(() => ({
  courseList: vi.fn(),
  courseGet: vi.fn(),
  courseCreate: vi.fn(),
  courseUpdate: vi.fn(),
  courseDelete: vi.fn(),
  coursePublish: vi.fn(),
  courseUnpublish: vi.fn(),
  lessonAdd: vi.fn(),
  lessonUpdate: vi.fn(),
  lessonDelete: vi.fn(),
  courseGetSchedule: vi.fn(),
  courseSetSchedule: vi.fn(),
  courseDeleteSchedule: vi.fn(),
  learnerList: vi.fn(),
  learnerGet: vi.fn(),
  enrollmentList: vi.fn(),
  enrollmentCreate: vi.fn(),
  enrollmentPause: vi.fn(),
  enrollmentResume: vi.fn(),
  enrollmentGetSchedule: vi.fn(),
  enrollmentSetSchedule: vi.fn(),
  defaultsGet: vi.fn(),
  defaultsSet: vi.fn(),
  preview: vi.fn(),
  organisations: vi.fn(),
}));

vi.mock("@/api/auth-context", () => ({
  useAuth: () => ({
    session: { id: 1, name: "Test user", role: mockRole.value, orgId: 1, orgSlug: "school" },
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
    courses: {
      list: api.courseList, get: api.courseGet, create: api.courseCreate, update: api.courseUpdate,
      delete: api.courseDelete, publish: api.coursePublish, unpublish: api.courseUnpublish,
      addLesson: api.lessonAdd, updateLesson: api.lessonUpdate, deleteLesson: api.lessonDelete,
      getSchedule: api.courseGetSchedule, setSchedule: api.courseSetSchedule, deleteSchedule: api.courseDeleteSchedule,
    },
    learners: { list: api.learnerList, get: api.learnerGet },
    enrollments: {
      list: api.enrollmentList, create: api.enrollmentCreate, pause: api.enrollmentPause,
      resume: api.enrollmentResume, getSchedule: api.enrollmentGetSchedule, setSchedule: api.enrollmentSetSchedule,
    },
    scheduleDefaults: { get: api.defaultsGet, set: api.defaultsSet },
    schedulePreview: api.preview,
  },
}));

const course = {
  id: 7, orgId: 1, slug: "health-basics", title: "Health Basics", description: "",
  status: "draft" as const, lessonCount: 0, createdAt: "", updatedAt: "",
};
const learner = {
  id: 11, name: "Ada", phone: "•••• 3210", course: "Health Basics", progress: 0,
  status: "active" as const, optedOut: false,
};
const screens = [
  { name: "Courses", component: CoursesScreen, load: api.courseList, empty: "No courses found.", success: "Health Basics" },
  { name: "Learners", component: LearnersScreen, load: api.learnerList, empty: "No learners match these filters.", success: "Ada" },
  { name: "Schedules", component: SchedulesScreen, load: api.courseList, empty: "Select a course to configure its send schedule.", success: "Health Basics" },
];

function renderScreen(Screen: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><Screen /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.value = "org_admin";
  api.courseList.mockResolvedValue({ courses: [course] });
  api.courseGet.mockResolvedValue({ course: { ...course, lessons: [] } });
  api.courseCreate.mockResolvedValue({ course });
  api.courseUpdate.mockResolvedValue({ course });
  api.courseDelete.mockResolvedValue(undefined);
  api.coursePublish.mockResolvedValue({ course });
  api.courseUnpublish.mockResolvedValue({ course });
  api.lessonAdd.mockResolvedValue({ course });
  api.lessonUpdate.mockResolvedValue({ course });
  api.lessonDelete.mockResolvedValue({ course });
  api.courseGetSchedule.mockResolvedValue({ schedule: null });
  api.courseSetSchedule.mockResolvedValue({ schedule: null });
  api.courseDeleteSchedule.mockResolvedValue(undefined);
  api.learnerList.mockResolvedValue({ learners: [learner], page: 1, pageSize: 20, total: 1 });
  api.learnerGet.mockResolvedValue({
    id: 11, name: "Ada", phone: "+15551233210", optedOut: false,
    enrollments: [{ id: 11, courseId: 7, courseTitle: "Health Basics", status: "active", progress: 0, startedAt: "", updatedAt: "", completedAt: null }],
  });
  api.enrollmentList.mockResolvedValue({ enrollments: [], page: 1, pageSize: 100, total: 0 });
  api.enrollmentCreate.mockResolvedValue({ enrollment: {}, created: true });
  api.enrollmentPause.mockResolvedValue({ ok: true, status: "paused" });
  api.enrollmentResume.mockResolvedValue({ ok: true, status: "active" });
  api.enrollmentGetSchedule.mockResolvedValue({ schedule: null });
  api.enrollmentSetSchedule.mockResolvedValue({ schedule: null });
  api.defaultsGet.mockResolvedValue({ defaults: { timezone: "UTC", dailyTime: "09:00", graceHours: 24 } });
  api.defaultsSet.mockResolvedValue({ defaults: { timezone: "UTC", dailyTime: "09:00", graceHours: 24 } });
  api.preview.mockResolvedValue({ times: [], note: "No schedule configured for this enrollment" });
  api.organisations.mockResolvedValue({ organisations: [] });
});

describe.each(screens)("$name screen states", ({ component, load, empty, success }) => {
  it("renders loading", () => {
    load.mockReturnValue(new Promise(() => undefined));
    renderScreen(component);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders errors clearly", async () => {
    load.mockRejectedValue(new Error("Service unavailable"));
    renderScreen(component);
    expect((await screen.findByRole("alert")).textContent).toContain("Service unavailable");
  });

  it("renders empty state", async () => {
    if (component === SchedulesScreen) {
      api.courseList.mockResolvedValue({ courses: [] });
    } else if (component === CoursesScreen) {
      api.courseList.mockResolvedValue({ courses: [] });
    } else {
      api.learnerList.mockResolvedValue({ learners: [], page: 1, pageSize: 20, total: 0 });
    }
    renderScreen(component);
    expect(await screen.findByText(empty)).toBeTruthy();
  });

  it("renders successful data", async () => {
    renderScreen(component);
    expect(await screen.findByText(success)).toBeTruthy();
  });
});

describe("learner screen permissions and consent", () => {
  it("masks learner numbers in schedule selectors", async () => {
    api.enrollmentList.mockResolvedValue({
      enrollments: [{ id: 11, userId: "whatsapp:+15551233210", courseId: 7, courseTitle: "Health Basics", status: "active", progress: 1, startedAt: "", updatedAt: "", completedAt: null }],
      page: 1,
      pageSize: 100,
      total: 1,
    });
    renderScreen(SchedulesScreen);
    expect(await screen.findByRole("option", { name: /•••• 3210/ })).toBeTruthy();
    expect(screen.queryByText("whatsapp:+15551233210")).toBeNull();
    expect(screen.queryByText("+15551233210")).toBeNull();
  });

  it("keeps the phone masked by default and only reveals it after an admin action", async () => {
    renderScreen(LearnersScreen);
    fireEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(await screen.findByText(/•••• 3210/)).toBeTruthy();
    expect(screen.queryByText("+15551233210")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Show number" }));
    expect(await screen.findByText(/\+15551233210/)).toBeTruthy();
  });

  it("shows instructors no action buttons and never offers number reveal", async () => {
    mockRole.value = "instructor";
    renderScreen(LearnersScreen);
    fireEvent.click(await screen.findByRole("button", { name: "Ada" }));
    expect(await screen.findByText(/•••• 3210/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show number" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enroll learner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("requires the consent checkbox before enrollment can be submitted", async () => {
    api.learnerList.mockResolvedValue({ learners: [], page: 1, pageSize: 20, total: 0 });
    renderScreen(LearnersScreen);
    fireEvent.click(await screen.findByRole("button", { name: "Enroll learner" }));
    fireEvent.change(screen.getByLabelText("WhatsApp phone number"), { target: { value: "+15551233210" } });
    fireEvent.change(screen.getByLabelText("Course"), { target: { value: "7" } });
    const submit = screen.getByRole("button", { name: "Enroll" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("This person agreed to receive this course as WhatsApp messages."));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});

it("shows instructors read-only course content without mutation controls", async () => {
  mockRole.value = "instructor";
  api.courseGet.mockResolvedValue({
    course: {
      ...course,
      lessons: [{ id: 3, courseId: 7, position: 1, title: "Lesson one", items: [{ kind: "text", text: "Read-only content" }] }],
    },
  });
  renderScreen(CoursesScreen);
  fireEvent.click(await screen.findByRole("button", { name: /Health Basics/ }));
  expect(await screen.findByText("Read-only content")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create course" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save course" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add lesson" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save lesson" })).toBeNull();
});

it("does not persist the admin key in localStorage", async () => {
  const { setApiKey, clearApiKey } = await import("@/api/session");
  clearApiKey();
  window.localStorage.clear();
  setApiKey("test-key", false);
  expect(window.localStorage.getItem("ek_api_key")).toBeNull();
  expect(window.sessionStorage.getItem("ek_api_key")).toBeNull();
  clearApiKey();
});
