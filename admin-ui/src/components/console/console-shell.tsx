"use client";

import * as React from "react";
import { useAuth } from "@/api/auth-context";
import Sidebar from "@/components/dashboard/Sidebar";
import Header from "@/components/layout/header";
import { cn } from "@/lib/utils";

export function ConsoleShell({ children, title }: { children?: React.ReactNode; title?: string }) {
  const { session, loading, signOut } = useAuth();

  React.useEffect(() => {
    if (!loading && !session) {
      window.location.replace("/");
    }
  }, [loading, session]);

  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="min-w-0 flex-1 relative">
        <Header onSignOut={() => { signOut(); window.location.assign("/"); }} />
        <main className="pt-16 mx-auto w-full max-w-7xl space-y-6 p-6">
          {title && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold">{title}</h1>
              </div>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
