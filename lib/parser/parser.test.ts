import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeRepository,
  readAnalysisResult,
  writeAnalysisResult,
} from "./index";
import { validateAnalysisResult } from "./serialization";

async function writeFixture(root: string, files: Readonly<Record<string, string>>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function importRecord(
  result: Awaited<ReturnType<typeof analyzeRepository>>,
  source: string,
  specifier: string | null,
  kind: "import" | "re-export" | "dynamic-import",
) {
  const occurrence = result.imports.find(candidate =>
    candidate.source === source
      && candidate.specifier === specifier
      && candidate.kind === kind,
  );
  assert.ok(occurrence, `Missing ${kind} ${source} -> ${specifier}.`);
  return occurrence;
}

async function temporaryRepository() {
  return mkdtemp(path.join(tmpdir(), "cartograph-parser-"));
}

const indexContent = [
  'import { value } from "@/value";',
  'import type { TypeOnly } from "./types";',
  'import "./style.css";',
  'import data from "./data.json";',
  'import "./malformed";',
  'import { missing } from "./missing";',
  'import { format } from "external-package";',
  'export { value as again } from "@/value";',
  'export const promise = import("./dynamic");',
  'const name = "./dynamic"; void import(name);',
  'export { data, format, missing, value };',
  'export type Result = TypeOnly;',
].join("\n") + "\n";

test("analyzes a complete repository into verified files, imports, and edges", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      ".gitignore": "ignored/*\n!ignored/keep.ts\ngenerated/\n",
      "package.json": "{\"name\":\"fixture\"}\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          allowJs: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@/*": ["./src/*"] },
          resolveJsonModule: true,
          strict: true,
        },
      }),
      "README.md": "fixture\n",
      "generated/hidden.ts": "export const hidden = true;\n",
      "ignored/drop.ts": "export const dropped = true;\n",
      "ignored/keep.ts": "export const kept = true;\n",
      "link-target/file.ts": "export const linked = true;\n",
      "packages/pkg/.gitignore": "*.ts\n!keep.ts\n",
      "packages/pkg/package.json": "{\"name\":\"nested\"}\n",
      "packages/pkg/drop.ts": "export const dropped = true;\n",
      "packages/pkg/keep.ts": "export const kept = true;\n",
      "src/data.json": "{\"value\":1}\n",
      "src/dynamic.ts": "export const dynamic = true;\n",
      "src/index.ts": indexContent,
      "src/malformed.ts": "export const = ;\n",
      "src/style.css": "body {}\n",
      "src/types.ts": "export type TypeOnly = string;\n",
      "src/value.ts": 'import "./value"; export const value = 1;\n',
    });
    await symlink(path.join(root, "link-target"), path.join(root, "linked"), "junction");

    const result = await analyzeRepository(root);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.coverage.files.discovered, result.coverage.files.parsed + result.coverage.files.skipped);
    assert.equal(result.coverage.files.parsed, result.files.length);
    assert.equal(result.coverage.files.skipped, result.coverage.files.skippedFiles.length);
    assert.ok(result.coverage.files.excludedDirectories.some(directory =>
      directory.path === "generated" && directory.reason === "ignored",
    ));
    assert.ok(result.coverage.files.excludedDirectories.some(directory =>
      directory.path === "linked" && directory.reason === "symlink",
    ));

    const skipped = new Map(result.coverage.files.skippedFiles.map(file => [file.path, file.reason]));
    assert.equal(skipped.get("ignored/drop.ts"), "ignored");
    assert.equal(skipped.get("packages/pkg/drop.ts"), "ignored");
    assert.equal(skipped.get("README.md"), "unsupported-extension");
    assert.equal(skipped.get("src/malformed.ts"), "parse-failed");
    assert.equal(skipped.get("src/style.css"), "unsupported-extension");
    assert.equal(skipped.get("src/data.json"), "unsupported-extension");

    const indexFile = result.files.find(file => file.path === "src/index.ts");
    assert.ok(indexFile);
    assert.equal(indexFile.folder, "src");
    assert.equal(indexFile.module, ".");
    assert.equal(indexFile.lineCount, 12);
    assert.equal(indexFile.contentHash, createHash("sha256").update(indexContent).digest("hex"));
    assert.equal(result.files.find(file => file.path === "packages/pkg/keep.ts")?.module, "packages/pkg");
    assert.ok(result.files.every(file => file.folder.length > 0));

    assert.deepEqual(importRecord(result, "src/index.ts", "@/value", "import").resolution, {
      status: "internal",
      target: "src/value.ts",
    });
    assert.deepEqual(importRecord(result, "src/index.ts", "@/value", "re-export").resolution, {
      status: "internal",
      target: "src/value.ts",
    });
    assert.equal(importRecord(result, "src/index.ts", "./style.css", "import").resolution.status, "excluded");
    assert.equal(importRecord(result, "src/index.ts", "./data.json", "import").resolution.status, "excluded");
    assert.deepEqual(importRecord(result, "src/index.ts", "./missing", "import").resolution, {
      status: "unresolved",
      reason: "typescript-could-not-resolve-local-specifier",
    });
    assert.deepEqual(importRecord(result, "src/index.ts", "external-package", "import").resolution, {
      status: "external",
      reason: "package-specifier",
    });
    assert.deepEqual(importRecord(result, "src/index.ts", null, "dynamic-import").resolution, {
      status: "excluded",
      reason: "dynamic-import-not-string-literal",
    });
    assert.deepEqual(importRecord(result, "src/index.ts", "./malformed", "import").resolution, {
      status: "excluded",
      target: "src/malformed.ts",
      reason: "target-parse-failed",
    });

    const indexToValue = result.edges.find(edge =>
      edge.source === "src/index.ts" && edge.target === "src/value.ts",
    );
    assert.deepEqual(indexToValue?.kinds, ["import", "re-export"]);
    assert.deepEqual(result.edges.find(edge =>
      edge.source === "src/index.ts" && edge.target === "src/dynamic.ts",
    )?.kinds, ["dynamic-import"]);
    assert.deepEqual(result.edges.find(edge =>
      edge.source === "src/value.ts" && edge.target === "src/value.ts",
    )?.kinds, ["import"]);
    assert.equal(indexFile.fanOut, 3);
    assert.equal(indexFile.fanIn, 0);
    const valueFile = result.files.find(file => file.path === "src/value.ts");
    assert.equal(valueFile?.fanIn, 2);
    assert.equal(valueFile?.fanOut, 1);

    const secondResult = await analyzeRepository(root);
    assert.deepEqual(secondResult, result);

    const output = path.join(root, "analysis.json");
    const written = await writeAnalysisResult(output, result);
    assert.deepEqual(written, result);
    assert.deepEqual(await readAnalysisResult(output), result);
    assert.throws(() => validateAnalysisResult({
      ...result,
      coverage: {
        ...result.coverage,
        files: {
          ...result.coverage.files,
          parsed: result.coverage.files.parsed + 1,
        },
      },
    }), /does not equal parsed plus skipped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renaming one imported file reports exactly one unresolved import", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "entry.ts": 'import { value } from "./target"; export const result = value;\n',
      "target.ts": "export const value = 1;\n",
    });

    const before = await analyzeRepository(root);
    assert.equal(before.coverage.imports.unresolved, 0);

    await rename(path.join(root, "target.ts"), path.join(root, "target-renamed.ts"));
    const after = await analyzeRepository(root);
    const unresolved = after.imports.filter(occurrence => occurrence.resolution.status === "unresolved");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].source, "entry.ts");
    assert.equal(unresolved[0].specifier, "./target");
    assert.deepEqual(unresolved[0].resolution, {
      status: "unresolved",
      reason: "typescript-could-not-resolve-local-specifier",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a resolved file outside the requested root as external", async () => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "repository/entry.ts": 'export { shared } from "../shared";\n',
      "shared.ts": "export const shared = true;\n",
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(importRecord(result, "entry.ts", "../shared", "re-export").resolution, {
      status: "external",
      reason: "resolved-outside-root",
    });
    assert.equal(result.edges.length, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "include matches no inputs", extension: ".ts", inputs: { include: ["missing/**/*"] } },
  { name: "JavaScript files without allowJs", extension: ".js", inputs: {} },
  { name: "an empty files list", extension: ".ts", inputs: { files: [] } },
]) {
  test(`uses compiler options when the configuration has ${scenario.name}`, async () => {
    const root = await temporaryRepository();
    try {
      await writeFixture(root, {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            paths: { "@/*": ["./actual/*"] },
          },
          ...scenario.inputs,
        }),
        [`actual/entry${scenario.extension}`]: 'import { value } from "@/target"; export const result = value;\n',
        [`actual/target${scenario.extension}`]: "export const value = 1;\n",
      });
      const result = await analyzeRepository(root);
      assert.equal(result.files.length, 2);
      assert.equal(result.coverage.imports.unresolved, 0);
      assert.deepEqual(result.edges, [{
        source: `actual/entry${scenario.extension}`,
        target: `actual/target${scenario.extension}`,
        kinds: ["import"],
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("empty input diagnostics do not suppress invalid compiler options", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "entry.ts": "export const value = true;\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "invalid-module-kind" },
        include: ["missing/**/*"],
      }),
    });
    await assert.rejects(analyzeRepository(root), /TS6046/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI accepts a forwarded separator and keeps unknown options invalid", async () => {
  const root = await temporaryRepository();
  const invoke = (args: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", path.resolve("scripts/analyze.ts"), ...args,
  ], { encoding: "utf8", timeout: 15000 });
  try {
    await writeFixture(root, { "entry.ts": "export const value = 1;\n" });
    const ordinary = invoke([root]);
    const separated = invoke(["--", root]);
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(separated.status, 0, separated.stderr);
    const result = validateAnalysisResult(JSON.parse(separated.stdout));
    assert.equal(result.files.length, 1);
    assert.deepEqual(result, validateAnalysisResult(JSON.parse(ordinary.stdout)));

    const unknown = invoke(["--unknown", root]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option: --unknown/);
    const missing = invoke([]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Usage: pnpm analyze <directory>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails loudly when the nearest TypeScript configuration cannot be loaded", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "entry.ts": "export const value = true;\n",
      "tsconfig.json": '{"extends":"./missing.json"}\n',
    });
    await assert.rejects(analyzeRepository(root), /Cannot load TypeScript configuration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
