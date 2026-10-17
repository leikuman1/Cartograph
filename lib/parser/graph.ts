import type {
  FileMetadata,
  FileNode,
  GraphEdge,
  ImportKind,
  InternalImport,
} from "./contract";

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEdges(left: GraphEdge, right: GraphEdge) {
  return compareText(left.source, right.source) || compareText(left.target, right.target);
}

export function buildGraph(
  fileMetadata: readonly FileMetadata[],
  imports: readonly InternalImport[],
): { files: FileNode[]; edges: GraphEdge[] } {
  const paths = new Set(fileMetadata.map(file => file.path));
  const edgeKinds = new Map<string, Set<ImportKind>>();

  for (const occurrence of imports) {
    if (!paths.has(occurrence.source) || !paths.has(occurrence.target)) {
      throw new Error(`Internal edge has a missing endpoint: ${occurrence.source} -> ${occurrence.target}.`);
    }
    const key = `${occurrence.source}\0${occurrence.target}`;
    const kinds = edgeKinds.get(key) ?? new Set<ImportKind>();
    kinds.add(occurrence.kind);
    edgeKinds.set(key, kinds);
  }

  const edges = [...edgeKinds.entries()]
    .map(([key, kinds]) => {
      const [source, target] = key.split("\0");
      return {
        source,
        target,
        kinds: [...kinds].sort(compareText),
      } satisfies GraphEdge;
    })
    .sort(compareEdges);

  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const edge of edges) {
    fanOut.set(edge.source, (fanOut.get(edge.source) ?? 0) + 1);
    fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + 1);
  }

  const files = fileMetadata
    .map(file => ({
      ...file,
      fanIn: fanIn.get(file.path) ?? 0,
      fanOut: fanOut.get(file.path) ?? 0,
    }))
    .sort((left, right) => compareText(left.path, right.path));

  return { files, edges };
}
