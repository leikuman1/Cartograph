export const MAX_INPUT_BYTES = 240000;
const MAX_FILES_PER_BATCH = 8;

// Only optional provider/output/size failures may leave a parsed graph unlabelled.
// Missing source, cache corruption and database failures remain fatal.
export class ClassificationUnavailable extends Error {}

type ClassificationInput = { path: string; contentHash: string; content: string };

export function classificationBatches(
  files: readonly { path: string; contentHash: string }[],
  sources: ReadonlyMap<string, string>,
): { batches: ClassificationInput[][]; oversized: string[] } {
  const batches: ClassificationInput[][] = [];
  const oversized: string[] = [];
  let batch: ClassificationInput[] = [];
  let bytes = 2; // JSON array brackets.
  for (const file of files) {
    const content = sources.get(file.path);
    if (content === undefined) throw new Error(`Source is unavailable for ${file.path}.`);
    const input = { path: file.path, contentHash: file.contentHash, content };
    const size = Buffer.byteLength(JSON.stringify(input), "utf8");
    // A file too large for any batch stays unclassified and is reported; it must
    // not take the rest of the files down with it.
    if (size + 2 > MAX_INPUT_BYTES) {
      oversized.push(file.path);
      continue;
    }
    if (batch.length && (batch.length === MAX_FILES_PER_BATCH || bytes + 1 + size > MAX_INPUT_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(input);
  }
  if (batch.length) batches.push(batch);
  return { batches, oversized };
}

export async function classificationOutput<T>(generate: () => Promise<unknown>, validate: (value: unknown) => T): Promise<T> {
  let output: unknown;
  try { output = await generate(); }
  catch (error) {
    throw new ClassificationUnavailable("The model could not complete AI role classification. Retry Assign AI roles on the saved map.", { cause: error });
  }
  try { return validate(output); }
  catch (error) {
    throw new ClassificationUnavailable("The model returned invalid AI roles. Retry Assign AI roles on the saved map.", { cause: error });
  }
}
