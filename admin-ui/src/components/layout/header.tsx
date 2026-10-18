import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrganisations } from "@/api/hooks";
import type { AdminRole } from "@/api/admin";

type HeaderProps = {
  orgName: string | null;
  orgSlug: string | null;
  role: AdminRole;
  selectedOrg: string;
  onOrgSwitch: (slug: string) => void;
  onSignOut: () => void;
};

export function Header({
  orgName,
  orgSlug,
  role,
  selectedOrg,
  onOrgSwitch,
  onSignOut,
}: HeaderProps) {
  const isPlatformAdmin = role === "platform_admin";
  const organisations = useOrganisations(isPlatformAdmin);
  return (
    <header className="flex min-h-16 items-center justify-between border-b border-border bg-background px-4">
      <span className="font-semibold tracking-tight">Ekatra Console</span>
      <div className="flex items-center gap-3">
        {isPlatformAdmin ? (
          <label className="flex items-center gap-2 text-sm">
            <span>Organisation</span>
            <select
              aria-label="Organisation"
              className="h-9 rounded-md border border-input bg-background px-2"
              value={selectedOrg || orgSlug || ""}
              onChange={(event) => onOrgSwitch(event.target.value)}
              disabled={organisations.isLoading || organisations.isError}
            >
              <option value="" disabled>
                Select an organisation
              </option>
              {(organisations.data?.organisations ?? []).map((org) => (
                <option key={org.id} value={org.slug}>
                  {org.name || org.slug}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-sm text-muted-foreground">{orgName ?? "Organisation"}</span>
        )}
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs">{role.replace("_", " ")}</span>
        <Button variant="outline" size="sm" onClick={onSignOut}>
          Sign out <LogOut className="ml-1 size-4" />
        </Button>
      </div>
    </header>
  );
}
