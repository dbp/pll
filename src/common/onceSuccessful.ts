/**
 * `load`, run once and remembered - unless it fails, in which case the next
 * call tries again.
 *
 * So a failure is not cached as a rejected promise, which would last until
 * the window is reloaded: one dropped connection while pytest downloads
 * would mean no tests for the rest of the session.
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
