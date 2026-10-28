import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function loadScriptEnvironment(directory = fileURLToPath(new URL("../", import.meta.url))) {
  // Resolve Next's own loader so scripts share its precedence and variable
  // expansion without adding a second environment-file implementation.
  const require = createRequire(import.meta.url);
  const nextRequire = createRequire(require.resolve("next/package.json"));
  const loader: unknown = nextRequire("@next/env");
  if (!loader || typeof loader !== "object" || !("loadEnvConfig" in loader) || typeof loader.loadEnvConfig !== "function") {
    throw new Error("The installed Next.js environment loader is unavailable.");
  }
  loader.loadEnvConfig(directory, process.env.NODE_ENV !== "production");
}
