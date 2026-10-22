import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { required, reportFailure } from "./lib/clients.mjs";

function verificationStatement(path) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const transaction = source.match(/^\s*(?:--[^\n]*(?:\n|$)\s*)*begin\s*;([\s\S]*)\brollback\s*;\s*select\s+'([^']+)'\s+as\s+result\s*;\s*$/i);
  if (!transaction) throw new Error(`${path} must begin a transaction and finish with rollback and a result message.`);
  const body = transaction[1];
  const delimiter = "$cartograph_suite$";
  if (body.includes(delimiter) || body.includes("$cartograph_verify$")) {
    throw new Error(`${path} contains a reserved verification delimiter.`);
  }
  // The CLI uses a prepared statement, which accepts only one SQL command.
  // SPI executes the complete suite on the same connection; an exception then
  // rolls back its subtransaction, including fixtures, DDL and SET LOCAL state.
  // Every other SQL error propagates and fails the command.
  return {
    message: transaction[2],
    sql: `do $cartograph_verify$
      begin
        begin
          execute ${delimiter}${body}${delimiter};
          raise exception using errcode = 'P7007', message = 'cartograph verification rollback';
        exception when sqlstate 'P7007' then
          if sqlerrm <> 'cartograph verification rollback' then raise; end if;
        end;
      end;
    $cartograph_verify$;`,
  };
}

try {
  const [action, ...flags] = process.argv.slice(2);
  if (flags.length && !(action === "migrate" && flags.length === 1 && flags[0] === "--dry-run")) {
    throw new Error("Only db:migrate accepts an optional --dry-run flag.");
  }
  const databaseUrl = required("DATABASE_URL");
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("DATABASE_URL must be a PostgreSQL connection URL."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.password) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL containing the database password.");
  }
  const commands = {
    migrate: [{ command: ["db", "push", "--yes", ...flags] }],
    // Each suite has its own rollback boundary and must pass before the next.
    verify: ["supabase/tests/phase02.sql", "supabase/tests/phase07.sql", "supabase/tests/phase08.sql", "supabase/tests/phase08_review.sql", "supabase/tests/phase09.sql", "supabase/tests/phase10.sql"].map(path => {
      const { sql, message } = verificationStatement(path);
      return { command: ["db", "query", sql], message };
    }),
    advisors: [{ command: ["db", "advisors", "--type", "all", "--fail-on", "error"] }],
  };
  const commandsToRun = commands[action];
  if (!commandsToRun) throw new Error("Expected migrate, verify, or advisors.");
  const require = createRequire(import.meta.url);
  const redactions = [databaseUrl, parsed.password, decodeURIComponent(parsed.password)];
  for (const { command, message } of commandsToRun) {
    let temporaryDirectory;
    let result;
    try {
      let argumentsToRun = command;
      if (command[0] === "db" && command[1] === "query") {
        // Windows limits command-line length; the suite is already one SQL
        // statement, so pass its text as a file without changing its semantics.
        temporaryDirectory = mkdtempSync(path.join(tmpdir(), "cartograph-verify-"));
        const file = path.join(temporaryDirectory, "suite.sql");
        writeFileSync(file, command[2], { encoding: "utf8", flag: "wx" });
        argumentsToRun = ["db", "query", "--file", file];
      }
      result = spawnSync(process.execPath, [require.resolve("supabase/dist/supabase.js"), ...argumentsToRun, "--db-url", databaseUrl], {
        encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000,
      });
    } finally {
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    for (const output of [result.stdout, result.stderr]) {
      if (output) console.log(redactions.reduce((text, value) => text.replaceAll(value, "[redacted]"), output));
    }
    if (result.error) throw new Error(`Supabase CLI could not complete (${result.error.code ?? "process error"}).`);
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
    if (message) console.log(message);
  }
} catch (error) {
  reportFailure(error);
}
