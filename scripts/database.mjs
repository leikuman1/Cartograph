import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { required, reportFailure } from "./lib/clients.mjs";

try {
  const databaseUrl = required("DATABASE_URL");
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL must be a PostgreSQL connection URL."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.password) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL containing the database password.");
  }
  const commands = {
    migrate: ["db", "push", "--yes"],
    verify: ["db", "query", "--file", "supabase/tests/phase02.sql"],
    advisors: ["db", "advisors", "--type", "all", "--fail-on", "error"],
  };
  const command = commands[process.argv[2]];
  if (!command) throw new Error("Expected migrate, verify, or advisors.");
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve("supabase/dist/supabase.js"), ...command, "--db-url", databaseUrl], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000,
  });
  for (const output of [result.stdout, result.stderr]) {
    if (output) console.log(output.replaceAll(databaseUrl, "[DATABASE_URL]").replaceAll(decodeURIComponent(parsed.password), "[redacted]"));
  }
  if (result.error) throw new Error(`Supabase CLI could not complete (${result.error.code ?? "process error"}).`);
  process.exitCode = result.status ?? 1;
} catch (error) {
  reportFailure(error);
}
