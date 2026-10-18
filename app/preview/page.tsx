import type { Metadata } from "next";
import ThemeControl from "../theme-control";
import { analysis, repository } from "@/lib/canvas/fixture";
import DependencyCanvas from "./dependency-canvas";

export const metadata: Metadata = { title: "Canvas preview · Cartograph" };

export default function PreviewPage() {
  return <div className="preview-shell">
    <a href="#main-content" className="skip-link">Skip to map</a>
    <header className="preview-header">
      <span className="font-semibold">Cartograph</span>
      <span className="preview-divider" />
      <h1 className="font-mono">{repository.name}<span className="text-muted"> / {repository.version}</span></h1>
      <span className="preview-badge" title={`Source commit ${repository.commit}`}>Local preview</span>
      <ThemeControl />
    </header>
    <main id="main-content" className="preview-main" tabIndex={-1}>
      <DependencyCanvas analysis={analysis} />
    </main>
  </div>;
}
