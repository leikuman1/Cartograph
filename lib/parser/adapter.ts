export interface ModuleContext {
  path: string;
  folder: string;
  packageDirectory: string | null;
}

export interface RepositoryAdapter {
  moduleForFile(context: ModuleContext): string;
}

export const fallbackAdapter: RepositoryAdapter = {
  moduleForFile({ packageDirectory }) {
    return packageDirectory ?? ".";
  },
};
