/**
 * `load`, run once and remembered - unless it fails, in which case the next
 * call tries again.
 *
 * A failed load cached as a rejected promise lasted until the window was
 * reloaded: one dropped connection while pytest downloaded, and no tests ran
 * for the rest of the session.
 */
export function onceSuccessful<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (cached === null) {
      cached = load().catch((err: unknown) => {
        cached = null;
        throw err;
      });
    }
    return cached;
  };
}
