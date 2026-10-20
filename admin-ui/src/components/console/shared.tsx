import * as React from "react";
import { useAuth } from "@/api/auth-context";
import Header from "@/components/layout/header";
import { navigationForRole } from "@/components/layout/navigation";
import { setOrganizationScope } from "@/api/session";

export function ConsoleShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { session, loading, signOut, setOrganization } = useAuth();
  const selectedOrg = new URLSearchParams(window.location.search).get("org") ?? "";

  React.useEffect(() => {
    if (session?.role === "platform_admin") setOrganizationScope(selectedOrg || null);
    else setOrganizationScope(null);
  }, [selectedOrg, session?.role]);

  React.useEffect(() => {
    if (!loading && !session) window.location.replace(import.meta.env.BASE_URL);
  }, [loading, session]);

  if (loading || !session) return <p className="p-6" role="status">Loading session…</p>;
  const navigation = navigationForRole(session.role);
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r bg-card p-4">
        <div className="mb-6 text-sm font-semibold">Ekatra Console</div>
        <p className="mb-3 text-xs uppercase text-muted-foreground">Workspace</p>
        <nav aria-label="Workspace" className="space-y-1">
          {navigation.map((item) => (
            <a
              className="block rounded-md px-3 py-2 text-sm hover:bg-muted"
              href={`${import.meta.env.BASE_URL}${item.to.replace(/^\//, "")}`}
              key={item.to}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Header onSignOut={() => { signOut(); window.location.assign(import.meta.env.BASE_URL); }} />
        <main className="mx-auto w-full max-w-7xl space-y-5 p-6">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}

export function LoadingState({ children = "Loading…" }: { children?: React.ReactNode }) {
  return <p role="status" className="py-6 text-sm text-muted-foreground">{children}</p>;
}

export function ErrorState({ message }: { message: string }) {
  return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{message}</p>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</p>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-xs font-medium capitalize">{status.replaceAll("_", " ")}</span>;
}

export function ConfirmDialog({
  label,
  description,
  onConfirm,
  children,
}: {
  label: string;
  description: string;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-muted" onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation">
          <section aria-labelledby="confirm-title" aria-modal="true" className="w-full max-w-md space-y-4 rounded-lg bg-background p-6 shadow-xl" role="dialog">
            <h2 id="confirm-title" className="text-lg font-semibold">{label}</h2>
            <p className="text-sm text-muted-foreground">{description}</p>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => { onConfirm(); setOpen(false); }}>Confirm</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function DataTable<T>({
  columns,
  rows,
  page,
  pageSize,
  total,
  onPageChange,
  rowKey,
}: {
  columns: Array<{ key: string; label: string; render: (row: T) => React.ReactNode }>;
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  rowKey: (row: T) => React.Key;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/60"><tr>{columns.map((column) => <th className="px-4 py-3 font-medium" key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr className="border-t" key={rowKey(row)}>{columns.map((column) => <td className="px-4 py-3" key={column.key}>{column.render(row)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
        <span>{total === 0 ? "0 results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}</span>
        <div className="flex gap-2">
          <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button>
          <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
