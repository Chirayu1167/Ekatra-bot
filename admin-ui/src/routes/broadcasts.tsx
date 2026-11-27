"use client";

import * as React from "react";
import ExcelJS from "exceljs";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  adminApi,
  MAX_BROADCAST_RECIPIENTS,
  type BroadcastAudience,
  type BroadcastEnrollmentStatus,
  type BroadcastPreview,
  type BroadcastRejectionReason,
} from "@/api/admin";
import { useAuth } from "@/api/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConsoleShell, ErrorState } from "@/components/console/shared";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

export const Route = createFileRoute("/broadcasts")({
  component: BroadcastsScreen,
});

const REJECTION_LABELS: Record<BroadcastRejectionReason, string> = {
  invalid_number: "Invalid international number",
  duplicate: "Duplicate number",
  not_enrolled: "Not a registered learner",
  not_active: "Enrollment is not active",
  consent_missing: "No recorded consent",
  opted_out: "Learner opted out (STOP)",
  outside_window_template_required:
    "Hasn't messaged in 24 hours and no approved broadcast template is set (TWILIO_CONTENT_SID_BROADCAST)",
  course_unavailable: "Course is unavailable",
};

const AUDIENCE_OPTIONS: Array<{ value: BroadcastAudience; title: string; hint: string }> = [
  { value: "course", title: "Learners of a course", hint: "Everyone who registered for the selected course." },
  { value: "all_learners", title: "All registered learners", hint: "Everyone registered in any course." },
  { value: "numbers", title: "Specific numbers only", hint: "Type or import any numbers, registered or not." },
];

const STATUS_OPTIONS: Array<{ value: BroadcastEnrollmentStatus; label: string }> = [
  { value: "pending", label: "Registered, not started" },
  { value: "active", label: "In progress" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
];

function firstColumnPhones(fileRows: string[]): string[] {
  const rows = fileRows.map((row) => row.trim()).filter(Boolean);
  if (rows.length && ["phone", "phone number", "mobile", "mobile number"].includes(rows[0]!.toLowerCase())) {
    rows.shift();
  }
  return rows;
}

async function readPhoneWorkbook(file: File): Promise<string[]> {
  if (file.size > 2 * 1024 * 1024) throw new Error("Choose a workbook smaller than 2 MB.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The workbook has no sheets.");
  if (worksheet.rowCount > MAX_BROADCAST_RECIPIENTS + 1) {
    throw new Error(`A broadcast is limited to ${MAX_BROADCAST_RECIPIENTS} numbers.`);
  }
  const phones = firstColumnPhones(
    Array.from({ length: worksheet.rowCount }, (_, index) => worksheet.getCell(index + 1, 1).text),
  );
  if (phones.length === 0) throw new Error("No phone numbers found in the first column.");
  if (phones.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`A broadcast is limited to ${MAX_BROADCAST_RECIPIENTS} numbers.`);
  }
  return phones;
}

function rejectionText(preview: BroadcastPreview): string {
  return preview.rejected
    .map(({ reason, count }) => `${REJECTION_LABELS[reason]}: ${count}`)
    .join("; ");
}

function BroadcastsScreen() {
  const { session } = useAuth();
  const canManage = session?.role === "org_admin" || session?.role === "platform_admin";
  const [audience, setAudience] = React.useState<BroadcastAudience>("course");
  const [courseId, setCourseId] = React.useState("");
  const [statuses, setStatuses] = React.useState<BroadcastEnrollmentStatus[]>(
    STATUS_OPTIONS.map((option) => option.value),
  );
  const [message, setMessage] = React.useState("");
  const [manualNumbers, setManualNumbers] = React.useState("");
  const [fileNumbers, setFileNumbers] = React.useState<string[]>([]);
  const [fileLabel, setFileLabel] = React.useState("");
  const [inputError, setInputError] = React.useState("");
  const [preview, setPreview] = React.useState<BroadcastPreview | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [queued, setQueued] = React.useState(false);

  const courses = useQuery({
    queryKey: ["broadcast-courses"],
    queryFn: () => adminApi.courses.list("published"),
    enabled: canManage,
  });
  const usesRoster = audience !== "numbers";
  const rosterCourseId = audience === "course" && courseId ? Number(courseId) : undefined;
  const counts = useQuery({
    queryKey: ["broadcast-audience", audience, rosterCourseId ?? null],
    queryFn: () => adminApi.broadcasts.audience(rosterCourseId),
    enabled: canManage && usesRoster && (audience === "all_learners" || rosterCourseId !== undefined),
  });
  const phoneNumbers = React.useMemo(
    () => [...manualNumbers.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), ...fileNumbers],
    [manualNumbers, fileNumbers],
  );
  const rosterSize = counts.data
    ? statuses.reduce((sum, status) => sum + counts.data[status], 0)
    : undefined;

  const resetPreview = () => {
    setPreview(null);
    setQueued(false);
    setConfirming(false);
  };

  const previewMutation = useMutation({
    mutationFn: () =>
      adminApi.broadcasts.preview({
        audience,
        courseId: courseId ? Number(courseId) : undefined,
        statuses: usesRoster ? statuses : undefined,
        message: message.trim(),
        phoneNumbers,
      }),
    onSuccess: (result) => {
      setPreview(result);
      setQueued(false);
      setConfirming(false);
    },
  });
  const queueMutation = useMutation({
    mutationFn: () => adminApi.broadcasts.queue(preview!.id),
    onSuccess: () => {
      setQueued(true);
      setConfirming(false);
    },
  });
  const status = useQuery({
    queryKey: ["broadcast-status", preview?.id],
    queryFn: () => adminApi.broadcasts.status(preview!.id),
    enabled: Boolean(preview && queued),
    refetchInterval: (query) => {
      const current = query.state.data;
      return current && current.queued + current.sending > 0 ? 3000 : false;
    },
  });

  const handleWorkbook = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setInputError("");
    setFileNumbers([]);
    setFileLabel("");
    try {
      const phones = await readPhoneWorkbook(file);
      setFileNumbers(phones);
      setFileLabel(`${file.name} (${phones.length} numbers)`);
      resetPreview();
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "The workbook could not be read.");
    }
  };

  const toggleStatus = (value: BroadcastEnrollmentStatus) => {
    setStatuses((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
    resetPreview();
  };

  const audienceReady =
    audience === "numbers"
      ? phoneNumbers.length > 0
      : (audience === "course" ? Boolean(courseId) : true) &&
        statuses.length > 0 &&
        (phoneNumbers.length > 0 || rosterSize !== 0);
  const tooMany = phoneNumbers.length > MAX_BROADCAST_RECIPIENTS;

  const requestPreview = () => {
    setInputError("");
    setPreview(null);
    previewMutation.mutate();
  };

  if (!canManage) {
    return (
      <ConsoleShell title="Broadcasts">
        <ErrorState message="Broadcasts are available to organisation admins only." />
      </ConsoleShell>
    );
  }

  const rejectedTotal = preview ? preview.rejected.reduce((sum, item) => sum + item.count, 0) : 0;

  return (
    <ConsoleShell title="Broadcast & Invitations">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Send a WhatsApp notice or invitation to a course's registered learners, to everyone registered, or to any
        numbers you type or import from Excel.
      </p>

      {courses.isError && <ErrorState message={errorMessage(courses.error)} />}
      {previewMutation.isError && <ErrorState message={errorMessage(previewMutation.error)} />}
      {queueMutation.isError && <ErrorState message={errorMessage(queueMutation.error)} />}
      {status.isError && <ErrorState message={errorMessage(status.error)} />}
      {inputError && <ErrorState message={inputError} />}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.8fr)]">
        <Card>
          <CardContent className="space-y-5 p-5">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Send to</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {AUDIENCE_OPTIONS.map((option) => (
                  <label
                    className={`cursor-pointer rounded-md border p-3 text-sm ${audience === option.value ? "border-primary bg-primary/5" : ""}`}
                    key={option.value}
                  >
                    <input
                      checked={audience === option.value}
                      className="mr-2"
                      name="broadcast-audience"
                      onChange={() => {
                        setAudience(option.value);
                        resetPreview();
                      }}
                      type="radio"
                      value={option.value}
                    />
                    <span className="font-medium">{option.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{option.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {audience !== "all_learners" && (
              <label className="block space-y-2 text-sm font-medium">
                {audience === "course" ? "Course" : "Course (optional, for reporting)"}
                <select
                  aria-label="Course"
                  className="h-10 w-full rounded-md border bg-background px-3 font-normal"
                  onChange={(event) => {
                    setCourseId(event.target.value);
                    resetPreview();
                  }}
                  value={courseId}
                >
                  <option value="">{audience === "course" ? "Select a published course" : "No course"}</option>
                  {(courses.data?.courses ?? []).map((course) => (
                    <option key={course.id} value={course.id}>{course.title}</option>
                  ))}
                </select>
              </label>
            )}

            {usesRoster && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Learner status</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {STATUS_OPTIONS.map((option) => (
                    <label className="flex items-center gap-2 text-sm" key={option.value}>
                      <input
                        checked={statuses.includes(option.value)}
                        onChange={() => toggleStatus(option.value)}
                        type="checkbox"
                      />
                      {option.label}
                      {counts.data && (
                        <span className="text-xs text-muted-foreground">({counts.data[option.value]})</span>
                      )}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground" role="status">
                  {audience === "course" && !courseId
                    ? "Choose a course to see who is registered."
                    : counts.isLoading
                      ? "Counting registered learners…"
                      : rosterSize !== undefined
                        ? `${rosterSize} registered learner${rosterSize === 1 ? "" : "s"} selected before opt-out and window checks.`
                        : ""}
                </p>
              </fieldset>
            )}

            <label className="block space-y-2 text-sm font-medium">
              Message
              <textarea
                aria-label="Message"
                className="min-h-32 w-full resize-y rounded-md border bg-background p-3 font-normal"
                maxLength={1024}
                onChange={(event) => {
                  setMessage(event.target.value);
                  resetPreview();
                }}
                placeholder="Write a short update or invitation"
                value={message}
              />
              <span className="block text-xs font-normal text-muted-foreground">
                {message.length}/1024 characters
              </span>
            </label>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="manual-broadcast-numbers">
                {usesRoster ? "Extra phone numbers (optional)" : "Phone numbers"}
              </label>
              <textarea
                id="manual-broadcast-numbers"
                className="min-h-24 w-full resize-y rounded-md border bg-background p-3 text-sm"
                onChange={(event) => {
                  setManualNumbers(event.target.value);
                  resetPreview();
                }}
                placeholder={"+919876543210\n+14155550123"}
                value={manualNumbers}
              />
              <p className="text-xs text-muted-foreground">Use one international number (+country code) per line.</p>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="broadcast-workbook">
                Import an Excel file
              </label>
              <input
                accept=".xlsx"
                aria-label="Import an Excel file"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-3 file:py-2"
                id="broadcast-workbook"
                onChange={(event) => void handleWorkbook(event)}
                type="file"
              />
              <p className="text-xs text-muted-foreground">
                The first sheet's first column must contain numbers; an optional header may be “Phone”.
                {fileLabel && ` Imported: ${fileLabel}.`}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <span className="text-sm text-muted-foreground">
                {phoneNumbers.length} typed/imported number{phoneNumbers.length === 1 ? "" : "s"} (max {MAX_BROADCAST_RECIPIENTS} per broadcast)
              </span>
              <Button
                disabled={
                  !message.trim() || !audienceReady || tooMany ||
                  previewMutation.isPending || queueMutation.isPending
                }
                onClick={requestPreview}
              >
                {previewMutation.isPending ? "Checking recipients…" : "Review recipients"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-5">
              <h2 className="font-semibold">Delivery rules</h2>
              <p className="text-sm text-muted-foreground">
                Anyone with a valid number can be messaged, registered or not. People who sent STOP are always excluded.
              </p>
              <p className="text-sm text-muted-foreground">
                Free-form text is only delivered within 24 hours of the person's last WhatsApp message to you.
                Otherwise an approved broadcast template is used; without one those numbers are not sent.
              </p>
              <p className="text-sm text-muted-foreground">
                Review the counts before queueing. Opt-outs and the 24-hour window are checked again right before each send.
              </p>
            </CardContent>
          </Card>

          {preview && (
            <Card>
              <CardContent className="space-y-4 p-5">
                <h2 className="font-semibold">Recipient review</h2>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">Eligible</dt><dd className="text-lg font-semibold">{preview.acceptedCount}</dd></div>
                  <div><dt className="text-muted-foreground">Via template</dt><dd className="text-lg font-semibold">{preview.templateCount}</dd></div>
                  <div><dt className="text-muted-foreground">Not eligible</dt><dd className="text-lg font-semibold">{rejectedTotal}</dd></div>
                </dl>
                {preview.rejected.length > 0 ? (
                  <ul aria-label="Rejected recipient reasons" className="space-y-1 border-t pt-3 text-sm">
                    {preview.rejected.map(({ reason, count }) => (
                      <li className="flex justify-between gap-3" key={reason}>
                        <span className="text-muted-foreground">{REJECTION_LABELS[reason]}</span><span>{count}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-t pt-3 text-sm text-muted-foreground">Every selected number can receive this message.</p>
                )}
                {!preview.templateConfigured &&
                  preview.rejected.some((item) => item.reason === "outside_window_template_required") && (
                    <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground" role="note">
                      Numbers that haven't messaged in the last 24 hours need an approved WhatsApp template.
                      Set <code>TWILIO_CONTENT_SID_BROADCAST</code> on the server to reach them.
                    </p>
                  )}
                <p className="text-xs text-muted-foreground">Phone numbers are not shown in the server review.</p>
                {queued ? (
                  <div className="space-y-3 border-t pt-3" aria-live="polite">
                    <h3 className="font-medium">Broadcast status</h3>
                    {status.data ? (
                      <p className="text-sm text-muted-foreground">
                        {status.data.queued} queued · {status.data.sending} sending · {status.data.sent} sent ·
                        {" "}{status.data.delivered} delivered · {status.data.read} read · {status.data.failed} failed ·
                        {" "}{status.data.unknown} uncertain · {status.data.skipped} skipped
                      </p>
                    ) : <p className="text-sm text-muted-foreground" role="status">Loading status…</p>}
                    <p className="text-xs text-muted-foreground">Delivery receipts do not indicate course learning or completion.</p>
                  </div>
                ) : (
                  <Button
                    className="w-full"
                    disabled={preview.acceptedCount === 0 || queueMutation.isPending}
                    onClick={() => setConfirming(true)}
                  >
                    {queueMutation.isPending ? "Queueing…" : `Queue ${preview.acceptedCount} messages`}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      {confirming && preview && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation">
          <section aria-labelledby="broadcast-confirm-title" aria-modal="true" className="w-full max-w-md space-y-4 rounded-lg bg-background p-6 shadow-xl" role="dialog">
            <h2 className="text-lg font-semibold" id="broadcast-confirm-title">Queue this broadcast?</h2>
            <p className="text-sm text-muted-foreground">
              This queues {preview.acceptedCount} WhatsApp message{preview.acceptedCount === 1 ? "" : "s"}.
              Opt-outs and the 24-hour window are checked again by the worker before each send.
            </p>
            <div className="flex justify-end gap-2">
              <Button disabled={queueMutation.isPending} onClick={() => setConfirming(false)} variant="outline">Cancel</Button>
              <Button disabled={queueMutation.isPending} onClick={() => queueMutation.mutate()}>
                {queueMutation.isPending ? "Queueing…" : "Confirm queue"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </ConsoleShell>
  );
}
