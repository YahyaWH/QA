import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseViewTree } from './tree';
import type { ViewNode } from '../types/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '..', '..', 'test-fixtures', 'view-trees');

const fx = readFileSync(join(FIXTURE_DIR, 'login.xml'), 'utf8');

describe('parseViewTree', () => {
  it('extracts interactive elements with resource ids', () => {
    const tree = parseViewTree(fx);
    const flat: string[] = [];
    function walk(n: ViewNode): void {
      if (n.resourceId) flat.push(n.resourceId);
      n.children.forEach(walk);
    }
    walk(tree);
    expect(flat).toContain('com.wastehero:id/email-input');
    expect(flat).toContain('com.wastehero:id/password-input');
    expect(flat).toContain('com.wastehero:id/submit-btn');
  });

  it('parses bounds', () => {
    const tree = parseViewTree(fx);
    function find(n: ViewNode, rid: string): ViewNode | null {
      if (n.resourceId === rid) return n;
      for (const c of n.children) {
        const r = find(c, rid);
        if (r) return r;
      }
      return null;
    }
    const btn = find(tree, 'com.wastehero:id/submit-btn');
    expect(btn).not.toBeNull();
    expect(btn!.bounds).toEqual({ x: 0, y: 120, w: 100, h: 50 });
  });
});
