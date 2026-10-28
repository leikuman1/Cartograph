import "./load-env";
import { pathToFileURL } from "node:url";
import { Client } from "langsmith";
import { aiConfiguration, tracingConfiguration } from "../lib/ai/config";
import { flushTraces } from "../lib/ai/client";
import { evaluateInventedPaths } from "../lib/ai/path-evaluation";
import { comparePrompts, evaluateRoles } from "../evals/experiments";
import { recentExplanations } from "../evals/recent";
import { loadRoleDataset } from "../evals/roles";

const USAGE = `Usage:
  pnpm eval:paths [--limit 20]
  pnpm eval:paths --text "Uses fictional.ts" --paths real.ts
  pnpm eval:roles
  pnpm eval:prompts [--limit 20]
  pnpm eval:dataset

Real-trace commands require LANGSMITH_TRACING=true and LANGSMITH_API_KEY.
Roles and prompt comparisons also require OPENAI_API_KEY and OPENAI_BASE_URL.
All commands load the same .env files as Next.js (development by default).
Usefulness is scored by a model judge and is subjective.`;

export function parseArguments(values: readonly string[]) {
  const args = values.filter(value => value !== "--");
  const command = args.shift();
  if (command === "--help" || args.includes("--help")) return { command: "help" as const, limit: 20 };
  if (command !== "paths" && command !== "roles" && command !== "prompts" && command !== "dataset") throw new Error(USAGE);
  let limit = 20;
  let text: string | undefined;
  let paths: string[] | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || seen.has(flag)) throw new Error(`Missing or duplicate option ${flag}.\n${USAGE}`);
    seen.add(flag);
    if (flag === "--limit" && (command === "paths" || command === "prompts") && /^\d+$/.test(value)) {
      limit = Number(value);
      if (limit < 1 || limit > 100) throw new Error("--limit must be between 1 and 100.");
    } else if (flag === "--text" && command === "paths") text = value;
    else if (flag === "--paths" && command === "paths") paths = value.split(",").filter(Boolean);
    else throw new Error(`Unknown option ${flag}.\n${USAGE}`);
  }
  if ((text === undefined) !== (paths === undefined) || (paths && !paths.length)) throw new Error("Supply --text and --paths together, with comma-separated exact supplied file paths.");
  if (text !== undefined && seen.has("--limit")) throw new Error("--limit applies only to recent trace evaluation.");
  return { command, limit, text, paths };
}

export async function run(values: readonly string[]) {
  const args = parseArguments(values);
  if (args.command === "help") { console.log(USAGE); return; }
  if (args.command === "dataset") {
    const examples = await loadRoleDataset();
    console.log(`Role dataset: ${examples.length} adapter-labelled source files. No model calls.`);
    console.table(examples.map(({ path, framework, expectedRole }) => ({ path, framework, role: expectedRole })));
    return;
  }
  if (args.command === "paths" && args.text !== undefined && args.paths) {
    const evaluation = evaluateInventedPaths(args.text, args.paths);
    console.log(JSON.stringify(evaluation, null, 2));
    if (!evaluation.score) process.exitCode = 1;
    return;
  }
  const config = tracingConfiguration();
  if (!config.tracing) throw new Error("Set LANGSMITH_TRACING=true and LANGSMITH_API_KEY in .env.local before running recorded evals.");
  if (args.command === "roles" || args.command === "prompts") {
    if (!aiConfiguration().apiKey) throw new Error("Set OPENAI_API_KEY and OPENAI_BASE_URL in .env.local before running model evals.");
  }
  const client = new Client({ timeout_ms: 15000 });
  try {
    if (args.command === "roles") await evaluateRoles(client);
    else if (args.command === "prompts") await comparePrompts(client, config.tracingProject, args.limit);
    else {
      const records = await recentExplanations(client, config.tracingProject, args.limit);
      let passed = 0;
      for (const record of records) {
        const evaluation = evaluateInventedPaths(record.markdown, record.input.files.map(file => file.path));
        await client.createFeedback({ runId: record.id, sessionId: record.sessionId, key: evaluation.key,
          score: evaluation.score, feedbackSourceType: "api", comment: JSON.stringify(evaluation),
          sourceInfo: { evaluator: evaluation.evaluator, method: "deterministic set membership" } });
        passed += evaluation.score;
        console.log(`${evaluation.score ? "PASS" : "FAIL"} run=${record.id} target=${record.input.target.path}`);
        for (const failure of evaluation.failures) console.log(`  ${failure.path}\n  ${failure.excerpt}`);
      }
      console.log(`No invented paths: ${(passed / records.length * 100).toFixed(1)}% (${passed}/${records.length} recent generated explanations).`);
      if (passed < records.length) process.exitCode = 1;
    }
  } finally {
    await flushTraces();
    await client.awaitPendingTraceBatches();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch(error => {
    let message = error instanceof Error ? error.message : "Evaluation failed.";
    for (const name of ["OPENAI_API_KEY", "LANGSMITH_API_KEY"]) {
      const secret = process.env[name];
      if (secret) message = message.replaceAll(secret, "[redacted]");
    }
    console.error(message);
    process.exitCode = 1;
  });
}
