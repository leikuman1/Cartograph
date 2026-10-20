import { categories, fileCategory } from "@/lib/canvas/graph";

export default function CategoryMark({ path }: { path: string }) {
  const category = categories.find(category => category.id === fileCategory(path));
  return <span className={`category-mark category-${category?.id}`} title={category?.label}>{category?.code}</span>;
}
