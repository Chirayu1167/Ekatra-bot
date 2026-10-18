import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, type DeliveryMessage, type Failure, type User } from "@/api/admin";
import { useAuth } from "@/api/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ConsoleShell,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
} from "./shared";

const PAGE_SIZE = 20;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}

function conflictMessage(error: unknown): string {
  const raw = errorMessage(error);
  const lower = raw.toLowerCase();
  if (lower.includes("already replayed")) return "This failure has already been replayed.";
  if (lower.includes("already discarded")) return "This failure has already been discarded.";
  if (lower.includes("opted out")) return "This learner opted out. The message cannot be replayed.";
  if (lower.includes("not active")) return "The enrollment is not active. Resume it before replaying.";
  if (lower.includes("not published")) return "The course is not published. Publish it before replaying.";
  if (lower.includes("template") || lower.includes("63016")) return "Twilio requires a WhatsApp template for this message.";
  if (lower.includes("slot context")) return "The original scheduled send context is unavailable; this message cannot be replayed.";
  if (lower.includes("no longer exists")) return "The original event or message no longer exists.";
  if (lower.includes("cooldown") || lower.includes("resent recently")) return raw;
  return raw;
}

function failureLabel(failure: Failure): string {
  const value = `${failure.reasonCode} ${failure.reason}`.toLowerCase();
  if (value.includes("opted_out") || value.includes("opted out")) return "Learner opted out";
  if (value.includes("paused")) return "Enrollment paused";
  if (value.includes("completed")) return "Enrollment completed";
  if (value.includes("template_required") || value.includes("63016") || value.includes("template required")) {
    return "WhatsApp template required";
  }
  if (value.includes("callback")) return "Provider delivery failure";
  if (value.includes("timeout")) return "Delivery timed out";
  return failure.reasonCode.replaceAll("_", " ") || "Other delivery failure";
}

function mediaLabel(value: string): string {
  try {
    const url = new URL(value);
    return `Media attachment (${url.host}${url.pathname})`;
  } catch {
    return "Media attachment";
  }
}

export function DeliveryScreen() {
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [error, setError] = React.useState("");
  const deliveries = useQuery({
    queryKey: ["delivery", status, page],
    queryFn: () => adminApi.delivery.list({ ...(status ? { status } : {}), page, pageSize: PAGE_SIZE }),
  });
  const detail = useQuery({
    queryKey: ["delivery-detail", selectedId],
    queryFn: () => adminApi.delivery.get(selectedId as number),
    enabled: selectedId !== null,
  });
  return (
    <ConsoleShell title="Delivery">
      {error && <ErrorState message={error} />}
      <label className="block max-w-xs space-y-1 text-sm">Delivery status
        <select className="h-10 w-full rounded-md border bg-background px-2" onChange={(event) => { setStatus(event.target.value); setPage(1); }} value={status}>
          <option value="">All statuses</option>
          {["queued", "sending", "sent", "delivered", "read", "failed", "unknown", "dead_letter"].map((value) => <option key={value}>{value}</option>)}
        </select>
      </label>
      {deliveries.isLoading ? <LoadingState>Loading delivery records…</LoadingState>
        : deliveries.isError ? <ErrorState message={errorMessage(deliveries.error)} />
          : !deliveries.data?.messages.length ? <EmptyState>No outbound messages found.</EmptyState>
            : <DataTable<DeliveryMessage>
              columns={[
                { key: "id", label: "Message", render: (row) => `#${row.id}` },
                { key: "kind", label: "Kind", render: (row) => row.kind.replaceAll("_", " ") },
                { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} /> },
                { key: "attempts", label: "Attempts", render: (row) => row.attempts },
                { key: "provider", label: "Provider message ID", render: (row) => row.providerMessageId ?? "—" },
                { key: "retry", label: "Next retry", render: (row) => row.nextRetryAt ? new Date(row.nextRetryAt).toLocaleString() : "—" },
                { key: "created", label: "Created", render: (row) => new Date(row.createdAt).toLocaleString() },
                { key: "action", label: "", render: (row) => <Button onClick={() => { setError(""); setSelectedId(row.id); }} size="sm" variant="outline">Details</Button> },
              ]}
              onPageChange={setPage}
              page={page}
              pageSize={PAGE_SIZE}
              rowKey={(row) => row.id}
              rows={deliveries.data.messages}
              total={deliveries.data.total}
            />}
      {selectedId !== null && <section aria-label="Delivery detail" className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Message #{selectedId}</h2><Button onClick={() => setSelectedId(null)} variant="outline">Close</Button></div>
        {detail.isLoading ? <LoadingState>Loading message detail…</LoadingState>
          : detail.isError ? <ErrorState message={errorMessage(detail.error)} />
            : detail.data && <div className="space-y-3 text-sm">
              <p>Status: <StatusBadge status={detail.data.status} /> · Kind: {detail.data.kind} · Attempts: {detail.data.attemptCount}</p>
              <p>Provider message ID: {detail.data.providerMessageId ?? "—"}</p>
              <p>Created: {new Date(detail.data.createdAt).toLocaleString()} · Updated: {new Date(detail.data.updatedAt).toLocaleString()}</p>
              <h3 className="font-medium">Attempt history</h3>
              {!detail.data.attempts.length ? <p>No attempts recorded.</p> : <ol className="list-inside list-decimal space-y-1">{detail.data.attempts.map((attempt) => <li key={attempt.attemptNo}>Attempt {attempt.attemptNo}: {attempt.status}; provider {attempt.providerMessageId ?? "—"}; error {attempt.errorCode ?? "—"}</li>)}</ol>}
              {detail.data.messages?.length ? <div><h3 className="font-medium">Message content</h3><ul className="list-inside list-disc">{detail.data.messages.map((item, index) => <li key={index}>{item.text || (item.mediaUrl ? mediaLabel(item.mediaUrl) : "[non-text message]")}</li>)}</ul></div> : null}
            </div>}
      </section>}
    </ConsoleShell>
  );
}

export function FailuresScreen() {
  const client = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<number[]>([]);
  const [detailsId, setDetailsId] = React.useState<number | null>(null);
  const [discardReasons, setDiscardReasons] = React.useState<Record<number, string>>({});
  const [error, setError] = React.useState("");
  const result = useQuery({ queryKey: ["failures", page], queryFn: () => adminApi.failures.list({ limit: PAGE_SIZE }) });
  const details = useQuery({ queryKey: ["failure-detail", detailsId], queryFn: () => adminApi.failures.get(detailsId as number), enabled: detailsId !== null });
  const refresh = async () => {
    setSelected([]);
    await client.invalidateQueries({ queryKey: ["failures"] });
  };
  const replay = useMutation({
    mutationFn: async (ids: number[]) => Promise.all(ids.map((id) => adminApi.failures.replay(id))),
    onSuccess: refresh,
    onError: (cause) => setError(conflictMessage(cause)),
  });
  const discard = useMutation({
    mutationFn: (id: number) => adminApi.failures.discard(id, discardReasons[id] ?? ""),
    onSuccess: async (_value, id) => { setDiscardReasons((current) => ({ ...current, [id]: "" })); await refresh(); },
    onError: (cause) => setError(conflictMessage(cause)),
  });
  const rows = result.data?.failures ?? [];
  const counts = result.data?.counts ?? [];
  return <ConsoleShell title="Failures">
    {error && <ErrorState message={error} />}
    {result.isLoading ? <LoadingState>Loading failures…</LoadingState>
      : result.isError ? <ErrorState message={errorMessage(result.error)} />
        : <div className="space-y-4">
          <section aria-label="Failure counts" className="flex flex-wrap gap-2">{counts.map((count) => <span className="rounded border px-3 py-2 text-sm" key={count.reasonCode}>{count.reasonCode.replaceAll("_", " ")}: {count.count}</span>)}</section>
          {!rows.length ? <EmptyState>No open failures.</EmptyState> : <>
            <div className="flex items-center gap-2"><Button disabled={!selected.length || replay.isPending} onClick={() => replay.mutate(selected)}>Replay selected ({selected.length})</Button></div>
            <DataTable<Failure>
              columns={[
                { key: "select", label: "Select", render: (row) => <input aria-label={`Select failure ${row.id}`} checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} type="checkbox" /> },
                { key: "id", label: "Failure", render: (row) => `#${row.id}` },
                { key: "kind", label: "Kind", render: (row) => row.kind },
                { key: "reason", label: "Reason", render: (row) => <span title={row.reason}>{failureLabel(row)}</span> },
                { key: "attempts", label: "Attempts", render: (row) => row.attempts ?? "—" },
                { key: "created", label: "Created", render: (row) => new Date(row.createdAt).toLocaleString() },
                { key: "details", label: "Details", render: (row) => <Button onClick={() => setDetailsId(row.id)} size="sm" variant="outline">Inspect</Button> },
                { key: "replay", label: "Replay", render: (row) => <ConfirmDialog description="This rechecks current opt-out, enrollment and course status." label={`Replay failure #${row.id}?`} onConfirm={() => replay.mutate([row.id])}>Replay</ConfirmDialog> },
                { key: "discard", label: "Discard reason", render: (row) => <div className="flex min-w-56 gap-2"><Input aria-label={`Discard reason for failure ${row.id}`} maxLength={500} onChange={(event) => setDiscardReasons((current) => ({ ...current, [row.id]: event.target.value }))} placeholder="Required reason" value={discardReasons[row.id] ?? ""} /><Button disabled={!discardReasons[row.id]?.trim() || discard.isPending} onClick={() => discard.mutate(row.id)} size="sm" variant="outline">Discard</Button></div> },
              ]}
              onPageChange={setPage}
              page={page}
              pageSize={PAGE_SIZE}
              rowKey={(row) => row.id}
              rows={rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
              total={rows.length}
            />
          </>}
        </div>}
    {detailsId !== null && <section aria-label="Failure inspection" className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between"><h2 className="font-semibold">Failure #{detailsId}</h2><Button onClick={() => setDetailsId(null)} variant="outline">Close</Button></div>
      {details.isLoading ? <LoadingState>Loading attempts…</LoadingState> : details.isError ? <ErrorState message={errorMessage(details.error)} /> : details.data && <>
        <p className="text-sm">{failureLabel(details.data.failure)} — {details.data.failure.reason}</p>
        {!details.data.attempts.length ? <p className="text-sm">No outbound attempts.</p> : <ol className="list-inside list-decimal text-sm">{details.data.attempts.map((attempt, index) => {
          const row = attempt && typeof attempt === "object" ? attempt as Record<string, unknown> : {};
          return <li key={index}>Attempt {typeof row.attemptNo === "number" ? row.attemptNo : index + 1}: {typeof row.status === "string" ? row.status : "unknown"}; provider {typeof row.providerMessageId === "string" ? row.providerMessageId : "—"}; error {typeof row.errorCode === "string" ? row.errorCode : "—"}</li>;
        })}</ol>}
      </>}
    </section>}
  </ConsoleShell>;
}

export function CertificatesScreen() {
  const client = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState("");
  const data = useQuery({ queryKey: ["certificates", page], queryFn: () => adminApi.certificates.list({ page, pageSize: PAGE_SIZE }) });
  const resend = useMutation({
    mutationFn: (enrollmentId: number) => adminApi.certificates.resend(enrollmentId),
    onSuccess: async () => { setError(""); await client.invalidateQueries({ queryKey: ["certificates"] }); },
    onError: (cause) => setError(conflictMessage(cause)),
  });
  return <ConsoleShell title="Certificates">
    {error && <ErrorState message={error} />}
    {data.isLoading ? <LoadingState>Loading certificates…</LoadingState>
      : data.isError ? <ErrorState message={errorMessage(data.error)} />
        : !data.data?.certificates.length ? <EmptyState>No certificates issued yet.</EmptyState>
          : <DataTable
            columns={[
              { key: "learner", label: "Learner", render: (row) => row.learnerName },
              { key: "course", label: "Course", render: (row) => row.courseTitle },
              { key: "code", label: "Certificate code", render: (row) => row.code },
              { key: "issued", label: "Issued", render: (row) => new Date(row.issuedAt).toLocaleString() },
              { key: "resend", label: "", render: (row) => <ConfirmDialog description="A resend is subject to the certificate cooldown." label="Resend certificate?" onConfirm={() => resend.mutate(row.enrollmentId)}>Resend</ConfirmDialog> },
            ]}
            onPageChange={setPage}
            page={page}
            pageSize={PAGE_SIZE}
            rowKey={(row) => row.id}
            rows={data.data.certificates}
            total={data.data.total}
          />}
  </ConsoleShell>;
}

export function UsersAuditScreen() {
  const client = useQueryClient();
  const { session } = useAuth();
  const selectedOrg = new URLSearchParams(window.location.search).get("org") ?? undefined;
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<"org_admin" | "instructor" | "platform_admin">("instructor");
  const [issued, setIssued] = React.useState("");
  const [error, setError] = React.useState("");
  const users = useQuery({ queryKey: ["users", session?.role === "platform_admin" ? selectedOrg : undefined], queryFn: () => adminApi.users.list(session?.role === "platform_admin" ? selectedOrg : undefined) });
  const audit = useQuery({ queryKey: ["audit", selectedOrg], queryFn: () => adminApi.audit(session?.role === "platform_admin" ? selectedOrg : undefined) });
  const closeKey = () => setIssued("");
  const create = useMutation({
    mutationFn: () => adminApi.users.create({ name: name.trim(), role, ...(session?.role === "platform_admin" && selectedOrg ? { org: selectedOrg } : {}) }),
    onSuccess: async (result) => { setIssued(result.apiKey); setName(""); setError(""); await client.invalidateQueries({ queryKey: ["users"] }); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const rotate = useMutation({
    mutationFn: (id: number) => adminApi.users.rotate(id),
    onSuccess: async (result) => { setIssued(result.apiKey); setError(""); await client.invalidateQueries({ queryKey: ["users"] }); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const revoke = useMutation({
    mutationFn: ({ id, keyId }: { id: number; keyId: number }) => adminApi.users.revoke(id, keyId),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["users"] }); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(issued);
    } catch {
      setError("Clipboard access was denied. Select and copy the one-time key manually.");
    }
  };
  const isPlatform = session?.role === "platform_admin";
  return <ConsoleShell title="Users and API keys">
    {error && <ErrorState message={error} />}
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="font-semibold">Create console user</h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <label className="space-y-1 text-sm">Name<Input maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></label>
        <label className="space-y-1 text-sm">Role<select className="h-10 rounded-md border bg-background px-2" onChange={(event) => setRole(event.target.value as typeof role)} value={role}>
          {isPlatform && <option value="platform_admin">platform admin</option>}<option value="org_admin">org admin</option><option value="instructor">instructor</option>
        </select></label>
        <Button disabled={create.isPending || !name.trim()} type="submit">Create user and key</Button>
      </form>
    </section>
    {issued && <div aria-label="One-time API key" className="space-y-2 rounded-lg border border-primary p-4" role="dialog">
      <p className="font-medium">Copy this API key now. It will not be shown again.</p>
      <code className="block break-all rounded bg-muted p-2 text-sm">{issued}</code>
      <div className="flex gap-2"><Button onClick={() => void copyKey()} type="button" variant="outline">Copy key</Button><Button onClick={closeKey} type="button">Close</Button></div>
    </div>}
    {users.isLoading ? <LoadingState>Loading users…</LoadingState> : users.isError ? <ErrorState message={errorMessage(users.error)} /> : !users.data?.users.length ? <EmptyState>No users found.</EmptyState> : <div className="space-y-3">
      {users.data.users.map((user) => <UserCard key={user.id} onRevoke={(keyId) => revoke.mutate({ id: user.id, keyId })} onRotate={() => rotate.mutate(user.id)} user={user} />)}
    </div>}
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Audit log</h2>
      {audit.isLoading ? <LoadingState>Loading audit entries…</LoadingState> : audit.isError ? <ErrorState message={errorMessage(audit.error)} /> : !audit.data?.entries.length ? <EmptyState>No audit entries.</EmptyState> : <DataTable
        columns={[
          { key: "time", label: "Time", render: (entry) => new Date(entry.createdAt).toLocaleString() },
          { key: "action", label: "Action", render: (entry) => entry.action },
          { key: "target", label: "Target", render: (entry) => entry.target || "—" },
          { key: "actor", label: "Actor ID", render: (entry) => entry.actorUserId ?? "system" },
        ]}
        onPageChange={() => undefined}
        page={1}
        pageSize={audit.data.entries.length || 1}
        rowKey={(entry) => entry.id}
        rows={audit.data.entries}
        total={audit.data.entries.length}
      />}
    </section>
  </ConsoleShell>;
}

function UserCard({ user, onRotate, onRevoke }: { user: User; onRotate: () => void; onRevoke: (keyId: number) => void }) {
  return <article className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-medium">{user.name}</h3><p className="text-sm text-muted-foreground">{user.role.replaceAll("_", " ")} · user #{user.id}</p></div>
      <Button onClick={onRotate} size="sm" variant="outline">Rotate keys</Button>
    </div>
    {!user.keys?.length ? <p className="text-sm text-muted-foreground">No API keys.</p> : <ul className="space-y-2">{user.keys.map((key) => <li className="flex flex-wrap items-center justify-between gap-2 text-sm" key={key.id}>
      <span>{key.prefix}… · created {new Date(key.createdAt).toLocaleString()} · {key.revokedAt ? `revoked ${new Date(key.revokedAt).toLocaleString()}` : "active"}</span>
      {!key.revokedAt && <ConfirmDialog description="This API key will stop working immediately." label="Revoke API key?" onConfirm={() => onRevoke(key.id)}>Revoke</ConfirmDialog>}
    </li>)}</ul>}
  </article>;
}

export function StatusScreen() {
  const readiness = useQuery({ queryKey: ["status", "readiness"], queryFn: adminApi.status.readiness, refetchInterval: 15_000 });
  const worker = useQuery({ queryKey: ["status", "worker"], queryFn: adminApi.status.worker, refetchInterval: 15_000 });
  return <ConsoleShell title="System status">
    <div className="grid gap-4 md:grid-cols-2">
      <StatusPanel label="API readiness" query={readiness} />
      <StatusPanel label="Worker" query={worker} />
    </div>
  </ConsoleShell>;
}

function StatusPanel({ label, query }: { label: string; query: ReturnType<typeof useQuery<Record<string, unknown>>> }) {
  const data = query.data ?? {};
  const status = typeof data.status === "string" ? data.status : "unknown";
  const age = typeof data.heartbeatAgeMs === "number" ? `${Math.round(data.heartbeatAgeMs / 1000)} seconds` : "unavailable";
  return <section className="space-y-3 rounded-lg border p-4">
    <h2 className="font-semibold">{label}</h2>
    {query.isLoading ? <LoadingState>Checking {label.toLowerCase()}…</LoadingState>
      : query.isError && !query.data ? <ErrorState message={errorMessage(query.error)} />
        : <><p>State: <StatusBadge status={status} /></p>
          {data.database !== undefined && <p>Database: {data.database === true ? "connected" : "unavailable"}</p>}
          {data.migration !== undefined && <p>Migrations: {data.migration === true ? "current" : "not current"}</p>}
          <p>Worker heartbeat age: {age}</p>
          {typeof data.reason === "string" && <p role="alert" className="text-sm text-destructive">{data.reason}</p>}
          {query.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(query.error)}</p>}
        </>}
  </section>;
}
