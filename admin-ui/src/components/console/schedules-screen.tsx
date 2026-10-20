import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, type Schedule } from "@/api/admin";
import { useAuth } from "@/api/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConsoleShell } from "@/components/console/console-shell";
import { EmptyState, ErrorState, LoadingState } from "./shared";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const maskPhone = (value: string) => `•••• ${value.replace(/\D/g, "").slice(-4)}`;
const zones = (() => {
  try { return Intl.supportedValuesOf("timeZone"); }
  catch { return ["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Kolkata"]; }
})();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request failed. Please try again.";

export function SchedulesScreen() {
  const { session } = useAuth();
  const client = useQueryClient();
  const canManage = session?.role === "org_admin" || session?.role === "platform_admin";
  const [courseId, setCourseId] = React.useState("");
  const [enrollmentId, setEnrollmentId] = React.useState("");
  const [kind, setKind] = React.useState<"daily" | "custom">("daily");
  const [courseDailyTime, setCourseDailyTime] = React.useState("09:00");
  const [enrollmentDailyTime, setEnrollmentDailyTime] = React.useState("09:00");
  const [defaultDailyTime, setDefaultDailyTime] = React.useState("09:00");
  const [courseTimezone, setCourseTimezone] = React.useState("UTC");
  const [enrollmentTimezone, setEnrollmentTimezone] = React.useState("UTC");
  const [defaultTimezone, setDefaultTimezone] = React.useState("UTC");
  const [courseSlots, setCourseSlots] = React.useState<Array<{ dow: number; time: string }>>([]);
  const [enrollmentSlots, setEnrollmentSlots] = React.useState<Array<{ dow: number; time: string }>>([]);
  const [enabled, setEnabled] = React.useState(true);
  const [graceHours, setGraceHours] = React.useState(24);
  const [screenError, setScreenError] = React.useState("");
  const courses = useQuery({ queryKey: ["courses", "schedule"], queryFn: () => adminApi.courses.list(), enabled: canManage });
  const enrollments = useQuery({ queryKey: ["enrollments", "schedule"], queryFn: () => adminApi.enrollments.list({ page: 1, pageSize: 100 }), enabled: canManage });
  const courseSchedule = useQuery({
    queryKey: ["course-schedule", courseId],
    queryFn: () => adminApi.courses.getSchedule(Number(courseId)),
    enabled: !!courseId && canManage,
  });
  const enrollmentSchedule = useQuery({
    queryKey: ["enrollment-schedule", enrollmentId],
    queryFn: () => adminApi.enrollments.getSchedule(Number(enrollmentId)),
    enabled: !!enrollmentId && canManage,
  });
  const defaults = useQuery({ queryKey: ["schedule-defaults"], queryFn: adminApi.scheduleDefaults.get, enabled: canManage });
  const preview = useQuery({
    queryKey: ["schedule-preview", enrollmentId],
    queryFn: () => adminApi.schedulePreview(Number(enrollmentId), 5),
    enabled: !!enrollmentId && canManage,
  });
  React.useEffect(() => {
    const schedule = courseSchedule.data?.schedule;
    if (schedule) {
      setKind(schedule.kind ?? (schedule.slots.length ? "custom" : "daily"));
      setCourseDailyTime(schedule.dailyTime ?? "09:00");
      setCourseTimezone(schedule.timezone);
      setCourseSlots(schedule.slots);
    } else if (courseId && courseSchedule.isSuccess) {
      setKind("daily"); setCourseDailyTime("09:00"); setCourseTimezone("UTC"); setCourseSlots([]);
    }
  }, [courseId, courseSchedule.data, courseSchedule.isSuccess]);
  React.useEffect(() => {
    const schedule = enrollmentSchedule.data?.schedule;
    if (schedule) {
      setEnrollmentDailyTime(schedule.dailyTime ?? "09:00");
      setEnrollmentTimezone(schedule.timezone);
      setEnrollmentSlots(schedule.slots);
      setEnabled(schedule.enabled ?? true);
    } else if (enrollmentId && enrollmentSchedule.isSuccess) {
      setEnrollmentDailyTime("09:00");
      setEnrollmentTimezone("UTC");
      setEnrollmentSlots([]);
      setEnabled(true);
    }
  }, [enrollmentId, enrollmentSchedule.data, enrollmentSchedule.isSuccess]);
  React.useEffect(() => {
    const value = defaults.data?.defaults;
    if (value) {
      setDefaultTimezone(value.timezone);
      setDefaultDailyTime(value.dailyTime ?? "09:00");
      setGraceHours(value.graceHours);
    }
  }, [defaults.data]);
  const refreshCourse = () => Promise.all([
    client.invalidateQueries({ queryKey: ["course-schedule", courseId] }),
    client.invalidateQueries({ queryKey: ["schedule-preview", enrollmentId] }),
  ]);
  const saveCourse = useMutation({
    mutationFn: () => adminApi.courses.setSchedule(Number(courseId), {
      kind, dailyTime: kind === "daily" ? courseDailyTime : null, slots: kind === "custom" ? courseSlots : [], timezone: courseTimezone,
    }),
    onSuccess: async () => { setScreenError(""); await refreshCourse(); },
    onError: (error) => setScreenError(errorMessage(error)),
  });
  const saveEnrollment = useMutation({
    mutationFn: () => adminApi.enrollments.setSchedule(Number(enrollmentId), {
      timezone: enrollmentTimezone, dailyTime: enrollmentSlots.length ? null : enrollmentDailyTime, slots: enrollmentSlots, enabled,
    }),
    onSuccess: async () => {
      setScreenError("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["enrollment-schedule", enrollmentId] }),
        client.invalidateQueries({ queryKey: ["schedule-preview", enrollmentId] }),
      ]);
    },
    onError: (error) => setScreenError(errorMessage(error)),
  });
  const saveDefaults = useMutation({
    mutationFn: () => adminApi.scheduleDefaults.set({ timezone: defaultTimezone, dailyTime: defaultDailyTime, graceHours }),
    onSuccess: async () => { setScreenError(""); await client.invalidateQueries({ queryKey: ["schedule-defaults"] }); },
    onError: (error) => setScreenError(errorMessage(error)),
  });
  const addCourseSlot = () => setCourseSlots((current) => [...current, { dow: 1, time: "09:00" }]);
  const addEnrollmentSlot = () => setEnrollmentSlots((current) => [...current, { dow: 1, time: "09:00" }]);

  if (!canManage) return <ConsoleShell title="Schedules"><ErrorState message="Schedules are not available to instructors." /></ConsoleShell>;
  return (
    <ConsoleShell title="Schedules">
      {screenError && <ErrorState message={screenError} />}
      {courses.isError && <ErrorState message={errorMessage(courses.error)} />}
      {enrollments.isError && <ErrorState message={errorMessage(enrollments.error)} />}
      {defaults.isError && <ErrorState message={errorMessage(defaults.error)} />}
      <section className="space-y-4 rounded-lg border p-5">
        <h2 className="text-lg font-semibold">Course schedule</h2>
        <label className="block max-w-lg space-y-1 text-sm">Course
          <select className="h-10 w-full rounded-md border bg-background px-3" onChange={(event) => setCourseId(event.target.value)} value={courseId}><option value="">Select course</option>{(courses.data?.courses ?? []).map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select>
        </label>
        {!courseId ? <EmptyState>Select a course to configure its send schedule.</EmptyState>
          : courseSchedule.isLoading ? <LoadingState>Loading course schedule…</LoadingState>
            : courseSchedule.isError ? <ErrorState message={errorMessage(courseSchedule.error)} />
              : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); saveCourse.mutate(); }}>
                <ScheduleFields kind={kind} setKind={setKind} dailyTime={courseDailyTime} setDailyTime={setCourseDailyTime} timezone={courseTimezone} setTimezone={setCourseTimezone} slots={courseSlots} setSlots={setCourseSlots} addSlot={addCourseSlot} />
                <Button disabled={saveCourse.isPending} type="submit">Save course schedule</Button>
              </form>}
      </section>

      <section className="space-y-4 rounded-lg border p-5">
        <h2 className="text-lg font-semibold">Enrollment schedule</h2>
        <label className="block max-w-lg space-y-1 text-sm">Enrollment
          <select className="h-10 w-full rounded-md border bg-background px-3" onChange={(event) => setEnrollmentId(event.target.value)} value={enrollmentId}><option value="">Select learner enrollment</option>{(enrollments.data?.enrollments ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.courseTitle} · {maskPhone(entry.userId)}</option>)}</select>
        </label>
        {!enrollmentId ? <EmptyState>Select an enrollment to configure an override and preview send times.</EmptyState>
          : enrollmentSchedule.isLoading ? <LoadingState>Loading enrollment schedule…</LoadingState>
            : enrollmentSchedule.isError ? <ErrorState message={errorMessage(enrollmentSchedule.error)} />
              : <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />Schedule enabled</label>
                <ScheduleFields kind={enrollmentSlots.length ? "custom" : "daily"} setKind={(value) => { if (value === "daily") setEnrollmentSlots([]); else if (!enrollmentSlots.length) addEnrollmentSlot(); }} dailyTime={enrollmentDailyTime} setDailyTime={setEnrollmentDailyTime} timezone={enrollmentTimezone} setTimezone={setEnrollmentTimezone} slots={enrollmentSlots} setSlots={setEnrollmentSlots} addSlot={addEnrollmentSlot} />
                <Button disabled={saveEnrollment.isPending} onClick={() => saveEnrollment.mutate()} type="button">Save enrollment schedule</Button>
                <div className="space-y-2 border-t pt-4">
                  <h3 className="font-medium">Next send times</h3>
                  {preview.isLoading ? <LoadingState>Calculating next times…</LoadingState>
                    : preview.isError ? <ErrorState message={errorMessage(preview.error)} />
                      : (preview.data?.times.length ?? 0) === 0 ? <EmptyState>{preview.data?.note ?? "No upcoming send times."}</EmptyState>
                        : <ul className="space-y-1 text-sm">{preview.data?.times.map((time) => <li key={time.utc}>{time.local} · {time.utc} UTC</li>)}</ul>}
                </div>
              </div>}
      </section>

      <section className="space-y-4 rounded-lg border p-5">
        <h2 className="text-lg font-semibold">Organisation defaults</h2>
        {defaults.isLoading ? <LoadingState>Loading organisation defaults…</LoadingState>
          : defaults.isError ? <ErrorState message={errorMessage(defaults.error)} />
            : <form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => { event.preventDefault(); saveDefaults.mutate(); }}>
              <TimezoneField value={defaultTimezone} onChange={setDefaultTimezone} />
              <label className="space-y-1 text-sm">Daily send time<Input onChange={(event) => setDefaultDailyTime(event.target.value)} required type="time" value={defaultDailyTime} /></label>
              <label className="space-y-1 text-sm">Grace hours<Input max={72} min={1} onChange={(event) => setGraceHours(Number(event.target.value))} required type="number" value={graceHours} /></label>
              <Button className="md:col-span-3 md:justify-self-start" disabled={saveDefaults.isPending} type="submit">Save organisation defaults</Button>
            </form>}
      </section>
    </ConsoleShell>
  );
}

function ScheduleFields({
  kind, setKind, dailyTime, setDailyTime, timezone, setTimezone, slots, setSlots, addSlot,
}: {
  kind: "daily" | "custom";
  setKind: (kind: "daily" | "custom") => void;
  dailyTime: string;
  setDailyTime: (value: string) => void;
  timezone: string;
  setTimezone: (value: string) => void;
  slots: Array<{ dow: number; time: string }>;
  setSlots: (slots: Array<{ dow: number; time: string }>) => void;
  addSlot: () => void;
}) {
  return <div className="grid gap-3 md:grid-cols-2">
    <label className="space-y-1 text-sm">Schedule type<select className="h-10 w-full rounded-md border bg-background px-3" onChange={(event) => setKind(event.target.value as "daily" | "custom")} value={kind}><option value="daily">Daily</option><option value="custom">Custom days and times</option></select></label>
    <TimezoneField onChange={setTimezone} value={timezone} />
    {kind === "daily" ? <label className="space-y-1 text-sm">Daily send time<Input onChange={(event) => setDailyTime(event.target.value)} required type="time" value={dailyTime} /></label>
      : <div className="space-y-2 md:col-span-2">
        {slots.map((slot, index) => <div className="flex gap-2" key={`${index}-${slot.dow}`}>
          <select aria-label="Schedule day" className="h-10 rounded-md border bg-background px-3" onChange={(event) => setSlots(slots.map((value, i) => i === index ? { ...value, dow: Number(event.target.value) } : value))} value={slot.dow}>{WEEKDAYS.map((day, dow) => <option key={dow} value={dow}>{day}</option>)}</select>
          <Input aria-label="Schedule time" onChange={(event) => setSlots(slots.map((value, i) => i === index ? { ...value, time: event.target.value } : value))} required type="time" value={slot.time} />
          <Button onClick={() => setSlots(slots.filter((_, i) => i !== index))} type="button" variant="outline">Remove</Button>
        </div>)}
        <Button onClick={addSlot} type="button" variant="outline">Add day and time</Button>
      </div>}
  </div>;
}

function TimezoneField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="space-y-1 text-sm">IANA timezone
    <input className="h-10 w-full rounded-md border bg-background px-3" list="iana-timezones" onChange={(event) => onChange(event.target.value)} required value={value} />
    <datalist id="iana-timezones">{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
  </label>;
}
