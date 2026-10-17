import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { getEnvironment } from "@/lib/env";
import AuthControls from "../auth-controls";
import ThemeControl from "../theme-control";

async function WorkspaceShell({ children }: { children: ReactNode }) {
  // Credentials belong to live workspace requests, not the offline preview or build.
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
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-surface px-4 py-2">
        <Link href="/" className="font-semibold">Cartograph</Link>
        <nav aria-label="Account and team" className="flex flex-1 items-center justify-end">
          <AuthControls />
        </nav>
        <ThemeControl />
      </header>
      <main id="main-content" className="flex flex-1 flex-col" tabIndex={-1}>
        {children}
      </main>
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
