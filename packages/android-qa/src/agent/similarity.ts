/**
 * Jaccard similarity threshold for fuzzy summary matching. Strictly greater
 * than this value triggers a merge; equal does not. Tuned empirically for
 * short QA-style summaries where 0.7 catches near-paraphrases without
 * collapsing obviously distinct issues.
 *
 * Shared between in-run dedup (`dedupInRun`) and cross-run classification
 * (`classifyAgainstHistory`) so the two stages never drift from each other.
 */
export const JACCARD_THRESHOLD = 0.7;

/**
 * Lowercase and split on non-alphanumeric runs. Unicode-normalization is out
 * of scope — the spec targets English/ASCII QA summaries.
 */
export function tokenize(summary: string): Set<string> {
  const words = summary.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(words);
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|. Defined as 0 when both sets are
 * empty so two degenerate summaries never merge on vacuous similarity.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
