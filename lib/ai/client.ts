import OpenAI from "openai";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";
import type { PathEvaluation } from "./path-evaluation";
import { wrapOpenAI } from "langsmith/wrappers/openai";
import { aiConfiguration } from "./config";

let provider: ReturnType<typeof wrapOpenAI<OpenAI>> | undefined;
let tracingClient: Client | undefined;

function traceClient() {
  tracingClient ??= new Client({ timeout_ms: 15000 });
  return tracingClient;
}

// This is the only provider constructor. Both explanation and classification
// must go through this wrapped client, including when tracing is disabled.
function client() {
  const config = aiConfiguration();
  if (!config.apiKey) throw new Error("Set OPENAI_API_KEY in .env.local before generating explanations or roles.");
  provider ??= wrapOpenAI(new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60000, maxRetries: 0 }), {
    tracingEnabled: config.tracing, project_name: config.tracingProject,
    ...(config.tracing ? { client: traceClient() } : {}),
  });
  return provider;
}

export async function generateJson(system: string, input: unknown): Promise<unknown> {
  const completion = await client().chat.completions.create({
    model: aiConfiguration().model,
    messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }],
    response_format: { type: "json_object" },
    max_tokens: 3500,
  });
  const choice = completion.choices[0];
  if (choice?.finish_reason !== "stop" || !choice.message.content) throw new Error("The model did not finish its response. Try again.");
  try { return JSON.parse(choice.message.content) as unknown; }
  catch { throw new Error("The model did not return valid JSON. Try again."); }
}

export async function tracedOperation<T>(
  name: string, metadata: Record<string, string>, work: () => Promise<T>, inputs?: Record<string, unknown>,
): Promise<T> {
  const config = aiConfiguration();
  return traceable(work, {
    name, run_type: "chain", metadata, tracingEnabled: config.tracing, project_name: config.tracingProject,
    ...(inputs ? { processInputs: () => inputs } : {}),
    ...(config.tracing ? { client: traceClient() } : {}),
  })();
}

const feedbackProjects = new Map<string, Promise<string>>();
export async function recordPathFeedback(runId: string, evaluation: PathEvaluation, projectName = aiConfiguration().tracingProject) {
  const config = aiConfiguration();
  if (!config.tracing) return;
  try {
    const client = traceClient();
    await flushTraces();
    let project = feedbackProjects.get(projectName);
    if (!project) {
      project = client.readProject({ projectName }).then(project => project.id);
      feedbackProjects.set(projectName, project);
    }
    await client.createFeedback({
      runId, sessionId: await project, key: evaluation.key, score: evaluation.score,
      comment: JSON.stringify(evaluation), feedbackSourceType: "api",
      sourceInfo: { evaluator: evaluation.evaluator, method: "deterministic set membership" },
    });
  } catch {
    feedbackProjects.delete(projectName);
    console.error("LangSmith invented-path feedback upload failed; the evaluation remains in the explanation-answer trace output.");
  }
}

export async function flushTraces() {
  if (tracingClient) await tracingClient.awaitPendingTraceBatches();
}
