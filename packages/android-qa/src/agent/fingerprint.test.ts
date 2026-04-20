import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprintFromXml } from './fingerprint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '..', '..', 'test-fixtures', 'view-trees');

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

describe('fingerprintFromXml', () => {
  it('is cosmetic-invariant: same resource-ids/classes/clickable yields same fingerprint despite differing text, content-desc, bounds, ordering', () => {
    const a = fingerprintFromXml(fixture('login.xml'), 'LoginActivity');
    const b = fingerprintFromXml(fixture('login-same-structure.xml'), 'LoginActivity');
    expect(a).toBe(b);
  });

  it('is structure-sensitive: adding a resource-id element changes the fingerprint', () => {
    const base = fingerprintFromXml(fixture('login.xml'), 'LoginActivity');
    const added = fingerprintFromXml(fixture('login-added-element.xml'), 'LoginActivity');
    expect(added).not.toBe(base);
  });

  it('returns a 16-character lowercase hex string', () => {
    const fp = fingerprintFromXml(fixture('login.xml'), 'LoginActivity');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is activity-name sensitive: same XML with different activity yields different fingerprints', () => {
    const xml = fixture('login.xml');
    const a = fingerprintFromXml(xml, 'LoginActivity');
    const b = fingerprintFromXml(xml, 'SignupActivity');
    expect(a).not.toBe(b);
  });
});
