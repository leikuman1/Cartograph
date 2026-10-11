import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import AuthControls from "./auth-controls";
import ThemeControl from "./theme-control";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cartograph",
  description: "Explore the dependencies of a public GitHub repository.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="system"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Apply the saved preference before paint; CSS resolves system changes. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("cartograph-theme");if(t==="light"||t==="dark"||t==="system")document.documentElement.dataset.theme=t;}catch{}})();`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col font-sans text-sm">
        <Suspense fallback={<p className="p-4 text-muted" role="status">Loading workspace…</p>}>
          <ClerkProvider
            dynamic
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
        </Suspense>
      </body>
    </html>
  );
}
