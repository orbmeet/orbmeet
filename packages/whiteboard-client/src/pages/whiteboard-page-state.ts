import type { WhiteboardPage } from "./page-manager";

export function arePagesEqual(
  a: WhiteboardPage[],
  b: WhiteboardPage[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.number !== right.number ||
      left.y !== right.y ||
      left.height !== right.height
    ) {
      return false;
    }
  }

  return true;
}
