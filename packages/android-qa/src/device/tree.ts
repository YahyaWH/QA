import { XMLParser } from 'fast-xml-parser';
import type { ViewNode } from '../types/index';

/**
 * Parse a uiautomator page-source XML dump into a normalized `ViewNode` tree.
 *
 * The input is an Android `<hierarchy>` document whose descendants are `<node>` elements
 * with hyphenated attribute names (`resource-id`, `content-desc`, etc.) and a textual
 * `bounds="[x1,y1][x2,y2]"` attribute. This function:
 *
 * - Unwraps `<hierarchy>` and returns its first `<node>` child as the root.
 * - Converts attribute names to our camelCase schema (`resourceId`, `className`, `contentDesc`).
 * - Normalizes empty strings on `resourceId`/`text`/`contentDesc` to `null`.
 * - Parses `bounds` into `{ x, y, w, h }`, defaulting to zeros if the attribute is missing or malformed.
 * - Coerces `clickable`/`enabled` to booleans (`"true"` ⇒ `true`, anything else ⇒ `false`);
 *   `enabled` defaults to `true` if the attribute is absent.
 * - Coerces visibility from either `displayed` or `visible-to-user` (different uiautomator
 *   variants emit different attributes); defaults to `true` when both are absent.
 * - Handles both singleton-object and array children that fast-xml-parser produces
 *   depending on how many siblings a `<node>` has.
 *
 * @param xml Raw uiautomator page-source XML
 * @returns The root `ViewNode` (the first `<node>` under `<hierarchy>`)
 * @throws Error if no root `<node>` is found under `<hierarchy>`
 */
export function parseViewTree(xml: string): ViewNode {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    preserveOrder: false,
  });

  const parsed = parser.parse(xml) as Record<string, unknown>;
  const hierarchy = parsed['hierarchy'];
  if (!hierarchy || typeof hierarchy !== 'object') {
    throw new Error('parseViewTree: missing <hierarchy> root');
  }

  const topNode = (hierarchy as Record<string, unknown>)['node'];
  if (topNode === undefined || topNode === null) {
    throw new Error('parseViewTree: <hierarchy> has no <node> child');
  }

  // If `<hierarchy>` has multiple top-level <node> siblings, take the first.
  const rootRaw = Array.isArray(topNode) ? topNode[0] : topNode;
  if (!rootRaw || typeof rootRaw !== 'object') {
    throw new Error('parseViewTree: <hierarchy>/<node> is not an object');
  }

  return buildNode(rootRaw as Record<string, unknown>);
}

function buildNode(raw: Record<string, unknown>): ViewNode {
  const resourceId = nullIfEmpty(attrString(raw, '@_resource-id'));
  const className = attrString(raw, '@_class') ?? '';
  const text = nullIfEmpty(attrString(raw, '@_text'));
  const contentDesc = nullIfEmpty(attrString(raw, '@_content-desc'));
  const bounds = parseBounds(attrString(raw, '@_bounds'));
  const clickable = parseBool(attrString(raw, '@_clickable'), false);
  const enabled = parseBool(attrString(raw, '@_enabled'), true);

  // uiautomator variants: prefer `displayed`; fall back to `visible-to-user`; default true.
  const displayedAttr = attrString(raw, '@_displayed');
  const visibleToUserAttr = attrString(raw, '@_visible-to-user');
  let visible = true;
  if (displayedAttr !== undefined) {
    visible = parseBool(displayedAttr, true);
  } else if (visibleToUserAttr !== undefined) {
    visible = parseBool(visibleToUserAttr, true);
  }

  const childRaw = raw['node'];
  const children: ViewNode[] = [];
  if (Array.isArray(childRaw)) {
    for (const c of childRaw) {
      if (c && typeof c === 'object') children.push(buildNode(c as Record<string, unknown>));
    }
  } else if (childRaw && typeof childRaw === 'object') {
    children.push(buildNode(childRaw as Record<string, unknown>));
  }

  return {
    resourceId,
    className,
    text,
    contentDesc,
    bounds,
    clickable,
    enabled,
    visible,
    children,
  };
}

function attrString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function nullIfEmpty(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (v.length === 0) return null;
  return v;
}

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined) return defaultValue;
  return v === 'true';
}

/**
 * Parse a uiautomator `bounds="[x1,y1][x2,y2]"` string into `{ x, y, w, h }`.
 * Coordinates may be negative (off-screen views), so we accept a leading `-` on each number.
 * Returns zeros if the attribute is missing or does not match the expected format.
 */
function parseBounds(v: string | undefined): { x: number; y: number; w: number; h: number } {
  if (!v) return { x: 0, y: 0, w: 0, h: 0 };
  const match = v.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
