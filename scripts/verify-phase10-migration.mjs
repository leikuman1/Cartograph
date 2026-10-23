import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { required, reportFailure } from "./lib/clients.mjs";

// Validate a pending migration and its RLS suite in one rolled-back database
// subtransaction. Neither schema changes nor test fixtures survive success.
let directory;
try {
  const migration = readFileSync(new URL("../supabase/migrations/20261022010000_phase10_ai.sql", import.meta.url), "utf8");
  const suite = readFileSync(new URL("../supabase/tests/phase10.sql", import.meta.url), "utf8");
  const match = suite.match(/^\s*(?:--[^\n]*(?:\n|$)\s*)*begin\s*;([\s\S]*)\brollback\s*;\s*select\s+'[^']+'\s+as\s+result\s*;\s*$/i);
  if (!match) throw new Error("The phase 10 suite must have a rollback boundary.");
  const sql = `do $phase10_verify$ begin begin
    execute $phase10_source$${migration}\n${match[1]}$phase10_source$;
    raise exception using errcode = 'P7010', message = 'phase10 verification rollback';
    exception when sqlstate 'P7010' then
      if sqlerrm <> 'phase10 verification rollback' then raise; end if;
    end; end $phase10_verify$;`;
  directory = mkdtempSync(path.join(tmpdir(), "cartograph-phase10-"));
  const file = path.join(directory, "verify.sql");
  writeFileSync(file, sql, { encoding: "utf8", flag: "wx" });
  const require = createRequire(import.meta.url);
  const databaseUrl = required("DATABASE_URL");
  const parsed = new URL(databaseUrl);
  const result = spawnSync(process.execPath, [require.resolve("supabase/dist/supabase.js"), "db", "query", "--file", file, "--db-url", databaseUrl], {
    encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  const secrets = [databaseUrl, parsed.password, decodeURIComponent(parsed.password)].filter(Boolean);
  for (const output of [result.stdout, result.stderr]) {
    if (output) console.log(secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), output));
  }
  if (result.error) throw new Error(`The migration check could not complete (${result.error.code ?? "process error"}).`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log("Phase 10 migration and SQL checks passed; all schema changes and fixtures rolled back.");
} catch (error) {
  reportFailure(error);
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
