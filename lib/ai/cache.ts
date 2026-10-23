export interface AiCache {
  read(key: string): Promise<unknown | null>;
  write(key: string, operation: "file" | "folder" | "classify", value: Record<string, unknown>): Promise<void>;
}

// The outer trace owns the lookup. A visible Explain click always enters it,
// even when the panel can already restore a previously displayed answer.
export async function cachedOperation<T extends Record<string, unknown>>(
  cache: AiCache,
  key: string,
  operation: "file" | "folder" | "classify",
  trace: <R>(work: () => Promise<R>) => Promise<R>,
  validate: (value: unknown) => T,
  generate: () => Promise<T>,
) {
  return trace(async () => {
    const saved = await cache.read(key);
    if (saved !== null) return { value: validate(saved), cacheHit: true };
    const value = await generate();
    await cache.write(key, operation, value);
    return { value, cacheHit: false };
  });
}
