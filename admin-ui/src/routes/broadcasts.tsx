"use client";

import * as React from "react";
import ExcelJS from "exceljs";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  adminApi,
  MAX_BROADCAST_RECIPIENTS,
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
  not_enrolled: "No enrollment in this course",
  not_active: "Enrollment is not active",
  consent_missing: "No recorded course consent",
  opted_out: "Learner opted out",
  outside_window_template_required: "Outside the 24-hour window; no approved template is configured",
  course_unavailable: "Course is unavailable",
};

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
  const [courseId, setCourseId] = React.useState("");
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
  const phoneNumbers = React.useMemo(
    () => [...manualNumbers.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), ...fileNumbers],
    [manualNumbers, fileNumbers],
  );
  const previewMutation = useMutation({
    mutationFn: () =>
      adminApi.broadcasts.preview({
        courseId: courseId && courseId !== "all" ? Number(courseId) : undefined,
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
      setPreview(null);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "The workbook could not be read.");
    }
  };

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

  return (
    <ConsoleShell title="Broadcast & Invitations">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Send a notice or invitation to enrolled learners or any outside numbers from manual entry or Excel import.
      </p>

      {courses.isError && <ErrorState message={errorMessage(courses.error)} />}
      {previewMutation.isError && <ErrorState message={errorMessage(previewMutation.error)} />}
      {queueMutation.isError && <ErrorState message={errorMessage(queueMutation.error)} />}
      {status.isError && <ErrorState message={errorMessage(status.error)} />}
      {inputError && <ErrorState message={inputError} />}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(16rem,0.8fr)]">
        <Card>
          <CardContent className="space-y-5 p-5">
            <label className="block space-y-2 text-sm font-medium">
              Course
              <select
                aria-label="Course"
                className="h-10 w-full rounded-md border bg-background px-3 font-normal"
                onChange={(event) => {
                  setCourseId(event.target.value);
                  setPreview(null);
                  setQueued(false);
                }}
                value={courseId}
              >
                <option value="">All registered learners (all courses)</option>
                {(courses.data?.courses ?? []).map((course) => (
                  <option key={course.id} value={course.id}>{course.title}</option>
                ))}
              </select>
            </label>

            <label className="block space-y-2 text-sm font-medium">
              Message
              <textarea
                aria-label="Message"
                className="min-h-32 w-full resize-y rounded-md border bg-background p-3 font-normal"
                maxLength={1024}
                onChange={(event) => {
                  setMessage(event.target.value);
                  setPreview(null);
                }}
                placeholder="Write a short update about this course"
                value={message}
              />
              <span className="block text-xs font-normal text-muted-foreground">
                {message.length}/1024 characters
              </span>
            </label>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="manual-broadcast-numbers">
                Add phone numbers manually
              </label>
              <textarea
                id="manual-broadcast-numbers"
                className="min-h-24 w-full resize-y rounded-md border bg-background p-3 text-sm"
                onChange={(event) => {
                  setManualNumbers(event.target.value);
                  setPreview(null);
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
                {phoneNumbers.length} of {MAX_BROADCAST_RECIPIENTS} numbers selected
              </span>
              <Button
                disabled={
                  !message.trim() || phoneNumbers.length === 0 ||
                  phoneNumbers.length > MAX_BROADCAST_RECIPIENTS ||
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
                All valid phone numbers can receive a notice or course invitation. Opt-outs are always excluded.
              </p>
              <p className="text-sm text-muted-foreground">
                Free-form text is sent within the learner’s 24-hour WhatsApp window, or using an approved template.
              </p>
              <p className="text-sm text-muted-foreground">
                Review the match counts before queueing. The server checks eligibility again immediately before sending.
              </p>
            </CardContent>
          </Card>

          {preview && (
            <Card>
              <CardContent className="space-y-4 p-5">
                <h2 className="font-semibold">Recipient review</h2>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">Eligible</dt><dd className="text-lg font-semibold">{preview.acceptedCount}</dd></div>
                  <div><dt className="text-muted-foreground">Template needed</dt><dd className="text-lg font-semibold">{preview.templateCount}</dd></div>
                  <div><dt className="text-muted-foreground">Not eligible</dt><dd className="text-lg font-semibold">{preview.rejected.reduce((sum, item) => sum + item.count, 0)}</dd></div>
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
                  <p className="border-t pt-3 text-sm text-muted-foreground">All numbers match eligible learners.</p>
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
            <h2 className="text-lg font-semibold" id="broadcast-confirm-title">Queue this course notice?</h2>
            <p className="text-sm text-muted-foreground">
              This queues up to {preview.acceptedCount} messages for eligible learners in the selected course.
              Eligibility is checked again by the worker before each send.
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
