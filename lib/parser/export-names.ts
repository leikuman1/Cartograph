// PostgreSQL stores these names in C order. Compare Unicode code points rather
// than UTF-16 code units so a non-BMP object key survives the storage round trip.
export function compareExportNames(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, character => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
