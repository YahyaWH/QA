import { XMLParser } from 'fast-xml-parser';
import type { ViewNode } from '../types/index';

/**
 * Parse a uiautomator/Appium page-source XML dump into a normalized `ViewNode` tree.
 *
 * Two dialects are supported:
 *
 * 1. Raw `uiautomator dump` output: every element is a generic `<node>` with a
 *    `class` attribute (e.g. `<node class="android.widget.FrameLayout" ...>`).
 * 2. Appium UIAutomator2 driver `/source` output: the element tag IS the class
 *    name (e.g. `<android.widget.FrameLayout ...>`). The `class` attribute is
 *    still present and matches the tag.
 *
 * Behavior:
 *
 * - Unwraps `<hierarchy>` and returns its first child element as the root.
 * - Converts hyphenated attribute names to our camelCase schema (`resourceId`,
 *   `className`, `contentDesc`). Prefers the `class` attribute; falls back to
 *   the element tag name when absent.
 * - Normalizes empty strings on `resourceId`/`text`/`contentDesc` to `null`.
 * - Parses `bounds` into `{ x, y, w, h }`, defaulting to zeros if the attribute
 *   is missing or malformed.
 * - Coerces `clickable`/`enabled` to booleans (`"true"` ⇒ `true`, anything else
 *   ⇒ `false`); `enabled` defaults to `true` if the attribute is absent.
 * - Coerces visibility from either `displayed` or `visible-to-user` (different
 *   uiautomator variants emit different attributes); defaults to `true` when
 *   both are absent.
 * - Walks all child elements regardless of tag name, handling both the
 *   singleton-object and array shapes that fast-xml-parser produces depending
 *   on how many siblings share a tag.
 *
 * @param xml Raw page-source XML
 * @returns The root `ViewNode` (first child element under `<hierarchy>`)
 * @throws Error if no root element is found under `<hierarchy>`
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

  const rootChildren = collectChildNodes(hierarchy as Record<string, unknown>);
  if (rootChildren.length === 0) {
    const preview = xml.slice(0, 600).replace(/\s+/g, ' ');
    const keys = Object.keys(hierarchy as Record<string, unknown>).join(',');
    throw new Error(
      `parseViewTree: <hierarchy> has no child element (keys=${keys}, xmlLen=${xml.length}, preview=${preview})`,
    );
  }

  return rootChildren[0];
}

function buildNode(raw: Record<string, unknown>, tagName: string): ViewNode {
  const resourceId = nullIfEmpty(attrString(raw, '@_resource-id'));
  // Prefer the `class` attribute; fall back to the tag name for Appium's
  // className-as-tag dialect when the attribute is missing.
  const className = attrString(raw, '@_class') ?? tagName;
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

  const children = collectChildNodes(raw);

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

/**
 * Walk a fast-xml-parser object and return every child element as a `ViewNode`.
 *
 * In fast-xml-parser's output (with `attributeNamePrefix: '@_'`), any key that
 * does not start with `@_` and is not the special `#text` slot is a child
 * element. The value is either an object (single child with that tag) or an
 * array (multiple siblings with that tag). This helper normalizes both shapes
 * and recurses via `buildNode`, passing the tag name so the Appium
 * className-as-tag dialect can fall back to it when `@_class` is absent.
 */
function collectChildNodes(raw: Record<string, unknown>): ViewNode[] {
  const result: ViewNode[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('@_')) continue;
    if (key === '#text') continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          result.push(buildNode(item as Record<string, unknown>, key));
        }
      }
    } else if (typeof value === 'object') {
      result.push(buildNode(value as Record<string, unknown>, key));
    }
  }
  return result;
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
