import * as React from "react";
import { adminApi, type AdminSession } from "./admin";
import { clearApiKey, getApiKey, setApiKey, setOrganizationScope } from "./session";

interface AuthContextValue {
  session: AdminSession | null;
  loading: boolean;
  error: string | null;
  signIn: (key: string, keepOnThisTab: boolean) => Promise<void>;
  signOut: () => void;
  setOrganization: (slug: string | null) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: React.PropsWithChildren) {
  const [session, setSession] = React.useState<AdminSession | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const signOut = React.useCallback(() => {
    clearApiKey();
    setOrganizationScope(null);
    setSession(null);
    setError(null);
  }, []);

  const validate = React.useCallback(async () => {
    if (!getApiKey()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      const current = await adminApi.session();
      setSession(current);
      setError(null);
    } catch (cause) {
      setSession(null);
      setError(cause instanceof Error ? cause.message : "Could not validate the session");
    } finally {
      setLoading(false);
    }
  }, [signOut]);

  React.useEffect(() => {
    void validate();
    const onUnauthorized = () => signOut();
    window.addEventListener("ek:unauthorized", onUnauthorized);
    return () => window.removeEventListener("ek:unauthorized", onUnauthorized);
  }, [signOut, validate]);

  const signIn = React.useCallback(async (key: string, keepOnThisTab: boolean) => {
    setError(null);
    setApiKey(key, keepOnThisTab);
    try {
      const current = await adminApi.session();
      setSession(current);
    } catch (cause) {
      setSession(null);
      setError(cause instanceof Error ? cause.message : "Could not validate the API key");
      throw cause;
    }
  }, []);

  const setOrganization = React.useCallback((slug: string | null) => {
    setOrganizationScope(slug);
  }, []);

  const value = React.useMemo(
    () => ({ session, loading, error, signIn, signOut, setOrganization }),
    [session, loading, error, signIn, signOut, setOrganization],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
