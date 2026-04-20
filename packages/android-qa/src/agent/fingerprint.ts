import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { Fingerprint } from '../types/index';

/**
 * Compute a stable screen fingerprint from an Android uiautomator hierarchy XML.
 *
 * The fingerprint ignores cosmetic attributes (text, content-desc, bounds, sibling order) and
 * considers only the set of elements with a non-empty `resource-id`, each contributing a tuple
 * of `"${resource-id}|${class}|${clickable}"`. Tuples are sorted lexicographically and
 * concatenated with the activity name, then SHA-1 hashed; the first 16 hex chars form the
 * fingerprint.
 *
 * @param xml      Raw uiautomator page-source XML (root `<hierarchy>` with nested `<node>` elements)
 * @param activity Fully qualified or short activity name that owns the screen
 * @returns        16-character lowercase hex SHA-1 prefix
 */
export function fingerprintFromXml(xml: string, activity: string): Fingerprint {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    preserveOrder: false,
  });

  const parsed: unknown = parser.parse(xml);
  const tuples: string[] = [];
  collectTuples(parsed, tuples);
  tuples.sort();

  const payload = activity + '\n' + tuples.join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/**
 * Recursively walk the parsed XML tree (arbitrary nesting of `node` elements) and push a tuple
 * for every element that exposes a non-empty `resource-id` attribute. Non-`node` keys and
 * text content are ignored; arrays and single-object children are both handled (fast-xml-parser
 * collapses single-child arrays into objects by default).
 */
function collectTuples(value: unknown, tuples: string[]): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) collectTuples(item, tuples);
    return;
  }

  if (typeof value !== 'object') return;

  const obj = value as Record<string, unknown>;

  const resourceId = typeof obj['@_resource-id'] === 'string' ? (obj['@_resource-id'] as string) : '';
  if (resourceId.length > 0) {
    const className = typeof obj['@_class'] === 'string' ? (obj['@_class'] as string) : '';
    const clickable = typeof obj['@_clickable'] === 'string' ? (obj['@_clickable'] as string) : 'false';
    tuples.push(`${resourceId}|${className}|${clickable}`);
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key.startsWith('@_') || key === '#text') continue;
    collectTuples(child, tuples);
  }
}
