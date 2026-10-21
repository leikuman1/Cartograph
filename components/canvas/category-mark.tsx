import type { FileRoleRecord } from "@/lib/parser/contract";
import { categoryForFile, type CategoryDefinition } from "@/lib/frameworks/taxonomy";

export function CategorySymbol({ category }: { category: CategoryDefinition }) {
  return <span className={`category-mark category-${category.id}`} title={`${category.label}: ${category.description}`}>{category.code}</span>;
}

export default function CategoryMark({ path, fileRoles }: { path: string; fileRoles: readonly FileRoleRecord[] }) {
  return <CategorySymbol category={categoryForFile(path, fileRoles)} />;
}
