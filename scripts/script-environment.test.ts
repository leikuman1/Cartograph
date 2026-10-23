import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const loader = fileURLToPath(new URL("./environment.ts", import.meta.url));

test("standalone scripts share Next environment precedence, expansion and test isolation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cartograph-env-"));
  try {
    await Promise.all([
      writeFile(path.join(directory, ".env"), "CARTOGRAPH_ENV_BASE=base\nCARTOGRAPH_ENV_ORDER=base\nCARTOGRAPH_ENV_EXPANDED=$CARTOGRAPH_ENV_BASE/suffix\n"),
      writeFile(path.join(directory, ".env.local"), "CARTOGRAPH_ENV_ORDER=local\n"),
      writeFile(path.join(directory, ".env.development"), "CARTOGRAPH_ENV_MODE=development\n"),
      writeFile(path.join(directory, ".env.development.local"), "CARTOGRAPH_ENV_ORDER=development-local\n"),
      writeFile(path.join(directory, ".env.production"), "CARTOGRAPH_ENV_MODE=production\n"),
      writeFile(path.join(directory, ".env.test"), "CARTOGRAPH_ENV_MODE=test\n"),
    ]);
    const program = `const {loadScriptEnvironment} = require(${JSON.stringify(loader)}); loadScriptEnvironment(process.argv[1]); console.log(JSON.stringify([process.env.CARTOGRAPH_ENV_ORDER, process.env.CARTOGRAPH_ENV_MODE, process.env.CARTOGRAPH_ENV_EXPANDED]));`;
    for (const [mode, inherited, expected] of [
      ["development", undefined, ["development-local", "development", "base/suffix"]],
      ["production", undefined, ["local", "production", "base/suffix"]],
      ["test", undefined, ["base", "test", "base/suffix"]],
      ["development", "shell", ["shell", "development", "base/suffix"]],
    ] as const) {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: mode };
      for (const key of Object.keys(env)) if (key.startsWith("CARTOGRAPH_ENV_") || key === "__NEXT_PROCESSED_ENV") delete env[key];
      if (inherited) env.CARTOGRAPH_ENV_ORDER = inherited;
      const child = spawnSync(process.execPath, ["--import", "tsx", "-e", program, directory], { env, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout.trim()), expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
