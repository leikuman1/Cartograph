// Browser-safe AI annotations stay separate from the parser's structural facts.
export const MODEL_ROLES = ["service", "repository", "model", "util", "config", "component", "hook"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelRoleRecord = { file: string; role: ModelRole; contentHash: string };
export type ExplainTarget = { kind: "file" | "folder"; path: string };
export type ExplanationInline =
  | { kind: "text" | "code" | "strong"; text: string }
  | { kind: "file"; path: string };
export type ExplanationBlock = { kind: "paragraph" | "bullet"; children: ExplanationInline[] };
export type ExplanationDocument = { blocks: ExplanationBlock[] };
export type Freshness = {
  status: "fresh" | "stale" | "unknown";
  message: string;
  head: string | null;
  changedFiles: string[];
};
export type AiPanelContext = {
  organizationId: string;
  analysisId: string;
  runId: string;
  model: string | null;
  tracing: boolean;
};
export type ExplanationResponse = {
  document: ExplanationDocument | null;
  error: string | null;
  cacheHit: boolean;
  freshness: Freshness;
};
export const UNKNOWN_FRESHNESS: Freshness = {
  status: "unknown", message: "Repository freshness has not been checked.", head: null, changedFiles: [],
};
