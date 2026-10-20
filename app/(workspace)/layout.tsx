import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { getEnvironment } from "@/lib/env";
import AuthControls from "../auth-controls";
import ThemeControl from "../theme-control";

async function WorkspaceShell({ children }: { children: ReactNode }) {
  // Read credentials only once this is a live workspace request.
  await connection();
  const { clerkPublishableKey } = getEnvironment();

  return (
    <ClerkProvider
      dynamic
      publishableKey={clerkPublishableKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInForceRedirectUrl="/"
      signUpForceRedirectUrl="/"
      afterSignOutUrl="/sign-in"
      appearance={{
        variables: {
          colorPrimary: "var(--accent)",
          colorBackground: "var(--surface)",
          colorForeground: "var(--foreground)",
          colorMuted: "var(--background)",
          colorMutedForeground: "var(--muted)",
          colorInput: "var(--surface)",
          colorInputForeground: "var(--foreground)",
          colorNeutral: "var(--foreground)",
          fontFamily: "var(--font-geist-sans), sans-serif",
          fontSize: "0.8125rem",
          borderRadius: "0.375rem",
        },
      }}
    >
      <div className="flex h-dvh flex-col">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-surface px-4 py-2">
          <Link href="/" className="font-semibold">Cartograph</Link>
          <nav aria-label="Account and team" className="flex flex-1 items-center justify-end">
            <AuthControls />
          </nav>
          <ThemeControl />
        </header>
        <main id="main-content" className="flex min-h-0 flex-1 flex-col overflow-auto" tabIndex={-1}>
          {children}
        </main>
      </div>
    </ClerkProvider>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="p-4 text-muted" role="status">Loading workspace…</p>}>
      <WorkspaceShell>{children}</WorkspaceShell>
    </Suspense>
  );
}
