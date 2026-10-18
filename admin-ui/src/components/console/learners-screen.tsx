import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, type EnrollmentStatus, type Learner } from "@/api/admin";
import { useAuth } from "@/api/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConsoleShell, DataTable, EmptyState, ErrorState, LoadingState, StatusBadge } from "./shared";

const PAGE_SIZE = 20;
const statuses: EnrollmentStatus[] = ["pending", "active", "paused", "completed"];
const mask = (phone: string) => `•••• ${phone.replace(/\D/g, "").slice(-4)}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request failed. Please try again.";

export function LearnersScreen() {
  const { session } = useAuth();
  const isAdmin = session?.role === "org_admin" || session?.role === "platform_admin";
  const client = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [courseId, setCourseId] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [optedOut, setOptedOut] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [enrolling, setEnrolling] = React.useState(false);
  const [phone, setPhone] = React.useState("");
  const [newCourseId, setNewCourseId] = React.useState("");
  const [consent, setConsent] = React.useState(false);
  const [actionError, setActionError] = React.useState("");
  const courses = useQuery({ queryKey: ["courses", "learner-filter"], queryFn: () => adminApi.courses.list() });
  const params = {
    search: search.trim() || undefined,
    courseId: courseId ? Number(courseId) : undefined,
    status: (status || undefined) as EnrollmentStatus | undefined,
    optedOut: optedOut === "" ? undefined : optedOut === "true",
    page,
    pageSize: PAGE_SIZE,
  };
  const learners = useQuery({ queryKey: ["learners", params], queryFn: () => adminApi.learners.list(params) });
  const detail = useQuery({
    queryKey: ["learner", selectedId],
    queryFn: () => adminApi.learners.get(selectedId as number),
    enabled: selectedId !== null,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["learners"] });
  const enroll = useMutation({
    mutationFn: () => adminApi.enrollments.create({ phone: phone.trim(), courseId: Number(newCourseId), consent: true }),
    onSuccess: async () => { setPhone(""); setNewCourseId(""); setConsent(false); setEnrolling(false); setActionError(""); await refresh(); },
    onError: (error) => setActionError(errorMessage(error)),
  });
  const changeEnrollment = useMutation<{ ok: true; status: "paused" | "active" }, Error, { id: number; action: "pause" | "resume" }>({
    mutationFn: ({ id, action }: { id: number; action: "pause" | "resume" }) =>
      action === "pause" ? adminApi.enrollments.pause(id) : adminApi.enrollments.resume(id),
    onSuccess: async () => { setActionError(""); await refresh(); await detail.refetch(); },
    onError: (error) => setActionError(errorMessage(error)),
  });
  const rows = learners.data?.learners ?? [];

  return (
    <ConsoleShell title="Learners">
      {actionError && <ErrorState message={actionError} />}
      <div className="flex flex-wrap gap-3">
        <Input aria-label="Search learners by name or last four digits" className="max-w-sm" onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search name or last 4 digits" value={search} />
        <select aria-label="Filter by course" className="h-10 rounded-md border bg-background px-3 text-sm" onChange={(event) => { setCourseId(event.target.value); setPage(1); }} value={courseId}>
          <option value="">All courses</option>{(courses.data?.courses ?? []).map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}
        </select>
        <select aria-label="Filter by status" className="h-10 rounded-md border bg-background px-3 text-sm" onChange={(event) => { setStatus(event.target.value); setPage(1); }} value={status}>
          <option value="">All statuses</option>{statuses.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select aria-label="Filter opted out" className="h-10 rounded-md border bg-background px-3 text-sm" onChange={(event) => { setOptedOut(event.target.value); setPage(1); }} value={optedOut}>
          <option value="">All opt-out states</option><option value="true">Opted out</option><option value="false">Not opted out</option>
        </select>
        {isAdmin && <Button onClick={() => { setEnrolling((value) => !value); setActionError(""); }}>{enrolling ? "Cancel enrollment" : "Enroll learner"}</Button>}
      </div>
      {enrolling && isAdmin && <form className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); if (consent && newCourseId) enroll.mutate(); }}>
        <label className="space-y-1 text-sm">WhatsApp phone number<Input autoComplete="off" inputMode="tel" onChange={(event) => setPhone(event.target.value)} required value={phone} /></label>
        <label className="space-y-1 text-sm">Course<select className="h-10 w-full rounded-md border bg-background px-3" onChange={(event) => setNewCourseId(event.target.value)} required value={newCourseId}><option value="">Select course</option>{(courses.data?.courses ?? []).map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
        <label className="flex items-center gap-2 self-end text-sm"><input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />This person agreed to receive this course as WhatsApp messages.</label>
        <Button className="md:col-start-3" disabled={!consent || !newCourseId || enroll.isPending} type="submit">Enroll</Button>
      </form>}
      {learners.isLoading ? <LoadingState>Loading learners…</LoadingState>
        : learners.isError ? <ErrorState message={errorMessage(learners.error)} />
          : rows.length === 0 ? <EmptyState>No learners match these filters.</EmptyState>
            : <DataTable<Learner>
              columns={[
                { key: "name", label: "Learner", render: (row) => <button className="font-medium underline-offset-4 hover:underline" onClick={() => { setSelectedId(row.id); setRevealed(false); }} type="button">{row.name || "Unnamed learner"}</button> },
                { key: "phone", label: "Phone", render: (row) => <span>{mask(row.phone)}</span> },
                { key: "course", label: "Course", render: (row) => row.course },
                { key: "progress", label: "Progress", render: (row) => row.progress },
                { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} /> },
                { key: "optedOut", label: "Opted out", render: (row) => row.optedOut ? "Yes" : "No" },
              ]}
              onPageChange={setPage}
              page={learners.data?.page ?? page}
              pageSize={learners.data?.pageSize ?? PAGE_SIZE}
              rowKey={(row) => row.id}
              rows={rows}
              total={learners.data?.total ?? 0}
            />}

      {selectedId !== null && <section aria-label="Learner details" className="space-y-4 rounded-lg border p-5">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Learner details</h2><Button onClick={() => setSelectedId(null)} variant="outline">Close</Button></div>
        {detail.isLoading ? <LoadingState>Loading learner details…</LoadingState>
          : detail.isError ? <ErrorState message={errorMessage(detail.error)} />
            : detail.data && <>
              <p>{detail.data.name || "Unnamed learner"} · {revealed && isAdmin ? detail.data.phone : mask(detail.data.phone)}</p>
              {isAdmin && <Button onClick={() => setRevealed((value) => !value)} type="button" variant="outline">{revealed ? "Hide number" : "Show number"}</Button>}
              {detail.data.optedOut && <StatusBadge status="opted out" />}
              <div className="space-y-2">{detail.data.enrollments.map((entry) => <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-3" key={entry.id}>
                <span>{entry.courseTitle} · {entry.progress} delivered</span><StatusBadge status={entry.status} />
                {isAdmin && entry.status !== "completed" && <Button disabled={changeEnrollment.isPending} onClick={() => changeEnrollment.mutate({ id: entry.id, action: entry.status === "paused" ? "resume" : "pause" })} type="button" variant="outline">{entry.status === "paused" ? "Resume" : "Pause"}</Button>}
              </div>)}</div>
            </>}
      </section>}
    </ConsoleShell>
  );
}
