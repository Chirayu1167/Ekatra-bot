import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/api/auth-context";

export const Route = createFileRoute("/")({
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const { session, loading, error, signIn } = useAuth();
  const [key, setKey] = React.useState("");
  const [keepOnThisTab, setKeepOnThisTab] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!loading && session) navigate({ to: "/dashboard" });
  }, [loading, navigate, session]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await signIn(key.trim(), keepOnThisTab);
      navigate({ to: "/dashboard" });
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-4 p-6 border rounded-xl border-input shadow-sm">
        <h2 className="text-lg font-semibold">Sign in to the admin console</h2>
        <p className="text-sm text-muted-foreground">
          Enter your admin API key to open the console.
        </p>
        <div className="space-y-2">
          <Label htmlFor="api-key">API key</Label>
          <Input
            id="api-key"
            type="password"
            autoComplete="off"
            placeholder="ek_live_..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={keepOnThisTab}
            onChange={(event) => setKeepOnThisTab(event.target.checked)}
          />
          Keep me signed in on this tab
        </label>
        {(submitError || error) && (
          <p role="alert" className="text-sm text-destructive">{submitError ?? error}</p>
        )}
        <Button type="submit" className="w-full" disabled={submitting || loading}>
          {submitting ? "Validating..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
