import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppMap, PersistedScreen } from '../types';
import {
  APP_MAP_SCHEMA_VERSION,
  defaultAppMapPath,
  loadAppMap,
  saveAppMap,
} from './app-map';

describe('app-map state I/O', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'android-qa-appmap-' + randomUUID() + '-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadAppMap returns an empty map with current schemaVersion when the file is missing', async () => {
    const target = join(dir, 'does-not-exist', 'app-map.json');
    const map = await loadAppMap(target);

    expect(map.schemaVersion).toBe(APP_MAP_SCHEMA_VERSION);
    expect(map.schemaVersion).toBe(1);
    expect(map.appVersion).toBe('unknown');
    expect(map.screens).toEqual({});
    expect(map.transitions).toEqual([]);
    expect(typeof map.generatedAt).toBe('string');
    // ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(map.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('saveAppMap + loadAppMap round-trip a non-trivial map', async () => {
    const target = join(dir, 'nested', 'sub', 'app-map.json');
    const screen: PersistedScreen = {
      fingerprint: 'abc123def4567890',
      activity: 'com.wastehero.MainActivity',
      elements: {
        'btn-login': {
          resourceId: 'btn-login',
          role: 'button',
          text: 'Sign in',
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-01-02T00:00:00.000Z',
          tapped: true,
          outcomes: [{ action: 'tap', ledToScreen: 'deadbeefcafe0001', count: 3 }],
        },
      },
      firstSeenRun: 'run-001',
      lastSeenRun: 'run-005',
      seenCount: 5,
    };

    const map: AppMap = {
      appVersion: '1.2.3',
      generatedAt: '2026-04-20T10:00:00.000Z',
      schemaVersion: 1,
      screens: { [screen.fingerprint]: screen },
      transitions: [
        { from: 'abc123def4567890', via: 'btn-login', to: 'deadbeefcafe0001', occurrences: 3 },
      ],
    };

    await saveAppMap(map, target);
    const loaded = await loadAppMap(target);
    expect(loaded).toEqual(map);
  });

  it('saveAppMap leaves no .tmp sibling on success', async () => {
    const target = join(dir, 'app-map.json');
    const map: AppMap = {
      appVersion: '1.0.0',
      generatedAt: '2026-04-20T10:00:00.000Z',
      schemaVersion: 1,
      screens: {},
      transitions: [],
    };

    await saveAppMap(map, target);

    expect(existsSync(target)).toBe(true);
    expect(existsSync(target + '.tmp')).toBe(false);
  });

  it('saveAppMap cleans up .tmp on failure and rethrows', async () => {
    // Pre-create a regular file where the parent dir should be.
    // `mkdir(dirname(target), { recursive: true })` will then fail with ENOTDIR
    // because "blocker" is a file, not a directory.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const target = join(blocker, 'app-map.json');

    const map: AppMap = {
      appVersion: '1.0.0',
      generatedAt: '2026-04-20T10:00:00.000Z',
      schemaVersion: 1,
      screens: {},
      transitions: [],
    };

    await expect(saveAppMap(map, target)).rejects.toThrow();
    expect(existsSync(target + '.tmp')).toBe(false);
  });

  it('defaultAppMapPath() resolves to <package-root>/state/app-map.json', () => {
    const resolved = defaultAppMapPath();
    const suffix = ['packages', 'android-qa', 'state', 'app-map.json'].join(sep);
    expect(resolved.endsWith(suffix)).toBe(true);
  });

  it('saveAppMap pretty-prints JSON with 2-space indent', async () => {
    const target = join(dir, 'pretty.json');
    const map: AppMap = {
      appVersion: '1.0.0',
      generatedAt: '2026-04-20T10:00:00.000Z',
      schemaVersion: 1,
      screens: {},
      transitions: [],
    };

    await saveAppMap(map, target);
    const raw = readFileSync(target, 'utf8');

    // Must match JSON.stringify(map, null, 2) exactly.
    expect(raw).toBe(JSON.stringify(map, null, 2));
    // Sanity: contains newline + 2-space indent for at least one key.
    expect(raw).toContain('\n  "appVersion"');
  });

  it('loadAppMap rethrows on malformed JSON (not ENOENT)', async () => {
    const target = join(dir, 'corrupt.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, '{ not valid json', 'utf8');

    await expect(loadAppMap(target)).rejects.toThrow();
  });
});
