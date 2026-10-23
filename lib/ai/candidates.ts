import type { AnalysisResult } from "../parser/contract";
import { genericCategoryForPath } from "../frameworks/taxonomy";

export function roleCandidates(analysis: AnalysisResult) {
  const known = new Set(analysis.fileRoles.map(record => record.file));
  return analysis.files.filter(file => !known.has(file.path) && genericCategoryForPath(file.path).id === "source");
}
