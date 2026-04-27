import type { Finding } from '../types/index';

/**
 * Canonical "same finding" tuple key used by evaluate's in-turn dedup,
 * dedupInRun's exact-tuple pass, and any future store that needs to
 * collapse by (screenFp, element, category).
 */
export function findingTupleKey(
  f: Pick<Finding, 'screenFp' | 'element' | 'category'>,
): string {
  return `${f.screenFp}|${f.element ?? 'null'}|${f.category}`;
}
