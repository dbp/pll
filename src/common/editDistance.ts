/**
 * Edit distance counting a swap of two neighbours as one mistake.
 *
 * Plain Levenshtein charges two for `yaer` -> `year`, which is enough to
 * push the commonest typo of all past any threshold tight enough to be
 * useful. This is the usual optimal-string-alignment variant.
 */
export function editDistance(a: string, b: string): number {
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], twoBack[j - 2] + 1);
      }
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length];
}
