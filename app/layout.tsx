import type { Metadata } from "next";
import "./globals.css";

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
      className="h-full antialiased"
    >
      <head>
        {/* System fonts keep the preview and builds independent of font services. */}
        <style>{`:root {
          --font-geist-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --font-geist-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        }`}</style>
        {/* Apply the saved preference before paint; CSS resolves system changes. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("cartograph-theme");if(t==="light"||t==="dark"||t==="system")document.documentElement.dataset.theme=t;}catch{}})();`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col font-sans text-sm">
        {children}
      </body>
    </html>
  );
}
