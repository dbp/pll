/**
 * Types shared by the explainers in this directory.
 *
 * Mirrors `analyzers/types.ts`: the shape both `nameErrorExplainer` and
 * `typeCheckExplainer` produce lives here rather than in either of them, so
 * neither has to import from its sibling.
 */

export interface BeginnerExplanation {
  /** Short headline, e.g. "Python doesn't know what `foo` means." */
  headline: string;
  /** Concrete next steps the learner can take. */
  howToFix: string[];
}
