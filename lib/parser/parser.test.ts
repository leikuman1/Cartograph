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
import { ts } from "ts-morph";
import { createRepositoryFileSystem } from "./filesystem";
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
  kind: "import" | "re-export" | "dynamic-import" | "require",
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

test("refuses an import outside the requested root without resolving its target", async () => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "repository/entry.ts": 'export { shared } from "../shared";\n',
      "shared.ts": "export const shared = true;\n",
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(importRecord(result, "entry.ts", "../shared", "re-export").resolution, {
      status: "unresolved",
      reason: "outside-repository-root",
    });
    assert.equal(result.edges.length, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem callbacks refuse outside paths and symlink targets before reading", async t => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "outside/secret.json": "external configuration",
      "repository/local.json": "local configuration",
    });
    await symlink(path.join(parent, "outside"), path.join(root, "linked"), "junction");
    const read = t.mock.method(ts.sys, "readFile", (filePath: string) => {
      assert.equal(filePath, path.join(root, "local.json"));
      return "local configuration";
    });
    const { host, blocked } = createRepositoryFileSystem(root);
    assert.equal(host.readFile(path.join(parent, "outside", "secret.json")), undefined);
    assert.equal(host.fileExists(path.join(parent, "outside", "secret.json")), false);
    assert.equal(host.directoryExists?.(parent), false);
    assert.deepEqual(host.getDirectories?.(parent), []);
    assert.equal(host.readFile(path.join(root, "linked", "secret.json")), undefined);
    assert.equal(host.fileExists(path.join(root, "linked", "secret.json")), false);
    assert.deepEqual(host.getDirectories?.(root), []);
    assert.equal(read.mock.callCount(), 0);
    assert.ok(blocked.has("outside-repository-root"));
    assert.ok(blocked.has("symlink-not-followed"));
    assert.equal(host.readFile(path.join(root, "local.json")), "local configuration");
    assert.equal(read.mock.callCount(), 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("configuration extends cannot read outside the repository or follow a symlink", async t => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "external/base.json": '{"compilerOptions":{"strict":true}}',
      "repository/entry.ts": "export const value = 1;\n",
    });
    await symlink(path.join(parent, "external"), path.join(root, "linked"), "junction");
    const nativeRead = ts.sys.readFile;
    t.mock.method(ts.sys, "readFile", (filePath: string) => {
      assert.equal(path.relative(root, filePath).startsWith(".."), false, filePath);
      assert.equal(filePath.includes(`${path.sep}linked${path.sep}`), false, filePath);
      return nativeRead(filePath);
    });
    for (const config of [
      { extends: "../external/base.json" },
      { extends: "./linked/base.json" },
    ]) {
      await writeFixture(root, { "tsconfig.json": JSON.stringify(config) });
      await assert.rejects(analyzeRepository(root), /Cannot load TypeScript configuration/);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("configuration globs never enumerate directories and internal extends still resolve", async t => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "external/hidden.ts": "export const hidden = 1;\n",
      "repository/config/base.json": JSON.stringify({ compilerOptions: {
        module: "ESNext", moduleResolution: "Bundler", paths: { "@/*": ["../src/*"] },
      } }),
      "repository/tsconfig.json": JSON.stringify({ extends: "./config/base.json", include: ["../**/*"] }),
      "repository/src/entry.ts": 'export { value } from "@/target";\n',
      "repository/src/target.ts": "export const value = 1;\n",
    });
    t.mock.method(ts.sys, "readDirectory", () => { throw new Error("Configuration must not enumerate files"); });
    const result = await analyzeRepository(root);
    assert.equal(result.files.length, 2);
    assert.deepEqual(result.edges, [{ source: "src/entry.ts", target: "src/target.ts", kinds: ["re-export"] }]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("module resolution refuses outside aliases and symlink imports without reading their targets", async t => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "external/value.ts": "export const value = 1;\n",
      "repository/entry.ts": 'import "@outside/value"; import "./linked/value"; import "./local";\n',
      "repository/local.ts": "export const value = 1;\n",
      "repository/tsconfig.json": JSON.stringify({ compilerOptions: {
        module: "ESNext", moduleResolution: "Bundler", paths: { "@outside/*": ["../external/*"] },
      } }),
    });
    await symlink(path.join(parent, "external"), path.join(root, "linked"), "junction");
    const nativeRead = ts.sys.readFile;
    t.mock.method(ts.sys, "readFile", (filePath: string) => {
      assert.equal(path.relative(root, filePath).startsWith(".."), false, filePath);
      assert.equal(filePath.includes(`${path.sep}linked${path.sep}`), false, filePath);
      return nativeRead(filePath);
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(importRecord(result, "entry.ts", "@outside/value", "import").resolution,
      { status: "unresolved", reason: "outside-repository-root" });
    assert.deepEqual(importRecord(result, "entry.ts", "./linked/value", "import").resolution,
      { status: "unresolved", reason: "symlink-not-followed" });
    assert.deepEqual(result.edges, [{ source: "entry.ts", target: "local.ts", kinds: ["import"] }]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("failed import reasons stay the same across files and cached lookups", async () => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    const imports = 'import "./linked/value"; import "@outside/value"; import "@/missing"; import "missing-package";\n';
    await writeFixture(parent, {
      "external/value.ts": "export const value = 1;\n",
      "repository/a.ts": imports,
      "repository/b.ts": 'import "missing-package"; import "@/missing"; import "@outside/value"; import "./linked/value";\n',
      "repository/nested/c.ts": 'import "@outside/value"; import "@/missing"; import "missing-package";\n',
      "repository/tsconfig.json": JSON.stringify({ compilerOptions: {
        module: "ESNext", moduleResolution: "Bundler", baseUrl: ".",
        paths: { "@outside/*": ["../external/*"], "@/*": ["./src/*"] },
      } }),
    });
    await symlink(path.join(parent, "external"), path.join(root, "linked"), "junction");
    const result = await analyzeRepository(root);
    for (const source of ["a.ts", "b.ts"]) {
      assert.deepEqual(importRecord(result, source, "./linked/value", "import").resolution,
        { status: "unresolved", reason: "symlink-not-followed" }, source);
    }
    for (const source of ["a.ts", "b.ts", "nested/c.ts"]) {
      for (const [specifier, reason] of [
        ["@outside/value", "outside-repository-root"],
        ["@/missing", "typescript-could-not-resolve-local-specifier"],
        ["missing-package", "typescript-could-not-resolve-local-specifier"],
      ]) {
        assert.deepEqual(importRecord(result, source, specifier, "import").resolution,
          { status: "unresolved", reason }, `${source}: ${specifier}`);
      }
    }
    assert.equal(result.edges.length, 0);
    assert.equal(result.coverage.imports.unresolved, 11);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("failure reasons ignore unselected paths patterns and baseUrl candidates", async () => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "external/value.ts": "export const value = 1;\n",
      "repository/a.ts": 'import "@/exact"; import "@/specific/value"; import "@/fallback";\n',
      "repository/b.ts": 'import "@/exact"; import "@/specific/value"; import "@/fallback";\n',
      "repository/local.ts": "export const value = 1;\n",
      "repository/tsconfig.json": JSON.stringify({ compilerOptions: {
        module: "ESNext", moduleResolution: "Bundler", baseUrl: "../external",
        paths: {
          "@/*": ["./*"],
          "@/exact": ["../repository/missing/exact"],
          "@/specific/*": ["../repository/missing/*"],
          "@/fallback": ["./value", "../repository/local"],
        },
      } }),
    });
    const result = await analyzeRepository(root);
    for (const source of ["a.ts", "b.ts"]) {
      for (const specifier of ["@/exact", "@/specific/value"]) {
        assert.deepEqual(importRecord(result, source, specifier, "import").resolution,
          { status: "unresolved", reason: "typescript-could-not-resolve-local-specifier" }, specifier);
      }
      assert.deepEqual(importRecord(result, source, "@/fallback", "import").resolution,
        { status: "internal", target: "local.ts" });
    }
    assert.equal(result.edges.length, 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("failure diagnosis uses inherited paths origins and rootDirs candidates", async () => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    await writeFixture(parent, {
      "external/value.ts": "export const value = 1;\n",
      "repository/config/base.json": JSON.stringify({ compilerOptions: {
        module: "ESNext", moduleResolution: "Bundler", paths: { "@/*": ["./missing/*"] },
        rootDirs: ["../src", "../linked"],
      } }),
      "repository/tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "repository/src/a.ts": 'import "@/value"; import "./value";\n',
      "repository/src/b.ts": 'import "./value"; import "@/value";\n',
    });
    for (const directory of ["missing", "linked"]) {
      await symlink(path.join(parent, "external"), path.join(root, directory), "junction");
    }
    const result = await analyzeRepository(root);
    for (const source of ["src/a.ts", "src/b.ts"]) {
      assert.deepEqual(importRecord(result, source, "@/value", "import").resolution,
        { status: "unresolved", reason: "typescript-could-not-resolve-local-specifier" });
      assert.deepEqual(importRecord(result, source, "./value", "import").resolution,
        { status: "unresolved", reason: "symlink-not-followed" });
    }
    assert.equal(result.edges.length, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

for (const scenario of [
  { baseUrl: "../external", reason: "outside-repository-root" },
  { baseUrl: "./linked", reason: "symlink-not-followed" },
]) {
  test(`baseUrl failures preserve ${scenario.reason} across files`, async () => {
    const parent = await temporaryRepository();
    const root = path.join(parent, "repository");
    try {
      await writeFixture(parent, {
        "external/value.ts": "export const value = 1;\n",
        "repository/a.ts": 'import "value";\n',
        "repository/b.ts": 'import "value";\n',
        "repository/tsconfig.json": JSON.stringify({ compilerOptions: {
          module: "ESNext", moduleResolution: "Bundler", baseUrl: scenario.baseUrl,
        } }),
      });
      await symlink(path.join(parent, "external"), path.join(root, "linked"), "junction");
      const result = await analyzeRepository(root);
      for (const source of ["a.ts", "b.ts"]) {
        assert.deepEqual(importRecord(result, source, "value", "import").resolution,
          { status: "unresolved", reason: scenario.reason });
      }
      assert.equal(result.edges.length, 0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
}

test("failure diagnosis includes TypeScript extension and index probes", async () => {
  const parent = await temporaryRepository();
  const root = path.join(parent, "repository");
  try {
    const imports = 'import "./linked"; import "./linked.js"; import "./directory"; import "./native";\n';
    await writeFixture(parent, {
      "external/value.ts": "export const value = 1;\n",
      "repository/a.ts": imports,
      "repository/b.ts": imports,
      "repository/tsconfig.json": JSON.stringify({ compilerOptions: {
        module: "ESNext", moduleResolution: "Bundler", moduleSuffixes: [".native", ""],
      } }),
    });
    // Junctions also work on Windows without file-symlink privileges. Give them
    // source filenames to exercise the resolver's extension and index probes.
    for (const target of ["linked.ts", "directory/index.ts", "native.native.ts"]) {
      const destination = path.join(root, target);
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(path.join(parent, "external"), destination, "junction");
    }
    const result = await analyzeRepository(root);
    for (const source of ["a.ts", "b.ts"]) {
      for (const specifier of ["./linked", "./linked.js", "./directory", "./native"]) {
        assert.deepEqual(importRecord(result, source, specifier, "import").resolution,
          { status: "unresolved", reason: "symlink-not-followed" }, `${source}: ${specifier}`);
      }
    }
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

test("CommonJS requires share resolution, report real coverage, and deduplicate mixed edges", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true, paths: { "@/*": ["./src/*"] } } }),
      "src/entry.js": [
        'import "./value";',
        'require("./value"); require("./value");',
        'require("@/value");',
        'require("./folder");',
        'require("express"); require("node:fs");',
        'require("./missing"); require("./style.css");',
        'const name = "./value"; require(name); require(`./value`);',
      ].join("\n"),
      "src/value.js": "exports.value = 1;\n",
      "src/folder/index.js": "module.exports = function run() {};\n",
      "src/style.css": "body {}\n",
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(result.edges, [
      { source: "src/entry.js", target: "src/folder/index.js", kinds: ["require"] },
      { source: "src/entry.js", target: "src/value.js", kinds: ["import", "require"] },
    ]);
    assert.deepEqual(result.coverage.imports, { discovered: 11, internal: 5, external: 2, excluded: 3, unresolved: 1 });
    assert.equal(result.files.find(file => file.path === "src/entry.js")?.fanOut, 2);
    assert.equal(result.files.find(file => file.path === "src/value.js")?.fanIn, 1);
    assert.deepEqual(importRecord(result, "src/entry.js", "./missing", "require").resolution,
      { status: "unresolved", reason: "typescript-could-not-resolve-local-specifier" });
    assert.deepEqual(importRecord(result, "src/entry.js", "./style.css", "require").resolution,
      { status: "excluded", reason: "target-unsupported-extension", target: "src/style.css" });
    assert.deepEqual(importRecord(result, "src/entry.js", null, "require").resolution,
      { status: "excluded", reason: "require-not-string-literal" });
    assert.deepEqual(await writeAnalysisResult(path.join(root, "result.json"), result), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only runtime require bindings create CommonJS dependencies", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "entry.js": [
        'require("./target");',
        'function parameter(require) { require("./fake-parameter"); }',
        'function hoisted() { require("./fake-var"); var require; }',
        '{ require("./fake-block"); const require = () => {}; }',
        'const object = { require() {} }; object.require("./fake-property");',
        'require.resolve("./fake-resolve");',
        'function destructured({ require }) { require("./fake-destructured"); }',
        'try {} catch (require) { require("./fake-catch"); }',
        'function nested() { require("./target"); }',
      ].join("\n"),
      "local.js": 'require("./fake-local"); const require = () => {};',
      "imported.ts": 'import require from "loader"; require("./fake-imported");',
      "target.js": "module.exports = 1;",
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(result.imports.filter(record => record.kind === "require").map(record => record.specifier),
      ["./target", "./target"]);
    assert.deepEqual(result.edges, [{ source: "entry.js", target: "target.js", kinds: ["require"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambient CommonJS declarations describe runtime globals without hiding real local bindings", async () => {
  const root = await temporaryRepository();
  try {
    const globals = [
      'var require: (specifier: string) => unknown;',
      'var module: { exports: unknown };',
      'var exports: Record<string, unknown>;',
    ].join("\n");
    await writeFixture(root, {
      "ambient-variable.ts": [
        'declare var require: (specifier: string) => unknown;',
        'declare const module: { exports: unknown };',
        'declare const exports: Record<string, unknown>;',
        'require("./target"); exports.named = 1; module.exports.extra = 2;',
        'function local(require: (specifier: string) => unknown) { require("./fake-parameter"); }',
        'function hoisted() { require("./fake-var"); var require; }',
        '{ require("./fake-block"); const require = () => {}; }',
      ].join("\n"),
      "ambient-function.ts": 'declare function require(specifier: string): unknown; require("./target");',
      "ambient-global.ts": `export {}; declare global { ${globals} }\nrequire("./target"); exports.named = 1; module.exports.extra = 2;`,
      "local.ts": [
        `export {}; declare global { ${globals} }`,
        'require("./fake-local"); const require = () => {};',
        'const module = { exports: {} }; const exports = {};',
        'module.exports = { fake: true }; exports.alsoFake = true;',
      ].join("\n"),
      "target.js": "module.exports = 1;",
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(result.edges, [
      { source: "ambient-function.ts", target: "target.js", kinds: ["require"] },
      { source: "ambient-global.ts", target: "target.js", kinds: ["require"] },
      { source: "ambient-variable.ts", target: "target.js", kinds: ["require"] },
    ]);
    assert.deepEqual(result.imports.map(record => record.specifier), ["./target", "./target", "./target"]);
    assert.deepEqual(Object.fromEntries(result.files.map(file => [file.path, file.exports])), {
      "ambient-function.ts": [], "ambient-global.ts": ["extra", "named"],
      "ambient-variable.ts": ["extra", "named"], "local.ts": [], "target.js": ["default"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS exports keep literal names, replacements, and exports alias identity", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "named.js": 'exports.alpha = 1; module.exports.beta = 2; exports["quoted-name"] = 3; exports[key] = 4;',
      "object.cjs": 'module.exports = { value: 1, shorthand, method() {}, get getter() { return 1; }, ["literal"]: 2, [dynamic]: 3, ...unknown };',
      "keys.js": 'module.exports = { 0x10: true, [0x20]: true, ["__proto__"]: true, "escaped\\u002dkey": true };',
      "function.js": 'module.exports = function app() {}; module.exports.handler = () => {};',
      "replacement.js": 'exports.old = 1; module.exports = { current: 1 }; exports.detached = 2; module.exports.last = 3;',
      "reattached.js": 'module.exports = exports = {}; exports.active = true;',
      "detached.js": 'exports = { local: 1 }; exports.hidden = 1;',
      "shadowed.js": 'const module = {}; const exports = {}; module.exports = { fake: true }; exports.alsoFake = true;',
      "nested.js": 'function set(exports) { exports.fake = 1; } if (flag) module.exports = { uncertain: 1 };',
      "esm.ts": 'export const existing = 1; export default existing;',
    });
    const result = await analyzeRepository(root);
    const names = Object.fromEntries(result.files.map(file => [file.path, file.exports]));
    assert.deepEqual(names, {
      "detached.js": [], "esm.ts": [], "function.js": ["default", "handler"],
      "keys.js": ["16", "32", "__proto__", "escaped-key"],
      "named.js": ["alpha", "beta", "quoted-name"], "nested.js": [],
      "object.cjs": ["getter", "literal", "method", "shorthand", "value"],
      "reattached.js": ["active"], "replacement.js": ["current", "last"], "shadowed.js": [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommonJS exports follow direct top-level initializer and ordinary assignment chains", async () => {
  const root = await temporaryRepository();
  try {
    await writeFixture(root, {
      "app.js": 'var app = module.exports = express(); module.exports.handler = handler;',
      "router.js": 'const router = module.exports = express.Router();',
      "initializers.js": [
        'exports.old = 1;',
        'var app = module.exports = { current: 1 }, last = module.exports.last = 2;',
        'exports.detached = 3;',
      ].join("\n"),
      "let.js": 'exports.old = 1; let app = module.exports = { current: 1 }; exports.detached = 2;',
      "outer.js": 'exports.old = 1; app = module.exports = { current: 1 }; exports.detached = 2; module.exports.last = 3;',
      "property.js": 'holder.app = module.exports = value;',
      "reattached-initializer.js": 'const app = module.exports = exports = {}; exports.active = true;',
      "reattached-outer.js": 'app = exports = module.exports = {}; exports.active = true;',
      "detached.js": 'const local = exports = { local: 1 }; app = exports.hidden = 2;',
      "shadowed.js": 'const module = { exports: {} }; const exports = {}; const app = module.exports = { fake: 1 }; app = exports.alsoFake = 2;',
      "conditional.js": [
        'const app = flag && (module.exports = { conditional: 1 });',
        'app = flag ? module.exports = { branch: 1 } : null;',
        'const make = () => module.exports = { nested: 1 };',
        'const called = consume(module.exports = { argument: 1 });',
        'if (flag) { const router = module.exports = { block: 1 }; }',
        'for (const item of items) app = module.exports = { loop: 1 };',
        'function initialize() { const app = module.exports = { functionBody: 1 }; }',
      ].join("\n"),
    });
    const result = await analyzeRepository(root);
    assert.deepEqual(Object.fromEntries(result.files.map(file => [file.path, file.exports])), {
      "app.js": ["default", "handler"], "conditional.js": [], "detached.js": [],
      "initializers.js": ["current", "last"], "let.js": ["current"],
      "outer.js": ["current", "last"], "property.js": ["default"],
      "reattached-initializer.js": ["active"], "reattached-outer.js": ["active"],
      "router.js": ["default"], "shadowed.js": [],
    });
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
