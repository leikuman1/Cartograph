import assert from "node:assert/strict";
import { analysis } from "../lib/canvas/fixture";
import { countFileCategories, repositoryDetails } from "../lib/canvas/details";
import { categories, foldFolders } from "../lib/canvas/graph";
import type { FileNode, GraphEdge } from "../lib/parser/contract";

const details = repositoryDetails(analysis.files, analysis.edges);
for (const file of analysis.files) {
  const item = details.byPath.get(file.path);
  assert(item);
  assert.equal(item.dependencies.length, file.fanOut, file.path);
  assert.equal(item.dependents.length, file.fanIn, file.path);
  assert.deepEqual(item.dependencies.map(file => file.path), analysis.edges.filter(edge => edge.source === file.path).map(edge => edge.target).sort());
  assert.deepEqual(item.dependents.map(file => file.path), analysis.edges.filter(edge => edge.target === file.path).map(edge => edge.source).sort());
}
assert.deepEqual(details.entryPoints.map(item => item.file.path), analysis.files.filter(file => file.fanIn === 0).map(file => file.path).sort());
assert.equal(details.mostImported.length + details.entryPoints.length, analysis.files.length);
for (let index = 1; index < details.mostImported.length; index += 1) {
  const before = details.mostImported[index - 1];
  const current = details.mostImported[index];
  assert(before.dependents.length > current.dependents.length || (before.dependents.length === current.dependents.length && before.file.path < current.file.path));
}
for (const group of foldFolders(analysis.files, analysis.edges).groups) {
  const counts = countFileCategories(group.files);
  assert.equal(categories.reduce((total, category) => total + counts[category.id], 0), group.files.length);
}
assert.deepEqual(repositoryDetails([...analysis.files].reverse(), [...analysis.edges].reverse()).mostImported, details.mostImported);

const sampleFiles: FileNode[] = ["a.ts", "b.ts", "c.ts"].map(path => ({ path, folder: ".", module: ".", lineCount: 1, contentHash: "sample", fanIn: 0, fanOut: 0 }));
const sampleEdges: GraphEdge[] = [
  { source: "a.ts", target: "b.ts", kinds: ["import"] },
  { source: "a.ts", target: "b.ts", kinds: ["dynamic-import"] },
  { source: "b.ts", target: "a.ts", kinds: ["re-export"] },
  { source: "b.ts", target: "b.ts", kinds: ["import"] },
];
const sample = repositoryDetails(sampleFiles, sampleEdges);
assert.deepEqual(sample.byPath.get("a.ts")?.dependencies.map(file => file.path), ["b.ts"]);
assert.deepEqual(sample.byPath.get("b.ts")?.dependencies.map(file => file.path), ["a.ts", "b.ts"]);
assert.deepEqual(sample.byPath.get("b.ts")?.dependents.map(file => file.path), ["a.ts", "b.ts"]);
assert.deepEqual(sample.entryPoints.map(item => item.file.path), ["c.ts"]);
assert.deepEqual(countFileCategories([{ ...sampleFiles[0], path: "types.d.ts" }, { ...sampleFiles[0], path: "src/thing.test.ts" }, sampleFiles[0]]), { source: 1, test: 1, declaration: 1 });
assert.equal(repositoryDetails([], []).byPath.size, 0);
assert.deepEqual(repositoryDetails([], []).entryPoints, []);
assert.throws(() => repositoryDetails(sampleFiles, [{ source: "a.ts", target: "missing.ts", kinds: ["import"] }]), /Missing file/);

console.log(`Detail counts and complete neighbor lists agree for all ${analysis.files.length} files and ${analysis.edges.length} edges.`);
console.log(`${details.mostImported.length} files with dependents; ${details.entryPoints.length} reading entry points; ${details.categoryCounts.source} files use the fallback Source kind.`);
console.log("Ordering, folder type totals, duplicate edges, cycles, self-imports, isolated files, empty data and missing endpoints: passed.");
