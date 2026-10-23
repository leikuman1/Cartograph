// Model changes are reviewed code changes, never a floating provider default.
// A proxy must preserve the version named by this ID rather than remap it.
export const PINNED_MODEL = "workbuddy-ai/deepseek-v4.1-flash";
export const PROMPT_VERSION = "phase10-2";

export function tracingConfiguration() {
  return {
    tracingProject: process.env.LANGSMITH_PROJECT?.trim() || "default",
    tracing: process.env.LANGSMITH_TRACING === "true" && Boolean(process.env.LANGSMITH_API_KEY?.trim()),
  };
}

export function aiConfiguration() {
  const model = process.env.OPENAI_MODEL?.trim() || PINNED_MODEL;
  if (model !== PINNED_MODEL) {
    throw new Error("OPENAI_MODEL must match PINNED_MODEL in lib/ai/config.ts. Repin the version there before changing models.");
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  let baseURL = process.env.OPENAI_BASE_URL?.trim() || "";
  if (apiKey && !baseURL) {
    throw new Error(`Set OPENAI_BASE_URL in .env.local to an OpenAI-compatible endpoint serving ${PINNED_MODEL} before enabling model calls.`);
  }
  if (baseURL) {
    const invalidEndpoint = "OPENAI_BASE_URL must be an absolute HTTPS API URL (HTTP is allowed only for localhost, 127.0.0.1 or [::1]), without credentials, query or fragment.";
    let url: URL;
    try { url = new URL(baseURL); }
    catch { throw new Error(invalidEndpoint); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // Empty query and fragment delimiters survive in href, but not search/hash.
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
      throw new Error(invalidEndpoint);
    }
    baseURL = url.href.replace(/\/$/, "");
  }
  return { model, apiKey, baseURL, ...tracingConfiguration() };
}
