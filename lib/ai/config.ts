// Model changes are reviewed code changes, never a floating provider default.
// A proxy must preserve the version named by this ID rather than remap it.
export const PINNED_MODEL = "workbuddy-ai/deepseek-v4.1-flash";
export const PROMPT_VERSION = "phase10-2";

export function aiConfiguration() {
  const model = process.env.OPENAI_MODEL?.trim() || PINNED_MODEL;
  if (model !== PINNED_MODEL) {
    throw new Error("OPENAI_MODEL must match PINNED_MODEL in lib/ai/config.ts. Repin the version there before changing models.");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("OPENAI_BASE_URL must be an HTTP(S) API address without credentials, query or fragment.");
  }
  return {
    model, apiKey, baseURL: url.href.replace(/\/$/, ""),
    tracingProject: process.env.LANGSMITH_PROJECT?.trim() || "default",
    tracing: process.env.LANGSMITH_TRACING === "true" && Boolean(process.env.LANGSMITH_API_KEY?.trim()),
  };
}
