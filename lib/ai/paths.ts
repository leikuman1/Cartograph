// Folder references are facts derived from supplied files, not model guesses.
export function explanationFolders(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    let separator = path.indexOf("/");
    while (separator >= 0) {
      folders.add(path.slice(0, separator));
      separator = path.indexOf("/", separator + 1);
    }
  }
  return [...folders].sort();
}
