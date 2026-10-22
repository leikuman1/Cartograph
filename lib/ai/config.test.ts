import assert from "node:assert/strict";
import test from "node:test";
import { aiConfiguration, PINNED_MODEL } from "./config";

const environmentNames = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT",
] as const;
type Environment = Partial<Record<(typeof environmentNames)[number], string>>;

function withEnvironment(values: Environment, check: () => void) {
  const original = new Map(environmentNames.map(name => [name, process.env[name]]));
  try {
    for (const name of environmentNames) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    check();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const configured = { OPENAI_API_KEY: "fixture-key", OPENAI_BASE_URL: "https://proxy.example/v1" };

test("absent or blank AI configuration preserves keyless startup without a default endpoint", () => {
  withEnvironment({}, () => {
    assert.deepEqual(aiConfiguration(), {
      model: PINNED_MODEL, apiKey: undefined, baseURL: "", tracingProject: "default", tracing: false,
    });
  });
  for (const blank of ["", " \t "]) {
    withEnvironment({ OPENAI_API_KEY: blank, OPENAI_BASE_URL: blank, OPENAI_MODEL: blank }, () => {
      const config = aiConfiguration();
      assert.equal(config.apiKey, "");
      assert.equal(config.baseURL, "");
      assert.equal(config.model, PINNED_MODEL);
    });
    withEnvironment({ OPENAI_API_KEY: blank, OPENAI_BASE_URL: configured.OPENAI_BASE_URL }, () => {
      assert.equal(aiConfiguration().apiKey, "");
      assert.equal(aiConfiguration().baseURL, configured.OPENAI_BASE_URL);
    });
  }
});

test("an API key requires an explicit endpoint serving the pinned model", () => {
  for (const endpoint of [undefined, "", " \t "]) {
    const values: Environment = { OPENAI_API_KEY: configured.OPENAI_API_KEY };
    if (endpoint !== undefined) values.OPENAI_BASE_URL = endpoint;
    withEnvironment(values, () => {
      assert.throws(aiConfiguration, {
        message: `Set OPENAI_BASE_URL in .env.local to an OpenAI-compatible endpoint serving ${PINNED_MODEL} before enabling model calls.`,
      });
    });
  }
});

test("HTTPS and literal loopback HTTP endpoints use the parsed and normalized URL", () => {
  for (const [endpoint, expected] of [
    ["https://proxy.example/v1", "https://proxy.example/v1"],
    [" https://PROXY.example:443/v1/ \t", "https://proxy.example/v1"],
    ["https://proxy.example:8443/openai/v1/", "https://proxy.example:8443/openai/v1"],
    ["https://proxy.example/v1%3Fpath%23part", "https://proxy.example/v1%3Fpath%23part"],
    ["http://localhost/v1", "http://localhost/v1"],
    ["http://LOCALHOST:8080/v1/", "http://localhost:8080/v1"],
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1"],
    ["http://[::1]:8080/v1/", "http://[::1]:8080/v1"],
  ]) {
    withEnvironment({ ...configured, OPENAI_API_KEY: " fixture-key ", OPENAI_BASE_URL: endpoint }, () => {
      assert.equal(aiConfiguration().baseURL, expected, endpoint);
      assert.equal(aiConfiguration().apiKey, "fixture-key");
    });
  }
});

test("remote HTTP, loopback lookalikes and other protocols are rejected", () => {
  for (const endpoint of [
    "http://proxy.example/v1", "http://localhost.example/v1", "http://sub.localhost/v1",
    "http://localhost./v1", "http://localhost-proxy.example/v1", "http://127.0.0.1.example/v1",
    "http://127.0.0.2/v1", "http://[::2]/v1", "http://[::ffff:127.0.0.1]/v1",
    "ftp://localhost/v1", "ws://localhost/v1", "wss://proxy.example/v1",
    "file:///v1", "data:text/plain,endpoint", "javascript:void(0)",
  ]) {
    withEnvironment({ ...configured, OPENAI_BASE_URL: endpoint }, () => {
      assert.throws(aiConfiguration, /OPENAI_BASE_URL must be an absolute HTTPS API URL/, endpoint);
    });
  }
});

test("credentials, queries and fragments are rejected for remote and loopback endpoints", () => {
  for (const endpoint of [
    "https://user@proxy.example/v1", "https://:secret@proxy.example/v1",
    "https://user:secret@proxy.example/v1", "http://localhost@proxy.example/v1",
    "http://user:secret@localhost/v1", "https://proxy.example/v1?token=value",
    "https://proxy.example/v1?", "https://proxy.example/v1#fragment", "https://proxy.example/v1#",
    "http://127.0.0.1/v1?token=value", "http://[::1]/v1#fragment",
  ]) {
    withEnvironment({ ...configured, OPENAI_BASE_URL: endpoint }, () => {
      assert.throws(aiConfiguration, /without credentials, query or fragment/, endpoint);
    });
  }
});

test("malformed and relative endpoints fail with an actionable configuration error", () => {
  for (const endpoint of ["not-a-url", "/v1", "//localhost/v1", "https://", "http://[::1"]) {
    withEnvironment({ ...configured, OPENAI_BASE_URL: endpoint }, () => {
      assert.throws(aiConfiguration, /OPENAI_BASE_URL must be an absolute HTTPS API URL/, endpoint);
    });
  }
});

test("the reviewed model stays pinned and mismatched model overrides still fail", () => {
  assert.equal(PINNED_MODEL, "workbuddy-ai/deepseek-v4.1-flash");
  withEnvironment({ ...configured, OPENAI_MODEL: ` ${PINNED_MODEL} ` }, () => {
    assert.equal(aiConfiguration().model, PINNED_MODEL);
  });
  for (const values of [{}, configured]) {
    withEnvironment({ ...values, OPENAI_MODEL: "another-model" }, () => {
      assert.throws(aiConfiguration, /OPENAI_MODEL must match PINNED_MODEL/);
    });
  }
});

test("tracing distinguishes the copied sample project from the unset fallback", () => {
  withEnvironment({ LANGSMITH_PROJECT: " cartograph ", LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: " fixture-tracing-key " }, () => {
    assert.equal(aiConfiguration().tracingProject, "cartograph");
    assert.equal(aiConfiguration().tracing, true);
  });
  for (const values of [
    {}, { LANGSMITH_PROJECT: " \t " }, { LANGSMITH_TRACING: "true" },
    { LANGSMITH_API_KEY: "fixture-tracing-key" },
    { LANGSMITH_TRACING: "false", LANGSMITH_API_KEY: "fixture-tracing-key" },
    { LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: " \t " },
  ]) {
    withEnvironment(values, () => {
      assert.equal(aiConfiguration().tracingProject, "default");
      assert.equal(aiConfiguration().tracing, false);
    });
  }
});
