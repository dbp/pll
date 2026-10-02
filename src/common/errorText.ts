/** What went wrong, as one line: an `Error`'s message, or anything else as text. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
