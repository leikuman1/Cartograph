import assert from "node:assert/strict";
import { analysis } from "../lib/canvas/fixture";
import { fileImporters } from "../lib/canvas/details";
import { categories, fileCategory, foldFolders } from "../lib/canvas/graph";
import {
  buildInsights, entryExclusionCounts, entryReason, insightCount, TRAVERSAL_DEPTH,
  traverse, UNUSUALLY_IMPORTED, LONG_FILE_LINES,
} from "../lib/canvas/insights";
import type { FileNode, GraphEdge } from "../lib/parser/contract";

const insights = buildInsights(analysis.files, analysis.edges);
const importers = fileImporters(analysis.files, analysis.edges);
const paths = new Set(analysis.files.map(file => file.path));

for (const file of insights.unimported) {
  assert.equal(file.fanIn, 0, file.path);
  assert.equal(importers.get(file.path)?.size, 0, file.path);
  assert.equal(entryReason(file.path), null, file.path);
}
for (const file of analysis.files) {
  if (file.fanIn === 0 && entryReason(file.path) === null) assert(insights.unimported.some(item => item.path === file.path), file.path);
}
assert.equal(insights.unimported.length + analysis.files.filter(file => entryReason(file.path) !== null && file.fanIn === 0).length, analysis.files.filter(file => file.fanIn === 0).length);
for (const file of insights.widelyImported) assert(file.fanIn >= UNUSUALLY_IMPORTED, file.path);
for (const file of insights.longFiles) assert(file.lineCount >= LONG_FILE_LINES, file.path);

const edgeSet = new Set(analysis.edges.map(edge => `${edge.source}\0${edge.target}`));
for (const cycle of insights.cycles) {
  assert(cycle.length >= 2, "A cycle has at least one edge");
  for (let index = 1; index < cycle.length; index += 1) {
    assert(edgeSet.has(`${cycle[index - 1]}\0${cycle[index]}`), `Missing cycle edge ${cycle[index - 1]} -> ${cycle[index]}`);
  }
  assert.equal(cycle[0], cycle.at(-1), "A cycle returns to its start");
  assert(cycle.every(path => paths.has(path)), "A cycle only names parsed files");
}
assert(insights.cycles.length > 0, "The fixture must contain a real cycle");
for (const cycle of insights.cycles) assert.equal(cycle.slice(0, -1).length, new Set(cycle.slice(0, -1)).size, "A shortest cycle does not repeat files");
assert(!insights.unimported.some(file => file.path === "vitest.config.ts"), "A config entry point must stay out of the unimported insight");
assert(!insights.unimported.some(file => file.path === "runtime-tests/node/vitest.config.ts"), "Every zero-importer config is an entry point");
assert.equal(entryReason("runtime-tests/node/vitest.config.ts"), "config", "A config is reported as a config, not a test");
assert.equal(entryReason("src/thing.test.ts"), "test");
assert(!insights.unimported.some(file => file.path === ".vitest.config/setup-vitest.ts"), "Tool config directories are entry points");
assert(insights.unimported.some(file => file.path === "src/adapter/aws-lambda/index.ts"), "A real source file with no importer must be reported");

const client = "src/client/client.ts";
const blast = traverse(analysis.files, analysis.edges, client, "dependents");
const chain = traverse(analysis.files, analysis.edges, client, "dependencies");
assert.equal(blast.levels.length <= TRAVERSAL_DEPTH, true);
assert.equal(chain.levels.length <= TRAVERSAL_DEPTH, true);
assert.deepEqual(blast.levels[0].files.map(file => file.path), analysis.edges.filter(edge => edge.target === client).map(edge => edge.source).sort());
assert.deepEqual(chain.levels[0].files.map(file => file.path), analysis.edges.filter(edge => edge.source === client).map(edge => edge.target).sort());
assert(!blast.files.some(file => file.path === client), "The root is not in its own result");
assert(!chain.files.some(file => file.path === client), "The root is not in its own result");
assert.equal(blast.levels[1].files.every(file => !blast.levels[0].files.some(first => first.path === file.path)), true);
assert.equal(traverse(analysis.files, analysis.edges, client, "dependents", 0).files.length, 0);
assert.deepEqual(traverse([...analysis.files].reverse(), [...analysis.edges].reverse(), client, "dependents"), blast);

// A chain longer than the depth limit must stop exactly at the limit.
const chainFiles: FileNode[] = ["a", "b", "c", "d", "e"].map(path => ({ path, folder: ".", module: ".", lineCount: 1, contentHash: "x", fanIn: 0, fanOut: 0 }));
const chainEdges: GraphEdge[] = ["a", "b", "c", "d"].map((source, index) => ({ source, target: chainFiles[index + 1].path, kinds: ["import"] }));
const limited = traverse(chainFiles, chainEdges, "a", "dependencies");
assert.deepEqual(limited.levels.map(level => level.files.map(file => file.path)), [["b"], ["c"]]);
assert.deepEqual(limited.files.map(file => file.path), ["b", "c"]);
assert.deepEqual(traverse(chainFiles, chainEdges, "a", "dependencies", 4).files.map(file => file.path), ["b", "c", "d", "e"]);
const ring: GraphEdge[] = [{ source: "a", target: "b", kinds: ["import"] }, { source: "b", target: "a", kinds: ["import"] }];
assert.deepEqual(traverse(chainFiles.slice(0, 2), ring, "a", "dependencies").files.map(file => file.path), ["b"]);
assert.deepEqual(traverse(chainFiles.slice(0, 2), ring, "a", "dependents").files.map(file => file.path), ["b"]);

const selfFile: FileNode[] = [{ path: "self.ts", folder: ".", module: ".", lineCount: 1, contentHash: "x", fanIn: 0, fanOut: 0 }];
assert.deepEqual(buildInsights(selfFile, [{ source: "self.ts", target: "self.ts", kinds: ["import"] }]).cycles, [["self.ts", "self.ts"]]);
assert.throws(() => traverse(selfFile, [], "missing.ts", "dependencies"), /Missing traversal root/);
assert.throws(() => traverse(selfFile, [{ source: "self.ts", target: "ghost.ts", kinds: ["import"] }], "self.ts", "dependencies"), /missing file/);

// Iterative cycle detection must handle a path far deeper than a recursive walk would survive.
const deep: FileNode[] = Array.from({ length: 60_000 }, (_, index) => ({ path: `deep/${index}.ts`, folder: "deep", module: ".", lineCount: 1, contentHash: "x", fanIn: 0, fanOut: 0 }));
const deepEdges: GraphEdge[] = deep.map((file, index) => ({ source: file.path, target: deep[(index + 1) % deep.length].path, kinds: ["import"] }));
const deepInsights = buildInsights(deep, deepEdges);
assert.equal(deepInsights.cycles.length, 1);
assert.equal(deepInsights.cycles[0].length, deep.length + 1);

const exclusions = entryExclusionCounts(analysis.files.filter(file => file.fanIn === 0));
assert.equal(Object.values(exclusions).reduce((total, count) => total + count, 0), analysis.files.filter(file => file.fanIn === 0 && entryReason(file.path) !== null).length);
const folded = foldFolders(analysis.files, analysis.edges);
for (const category of categories) {
  const sidebarCount = analysis.files.filter(file => fileCategory(file.path) === category.id).length;
  const panelTotal = folded.groups.reduce((total, group) => total + group.files.filter(file => fileCategory(file.path) === category.id).length, 0);
  assert.equal(panelTotal, sidebarCount, category.id);
  assert.equal(folded.groups.reduce((total, group) => total + group.files.length, 0), analysis.files.length);
}

console.log(`Unimported: ${insights.unimported.length}; widely imported (>=${UNUSUALLY_IMPORTED}): ${insights.widelyImported.length}; cycles: ${insights.cycles.length}; long files (>=${LONG_FILE_LINES} lines): ${insights.longFiles.length}; total ${insightCount(insights)}.`);
console.log(`Entry points excluded from the unimported insight: ${Object.values(exclusions).reduce((total, count) => total + count, 0)} (${exclusions.test} tests, ${exclusions.config} configs, ${exclusions["framework-entry"]} routes, ${exclusions["ambient-declaration"]} declarations).`);
for (const cycle of insights.cycles) console.log(`Cycle: ${cycle.join(" → ")}`);
console.log(`${client}: ${blast.files.length} dependents and ${chain.files.length} dependencies within ${TRAVERSAL_DEPTH} steps.`);
console.log("Depth limiting, self-imports, cycles longer than a recursion stack, ordering, category totals and determinism: passed.");
