import { createHash } from "node:crypto";
import { Client, type Example } from "langsmith";
import { evaluate, type EvaluatorT } from "langsmith/evaluation";
import { cachedOperation, type AiCache } from "../lib/ai/cache";
import { aiConfiguration, PROMPT_VERSION } from "../lib/ai/config";
import { generateJson, tracedOperation } from "../lib/ai/client";
import { EXPLAIN_PROMPT, generateExplanationAnswer } from "../lib/ai/operations";
import { evaluateInventedPaths } from "../lib/ai/path-evaluation";
import { classifyRoleExample, loadRoleDataset, type RoleExample } from "./roles";
import { parseExplanationInput, recentExplanations } from "./recent";
import { PREVIOUS_EXPLAIN_PROMPT, PREVIOUS_PROMPT_VERSION, USEFULNESS_JUDGE_PROMPT, USEFULNESS_JUDGE_VERSION } from "./prompts";

type EvaluatorInput = {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
};

export function memoryCache(): AiCache {
  const values = new Map<string, Record<string, unknown>>();
  return { async read(key) { return values.get(key) ?? null; }, async write(key, _operation, value) { values.set(key, value); } };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name} in evaluation data.`);
  return value;
}

export function validateJudge(value: unknown): { score: number; reason: string } {
  if (!value || typeof value !== "object" || !("score" in value) || !("reason" in value) ||
    typeof value.score !== "number" || !Number.isInteger(value.score) || value.score < 0 || value.score > 4 ||
    typeof value.reason !== "string" || !value.reason.trim()) throw new Error("The usefulness judge returned an invalid score or reason.");
  return { score: value.score, reason: value.reason };
}

async function experimentSummary(results: Awaited<ReturnType<typeof evaluate>>, expected: number, keys: string[]) {
  const scores = new Map(keys.map(key => [key, [] as number[]]));
  let count = 0;
  for await (const row of results) {
    if (row.run.error) throw new Error(`Experiment ${results.experimentName} failed for example ${row.example.id}: ${row.run.error}`);
    for (const key of keys) {
      const values = row.evaluationResults.results.filter(result => result.key === key);
      const score = values[0]?.score;
      if (values.length !== 1 || typeof score !== "number" || !Number.isFinite(score)) {
        throw new Error(`Experiment ${results.experimentName} has no valid ${key} score for example ${row.example.id}.`);
      }
      scores.get(key)?.push(score);
    }
    count += 1;
  }
  if (count !== expected || count === 0) throw new Error(`Experiment completed ${count} of ${expected} examples; no partial aggregate is reported.`);
  return Object.fromEntries([...scores].map(([key, values]) => [key, values.reduce((sum, score) => sum + score, 0) / count]));
}

export async function evaluateRoles(client: Client) {
  const gold = await loadRoleDataset();
  const dataset = await client.createDataset(`cartograph-roles-${crypto.randomUUID()}`, {
    description: "Synthetic held-out source files; reference roles are derived by the real framework adapters and restricted to classifier-allowed categories.",
    metadata: { origin: "eval", kind: "role-accuracy" },
  });
  const examples = await client.createExamples(gold.map(({ expectedRole, ...input }) => ({
    dataset_id: dataset.id, inputs: input, outputs: { role: expectedRole },
  })));
  const cache = memoryCache();
  const evaluator: EvaluatorT = ({ outputs, referenceOutputs }: EvaluatorInput) => ({
    key: "role_accuracy", score: outputs.role === referenceOutputs?.role ? 1 : 0,
    comment: `expected=${String(referenceOutputs?.role)} predicted=${String(outputs.role)}`,
  });
  const result = await evaluate(async (input: Record<string, unknown>) => {
    const framework = gold.find(example => example.path === input.path)?.framework;
    if (!framework) throw new Error("Role evaluation example does not belong to the frozen dataset.");
    const example: Omit<RoleExample, "expectedRole"> = {
      path: requiredString(input.path, "path"), content: requiredString(input.content, "content"),
      contentHash: requiredString(input.contentHash, "contentHash"), framework,
    };
    return classifyRoleExample(example, cache);
  }, { client, data: examples, evaluators: [evaluator], maxConcurrency: 2,
    experimentPrefix: "cartograph-role-accuracy", metadata: { origin: "eval", model: aiConfiguration().model } });
  const scores = await experimentSummary(result, examples.length, ["role_accuracy"]);
  console.log(`Role accuracy: ${(scores.role_accuracy * 100).toFixed(1)}% (${examples.length} files). Experiment: ${result.experimentName}`);
  console.log("Synthetic convention-labelled holdout: service, model, component and hook. This does not measure repository, util or config accuracy.");
}

export async function comparePrompts(client: Client, project: string, limit: number) {
  const recent = await recentExplanations(client, project, limit);
  const dataset = await client.createDataset(`cartograph-explanations-${crypto.randomUUID()}`, {
    description: "Frozen real explanation inputs replayed unchanged for both prompt versions; usefulness scores are subjective model judgments.",
    metadata: { origin: "eval", source_project: project },
  });
  const examples: Example[] = await client.createExamples(recent.map(record => ({
    dataset_id: dataset.id, inputs: record.input, source_run_id: record.id,
  })));
  const judgeCache = memoryCache();
  const judge: EvaluatorT = async ({ inputs, outputs }: EvaluatorInput) => {
    const input = parseExplanationInput(inputs);
    const markdown = requiredString(outputs.markdown, "markdown");
    const payload = { context: input, explanation: markdown };
    const key = createHash("sha256").update(JSON.stringify({ model: aiConfiguration().model, version: USEFULNESS_JUDGE_VERSION, payload })).digest("hex");
    const judged = await cachedOperation(judgeCache, key, input.target.kind,
      work => tracedOperation("judge-usefulness", { origin: "eval", judge_version: USEFULNESS_JUDGE_VERSION }, work, payload),
      validateJudge, async () => validateJudge(await generateJson(USEFULNESS_JUDGE_PROMPT, payload)));
    return { key: "usefulness_model_judge", score: judged.value.score / 4, comment: judged.value.reason };
  };
  const pathEvaluator: EvaluatorT = ({ inputs, outputs }: EvaluatorInput) => {
    const input = parseExplanationInput(inputs);
    const evaluation = evaluateInventedPaths(requiredString(outputs.markdown, "markdown"), input.files.map(file => file.path));
    return { key: evaluation.key, score: evaluation.score, comment: JSON.stringify(evaluation.failures) };
  };
  const summaries: { version: string; experiment: string; path: number; usefulness: number }[] = [];
  console.log(`Same frozen dataset: ${examples.length} real inputs. Model: ${aiConfiguration().model}.`);
  console.log("Usefulness is a subjective 0–4 model judgment, normalized to percent. It is not an objective correctness score; differences may vary between runs.");
  for (const [version, prompt] of [[PREVIOUS_PROMPT_VERSION, PREVIOUS_EXPLAIN_PROMPT], [PROMPT_VERSION, EXPLAIN_PROMPT]]) {
    const cache = memoryCache();
    const result = await evaluate(async (values: Record<string, unknown>) => {
      const input = parseExplanationInput(values);
      const key = createHash("sha256").update(JSON.stringify({ version, prompt, input })).digest("hex");
      const answer = await cachedOperation(cache, key, input.target.kind,
        work => tracedOperation("eval-explanation", { origin: "eval", prompt_version: version }, work, values),
        value => {
          if (!value || typeof value !== "object" || !("markdown" in value)) throw new Error("Invalid experiment cache.");
          return { markdown: requiredString(value.markdown, "markdown") };
        }, async () => ({ markdown: (await generateExplanationAnswer(input, prompt, version)).markdown }));
      return answer.value;
    }, { client, data: examples, evaluators: [pathEvaluator, judge], maxConcurrency: 2,
      experimentPrefix: `cartograph-${version}`, metadata: { origin: "eval", prompt_version: version,
        model: aiConfiguration().model, judge_version: USEFULNESS_JUDGE_VERSION } });
    const score = await experimentSummary(result, examples.length, ["invented_paths", "usefulness_model_judge"]);
    summaries.push({ version, experiment: result.experimentName, path: score.invented_paths, usefulness: score.usefulness_model_judge });
  }
  const [previous, current] = summaries;
  console.table({
    "Prompt version": { previous: previous.version, current: current.version },
    "No invented paths (%)": { previous: (previous.path * 100).toFixed(1), current: (current.path * 100).toFixed(1) },
    "Usefulness, model judge (%)": { previous: (previous.usefulness * 100).toFixed(1), current: (current.usefulness * 100).toFixed(1) },
    Experiment: { previous: previous.experiment, current: current.experiment },
  });
  const delta = (current.usefulness - previous.usefulness) * 100;
  console.log(delta === 0 ? "The model judge reports a tie on usefulness." : `${delta > 0 ? current.version : previous.version} scored ${Math.abs(delta).toFixed(1)} percentage points higher on subjective usefulness.`);
  console.log(`Current minus previous path pass rate: ${((current.path - previous.path) * 100).toFixed(1)} percentage points.`);
}
