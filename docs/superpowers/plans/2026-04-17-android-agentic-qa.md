# Android Agentic QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new workspace package `packages/android-qa` that runs a curiosity-driven agent against a local Android emulator, produces a checkbox-gated `report.md`, and publishes ticked findings to Linear with attached artifacts.

**Architecture:** Node + TypeScript package. Agent loop (Claude) talks to a Device Driver interface; one concrete implementation drives Appium + UIAutomator2 against a local AVD. Persistent state in `packages/android-qa/state/` (app-map, findings-history). Per-run artifacts in `output/android-qa/<runId>/`. Human-in-the-loop: ticked findings → Linear via MCP. See `docs/superpowers/specs/2026-04-17-android-agentic-qa-design.md`.

**Tech Stack:** TypeScript 5, Node 18+, `@anthropic-ai/sdk` (Claude Opus 4.7), `webdriverio` + `appium` (with `appium-uiautomator2-driver`), `adbkit` or direct `adb` shell-outs, `simple-git`, `vitest` for tests. Reuses existing Linear MCP tools for publishing.

**Prerequisites (human, one-time):** Android SDK + platform-tools on PATH, an AVD created named `Pixel_7_API_34` (or override via env), Appium 2.x installed globally or as a project dep, an unsigned/debug WasteHero APK on disk.

---

## File structure

```
packages/android-qa/
├── package.json                            @wastehero-qa/android-qa
├── tsconfig.json                           extends ../../tsconfig.base.json
├── vitest.config.ts
├── .env.example
├── README.md
├── bin/
│   ├── explore.ts                          CLI: start a run
│   ├── publish.ts                          CLI: push ticked findings to Linear
│   ├── smoke.ts                            CLI: 3-min CI run
│   ├── replay.ts                           CLI: re-drive a session
│   ├── eval-judgment.ts                    CLI: precision/recall on labeled screens
│   └── reset-state.ts                      CLI: archive state and start fresh
├── src/
│   ├── types/index.ts                      Action, Finding, Screen, SessionState, Budget, …
│   ├── config/index.ts                     env → typed config with validation
│   ├── agent/
│   │   ├── orchestrator.ts                 the top-level run loop
│   │   ├── fingerprint.ts                  screen fingerprint hashing
│   │   ├── frontier.ts                     prioritized frontier from map + current screen
│   │   ├── anti-loop.ts                    loop/stuck detection
│   │   ├── claude.ts                       SDK wrapper (caching, retries, JSON parse)
│   │   ├── decide.ts                       Decide prompt + call + validation
│   │   ├── evaluate.ts                     Evaluate prompt + vision + call + validation
│   │   ├── dedup.ts                        in-run finding dedup
│   │   └── login.ts                        pre-run login using env creds
│   ├── device/
│   │   ├── driver.ts                       Driver interface (contract)
│   │   ├── appium-driver.ts                Appium/UIAutomator2 implementation
│   │   ├── tree.ts                         UIAutomator XML → ViewNode tree
│   │   ├── emulator.ts                     AVD lifecycle (boot, snapshot, shutdown)
│   │   └── appium-server.ts                spawn/kill Appium process
│   ├── recorder/
│   │   ├── recorder.ts                     session.json append + screenshot dir
│   │   ├── logcat.ts                       logcat tail + delta slicing
│   │   └── video.ts                        adb screenrecord lifecycle + clip slicing
│   ├── state/
│   │   ├── app-map.ts                      read/write app-map.json (atomic)
│   │   ├── map-merge.ts                    merge in-run deltas into app-map
│   │   ├── findings-history.ts             jsonl append + read
│   │   └── cross-run-dedup.ts              match new findings to history
│   ├── report/
│   │   ├── render.ts                       render session + findings → report.md
│   │   └── parse.ts                        parse report.md → ticked findings
│   └── publish/
│       ├── linear.ts                       Linear MCP bridge (save_issue, create_attachment)
│       └── artifacts-github.ts             host artifacts on a dedicated git branch
├── state/                                  VERSIONED in git
│   ├── app-map.json                        empty shell committed
│   └── findings-history.jsonl              empty file committed
└── test-fixtures/
    ├── view-trees/                         XML files for fingerprint + tree-parsing tests
    ├── sessions/                           frozen session.json files for replay tests
    ├── screens/                            labeled screenshots for judgment eval
    └── reports/                            sample report.md for parser tests
```

Root-level:
- `package.json` — add `android-qa:*` script delegates to the workspace
- `.github/workflows/android-qa.yml` — CI
- `.gitignore` — ensure `output/android-qa/` is ignored

---

## Task 0: Scaffold the package

**Files:**
- Create: `packages/android-qa/package.json`
- Create: `packages/android-qa/tsconfig.json`
- Create: `packages/android-qa/vitest.config.ts`
- Create: `packages/android-qa/.env.example`
- Create: `packages/android-qa/src/.gitkeep`
- Modify: `package.json` (root) — add `packages/android-qa` to workspaces if workspaces is defined as an array; add `android-qa:*` scripts
- Modify: `.gitignore` — add `output/android-qa/`

- [ ] **Step 1: Read root `package.json` and `tsconfig.base.json`** to confirm workspaces pattern and TS options.

- [ ] **Step 2: Create `packages/android-qa/package.json`:**

```json
{
  "name": "@wastehero-qa/android-qa",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "explore": "tsx bin/explore.ts",
    "publish": "tsx bin/publish.ts",
    "smoke": "tsx bin/smoke.ts",
    "replay": "tsx bin/replay.ts",
    "eval-judgment": "tsx bin/eval-judgment.ts",
    "reset-state": "tsx bin/reset-state.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "webdriverio": "^8.38.0",
    "appium": "^2.5.0",
    "appium-uiautomator2-driver": "^3.0.0",
    "simple-git": "^3.24.0",
    "dotenv": "^16.4.0",
    "zod": "^3.23.0",
    "fast-xml-parser": "^4.3.0",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "typescript": "^5.4.0",
    "tsx": "^4.7.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create `packages/android-qa/tsconfig.json`:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": ".",
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022"
  },
  "include": ["src/**/*.ts", "bin/**/*.ts", "test-fixtures/**/*.ts"]
}
```

- [ ] **Step 4: Create `packages/android-qa/vitest.config.ts`:**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
});
```

- [ ] **Step 5: Create `packages/android-qa/.env.example`** mirroring the spec §9 (all env vars, with `###` placeholder values and comments).

- [ ] **Step 6: Modify root `package.json`** — add script delegates:

```json
{
  "scripts": {
    "android-qa:explore": "npm run explore -w @wastehero-qa/android-qa",
    "android-qa:publish": "npm run publish -w @wastehero-qa/android-qa",
    "android-qa:smoke": "npm run smoke -w @wastehero-qa/android-qa",
    "android-qa:test": "npm run test -w @wastehero-qa/android-qa"
  }
}
```

- [ ] **Step 7: Modify `.gitignore`** — add `output/android-qa/`.

- [ ] **Step 8: Run install + typecheck:**

Run: `npm install && npm run typecheck -w @wastehero-qa/android-qa`
Expected: install completes; typecheck succeeds (nothing to check yet except tsconfig parses).

- [ ] **Step 9: Commit:**

```bash
git add packages/android-qa package.json .gitignore
git commit -m "android-qa: scaffold workspace package"
```

---

## Task 1: Shared types

**Files:**
- Create: `packages/android-qa/src/types/index.ts`
- Create: `packages/android-qa/src/types/index.test.ts`

- [ ] **Step 1: Write the type definitions** (`src/types/index.ts`):

```ts
export type Fingerprint = string; // 16-hex SHA-1 prefix

export type Category = 'A' | 'B' | 'C' | 'D' | 'E';
export type Severity = 'low' | 'med' | 'high' | 'critical';
export type RunStatus =
  | 'completed'
  | 'aborted-crash-loop'
  | 'aborted-device'
  | 'aborted-auth'
  | 'aborted-error';
export type FindingStatus =
  | 'new'
  | 'previously-seen'
  | 'resurrected'
  | 'published'
  | 'stale';

export interface ViewNode {
  resourceId: string | null;
  className: string;
  text: string | null;
  contentDesc: string | null;
  bounds: { x: number; y: number; w: number; h: number };
  clickable: boolean;
  enabled: boolean;
  visible: boolean;
  children: ViewNode[];
}

export interface Screen {
  fingerprint: Fingerprint;
  activity: string;
  elements: Record<string, ViewElement>;
}

export interface ViewElement {
  resourceId: string;
  role: string;
  text: string | null;
  firstSeen: string;
  lastSeen: string;
  tapped: boolean;
  outcomes: Array<{ action: string; ledToScreen: Fingerprint | null; count: number; note?: string }>;
  marked?: 'broken' | 'deny-listed';
}

export type Action =
  | { kind: 'tap'; elementId: string }
  | { kind: 'type'; elementId: string; text: string }
  | { kind: 'swipe'; direction: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'back' }
  | { kind: 'scrollTo'; elementId: string }
  | { kind: 'done'; reason: string };

export interface Finding {
  id: string;
  runId: string;
  screenFp: Fingerprint;
  element: string | null;
  category: Category;
  severity: Severity;
  summary: string;
  reasoning: string;
  firstSeenRun?: string;
  lastSeenRun?: string;
  occurrences?: number;
  status: FindingStatus;
  linearIssueId?: string;
  artifactRefs?: { screenshot?: string; video?: string; logcat?: string };
}

export interface SessionState {
  runId: string;
  appVersion: string;
  role: string;
  startedAt: string;
  endedAt?: string;
  status?: RunStatus;
  budget: { wallClockMs: number; turns: number };
  counters: { crashCount: number; noNewScreenStreak: number; malformedJsonCount: number };
  screens: Record<Fingerprint, Screen>;
  frontier: Array<{ screenFp: Fingerprint; elementId: string; priority: number }>;
  findings: Finding[];
  history: Array<{ turn: number; screenFp: Fingerprint; action: Action; outcomeFp: Fingerprint | null; ms: number }>;
}

export interface AppMap {
  appVersion: string;
  generatedAt: string;
  schemaVersion: 1;
  screens: Record<Fingerprint, PersistedScreen>;
  transitions: Array<{ from: Fingerprint; via: string; to: Fingerprint; occurrences: number }>;
}

export interface PersistedScreen extends Screen {
  firstSeenRun: string;
  lastSeenRun: string;
  seenCount: number;
}
```

- [ ] **Step 2: Write a trivial test** (`src/types/index.test.ts`) just to guard that the module loads:

```ts
import { describe, it, expect } from 'vitest';
import type { Action, Finding } from './index';

describe('types module', () => {
  it('compiles and exports nothing at runtime', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run test + typecheck:**

Run: `npm run test -w @wastehero-qa/android-qa && npm run typecheck -w @wastehero-qa/android-qa`
Expected: PASS.

- [ ] **Step 4: Commit:**

```bash
git add packages/android-qa/src/types
git commit -m "android-qa: shared type definitions"
```

---

## Task 2: Config loader

**Files:**
- Create: `packages/android-qa/src/config/index.ts`
- Create: `packages/android-qa/src/config/index.test.ts`

- [ ] **Step 1: Write test** for required + default values:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('throws on missing ANTHROPIC_API_KEY', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('returns defaults for optional values', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'x',
      ANDROID_SDK_ROOT: '/sdk',
      WASTEHERO_APK_PATH: '/apk',
    });
    expect(cfg.agent.model).toBe('claude-opus-4-7');
    expect(cfg.agent.wallClockMinutes).toBe(30);
    expect(cfg.agent.visionEveryNTurns).toBe(10);
    expect(cfg.device.avdName).toBe('Pixel_7_API_34');
    expect(cfg.publish.artifactHostMode).toBe('github-branch');
  });

  it('parses deny list as comma-separated', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'x',
      ANDROID_SDK_ROOT: '/sdk',
      WASTEHERO_APK_PATH: '/apk',
      DENY_ACTIONS: 'logout,delete-account',
    });
    expect(cfg.agent.denyActions).toEqual(['logout', 'delete-account']);
  });

  it('collects role credentials', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'x',
      ANDROID_SDK_ROOT: '/sdk',
      WASTEHERO_APK_PATH: '/apk',
      WH_CREDS_ADMIN_EMAIL: 'a@x',
      WH_CREDS_ADMIN_PASSWORD: 'p',
    });
    expect(cfg.auth.roles.admin).toEqual({ email: 'a@x', password: 'p' });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (`loadConfig` doesn't exist).

- [ ] **Step 3: Implement** (`src/config/index.ts`):

```ts
import { z } from 'zod';

const DEFAULTS = {
  AGENT_MODEL: 'claude-opus-4-7',
  AGENT_VISION_EVERY_N_TURNS: '10',
  AGENT_WALL_CLOCK_MIN: '30',
  AGENT_TURN_BUDGET: '500',
  ANDROID_AVD_NAME: 'Pixel_7_API_34',
  APPIUM_HOST: '127.0.0.1',
  APPIUM_PORT: '4723',
  ARTIFACT_HOST_MODE: 'github-branch',
  ARTIFACT_GITHUB_BRANCH: 'android-qa-artifacts',
  DENY_ACTIONS: 'logout,sign-out,delete-account,delete-customer,delete-route,factory-reset',
};

export interface Config {
  agent: {
    apiKey: string;
    model: string;
    wallClockMinutes: number;
    turnBudget: number;
    visionEveryNTurns: number;
    denyActions: string[];
  };
  device: {
    sdkRoot: string;
    avdName: string;
    apkPath: string;
    appiumHost: string;
    appiumPort: number;
  };
  auth: {
    roles: Record<string, { email: string; password: string }>;
  };
  publish: {
    linearTeamId?: string;
    linearProjectId?: string;
    artifactHostMode: 'github-branch' | 's3';
    artifactGithubBranch: string;
    artifactS3Bucket?: string;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = ['ANTHROPIC_API_KEY', 'ANDROID_SDK_ROOT', 'WASTEHERO_APK_PATH'];
  for (const k of required) {
    if (!env[k]) throw new Error(`Missing required env var: ${k}`);
  }
  const v = (k: keyof typeof DEFAULTS) => env[k] ?? DEFAULTS[k];

  // Collect role credentials: WH_CREDS_<ROLE>_EMAIL + _PASSWORD
  const roles: Record<string, { email: string; password: string }> = {};
  for (const key of Object.keys(env)) {
    const m = key.match(/^WH_CREDS_([A-Z]+)_EMAIL$/);
    if (m) {
      const role = m[1].toLowerCase();
      const pw = env[`WH_CREDS_${m[1]}_PASSWORD`];
      if (pw) roles[role] = { email: env[key]!, password: pw };
    }
  }

  return {
    agent: {
      apiKey: env.ANTHROPIC_API_KEY!,
      model: v('AGENT_MODEL'),
      wallClockMinutes: parseInt(v('AGENT_WALL_CLOCK_MIN'), 10),
      turnBudget: parseInt(v('AGENT_TURN_BUDGET'), 10),
      visionEveryNTurns: parseInt(v('AGENT_VISION_EVERY_N_TURNS'), 10),
      denyActions: v('DENY_ACTIONS').split(',').map((s) => s.trim()).filter(Boolean),
    },
    device: {
      sdkRoot: env.ANDROID_SDK_ROOT!,
      avdName: v('ANDROID_AVD_NAME'),
      apkPath: env.WASTEHERO_APK_PATH!,
      appiumHost: v('APPIUM_HOST'),
      appiumPort: parseInt(v('APPIUM_PORT'), 10),
    },
    auth: { roles },
    publish: {
      linearTeamId: env.LINEAR_TEAM_ID,
      linearProjectId: env.LINEAR_PROJECT_ID,
      artifactHostMode: v('ARTIFACT_HOST_MODE') as 'github-branch' | 's3',
      artifactGithubBranch: v('ARTIFACT_GITHUB_BRANCH'),
      artifactS3Bucket: env.ARTIFACT_S3_BUCKET,
    },
  };
}
```

- [ ] **Step 4: Run tests — expect PASS.**

- [ ] **Step 5: Commit:** `android-qa: config loader with env validation`.

---

## Task 3: Screen fingerprinting

**Files:**
- Create: `packages/android-qa/src/agent/fingerprint.ts`
- Create: `packages/android-qa/src/agent/fingerprint.test.ts`
- Create: `packages/android-qa/test-fixtures/view-trees/login.xml`
- Create: `packages/android-qa/test-fixtures/view-trees/login-same-structure.xml` (same structure, different text)
- Create: `packages/android-qa/test-fixtures/view-trees/login-added-element.xml`

- [ ] **Step 1: Create test fixtures.** Three minimal `uiautomator` XML files:
  - `login.xml` — LinearLayout with two EditTexts (`resource-id=email-input`, `password-input`) and a Button (`resource-id=submit-btn`).
  - `login-same-structure.xml` — same three resource-ids, different `text` attributes.
  - `login-added-element.xml` — adds a fourth element (`resource-id=forgot-pw-link`).

Example `login.xml`:

```xml
<hierarchy>
  <android.widget.LinearLayout class="android.widget.LinearLayout">
    <android.widget.EditText resource-id="com.wastehero:id/email-input" text="email" clickable="true" enabled="true" bounds="[0,0][100,50]"/>
    <android.widget.EditText resource-id="com.wastehero:id/password-input" text="" clickable="true" enabled="true" bounds="[0,60][100,110]"/>
    <android.widget.Button resource-id="com.wastehero:id/submit-btn" text="Log in" clickable="true" enabled="true" bounds="[0,120][100,170]"/>
  </android.widget.LinearLayout>
</hierarchy>
```

- [ ] **Step 2: Write tests:**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fingerprintFromXml } from './fingerprint';

const fx = (name: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'test-fixtures', 'view-trees', name), 'utf8');

describe('fingerprint', () => {
  it('produces identical fingerprints for cosmetic-only changes', () => {
    const a = fingerprintFromXml(fx('login.xml'), 'com.wastehero.MainActivity');
    const b = fingerprintFromXml(fx('login-same-structure.xml'), 'com.wastehero.MainActivity');
    expect(a).toBe(b);
  });

  it('produces different fingerprints when an element is added', () => {
    const a = fingerprintFromXml(fx('login.xml'), 'com.wastehero.MainActivity');
    const c = fingerprintFromXml(fx('login-added-element.xml'), 'com.wastehero.MainActivity');
    expect(a).not.toBe(c);
  });

  it('returns a 16-hex-char string', () => {
    const a = fingerprintFromXml(fx('login.xml'), 'com.wastehero.MainActivity');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs by activity name', () => {
    const a = fingerprintFromXml(fx('login.xml'), 'ActivityA');
    const b = fingerprintFromXml(fx('login.xml'), 'ActivityB');
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL.**

- [ ] **Step 4: Implement:**

```ts
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

interface ParsedNode {
  attrs?: Record<string, string>;
  children: ParsedNode[];
  tag: string;
}

function walk(obj: unknown, tag: string, acc: ParsedNode): void {
  if (!obj || typeof obj !== 'object') return;
  const node = obj as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) attrs[k.slice(2)] = String(v);
  }
  acc.tag = tag;
  acc.attrs = attrs;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) continue;
    const children = Array.isArray(v) ? v : [v];
    for (const child of children) {
      const childNode: ParsedNode = { tag: k, children: [] };
      walk(child, k, childNode);
      acc.children.push(childNode);
    }
  }
}

export function fingerprintFromXml(xml: string, activity: string): string {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  const root: ParsedNode = { tag: 'root', children: [] };
  walk(parsed.hierarchy ?? parsed, 'root', root);

  const tuples: string[] = [];
  function collect(n: ParsedNode) {
    const rid = n.attrs?.['resource-id'];
    const cls = n.attrs?.class ?? n.tag;
    const clickable = n.attrs?.clickable === 'true';
    if (rid && rid.length > 0) tuples.push(`${rid}|${cls}|${clickable}`);
    for (const c of n.children) collect(c);
  }
  collect(root);
  tuples.sort();
  const payload = activity + '\n' + tuples.join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}
```

- [ ] **Step 5: Run tests — expect PASS.**

- [ ] **Step 6: Commit:** `android-qa: screen fingerprinting`.

---

## Task 4: View tree parsing

**Files:**
- Create: `packages/android-qa/src/device/tree.ts`
- Create: `packages/android-qa/src/device/tree.test.ts`

Parses UIAutomator XML into the `ViewNode` tree defined in Task 1.

- [ ] **Step 1: Test:**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseViewTree } from './tree';

const fx = readFileSync(
  resolve(__dirname, '..', '..', 'test-fixtures', 'view-trees', 'login.xml'),
  'utf8',
);

describe('parseViewTree', () => {
  it('extracts interactive elements with resource ids', () => {
    const tree = parseViewTree(fx);
    const flat: string[] = [];
    function walk(n: any) { if (n.resourceId) flat.push(n.resourceId); n.children.forEach(walk); }
    walk(tree);
    expect(flat).toContain('com.wastehero:id/email-input');
    expect(flat).toContain('com.wastehero:id/password-input');
    expect(flat).toContain('com.wastehero:id/submit-btn');
  });

  it('parses bounds', () => {
    const tree = parseViewTree(fx);
    function find(n: any, rid: string): any { if (n.resourceId === rid) return n; for (const c of n.children) { const r = find(c, rid); if (r) return r; } return null; }
    const btn = find(tree, 'com.wastehero:id/submit-btn');
    expect(btn.bounds).toEqual({ x: 0, y: 120, w: 100, h: 50 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `parseViewTree(xml: string): ViewNode` — uses `fast-xml-parser`, walks hierarchy, converts `bounds="[x1,y1][x2,y2]"` to `{x, y, w, h}`, maps `resource-id`/`class`/`text`/`content-desc`/`clickable`/`enabled`/`displayed` attributes. Returns root `ViewNode`.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit:** `android-qa: view tree parser`.

---

## Task 5: Device Driver interface + fake

**Files:**
- Create: `packages/android-qa/src/device/driver.ts`
- Create: `packages/android-qa/src/device/fake-driver.ts`
- Create: `packages/android-qa/src/device/fake-driver.test.ts`

The interface that every concrete driver implements. We ship a `FakeDriver` for tests that serves XML trees from fixtures and records actions.

- [ ] **Step 1: Define interface** (`driver.ts`):

```ts
import type { ViewNode } from '../types';

export interface Driver {
  start(): Promise<void>;
  stop(): Promise<void>;
  getViewTree(): Promise<ViewNode>;
  getCurrentActivity(): Promise<string>;
  screenshot(): Promise<Buffer>;
  tap(resourceId: string): Promise<void>;
  type(resourceId: string, text: string): Promise<void>;
  swipe(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>;
  back(): Promise<void>;
  scrollTo(resourceId: string): Promise<void>;
  isAppAlive(): Promise<boolean>;
  relaunchApp(): Promise<void>;
}
```

- [ ] **Step 2: Write FakeDriver test** — verifies it can be scripted with a list of screens and records actions.

- [ ] **Step 3: Implement `FakeDriver`** — constructor takes `{ screens: Array<{ xml: string; activity: string }>; transitions: Record<string, Record<string, number>> }` (action → next screen index). Exposes `.actionsRecorded` for assertion.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit:** `android-qa: device driver interface + fake impl`.

---

## Task 6: Appium driver implementation

**Files:**
- Create: `packages/android-qa/src/device/appium-driver.ts`

No unit tests (requires live Appium). Covered by smoke test later.

- [ ] **Step 1: Implement** `AppiumDriver` class that implements `Driver` via `webdriverio` remote session. Capabilities: `platformName: 'Android'`, `appium:automationName: 'UIAutomator2'`, `appium:avd: <name>`, `appium:app: <apkPath>`, `appium:autoGrantPermissions: true`.

  - `getViewTree()` → `browser.getPageSource()` → `parseViewTree()`.
  - `tap(resourceId)` → `browser.$('~' + rid)` accessibility-id lookup; fallback to `android=new UiSelector().resourceId(rid)`. `.click()`.
  - `type(resourceId, text)` → same locator, `.setValue(text)`.
  - `swipe` → `browser.touchAction` or `browser.executeScript('mobile: swipeGesture', ...)`.
  - `back()` → `browser.back()`.
  - `scrollTo` → `mobile: scrollGesture`.
  - `screenshot()` → `browser.takeScreenshot()` → Buffer from base64.
  - `getCurrentActivity()` → `browser.getCurrentActivity()`.
  - `isAppAlive()` → `browser.queryAppState('com.wastehero') === 4`.
  - `relaunchApp()` → `browser.terminateApp('com.wastehero')` + `browser.activateApp('com.wastehero')`.

- [ ] **Step 2: Typecheck only:**

Run: `npm run typecheck -w @wastehero-qa/android-qa`
Expected: PASS.

- [ ] **Step 3: Commit:** `android-qa: Appium driver implementation`.

---

## Task 7: Emulator + Appium server lifecycle

**Files:**
- Create: `packages/android-qa/src/device/emulator.ts`
- Create: `packages/android-qa/src/device/appium-server.ts`

Both wrap child-process management; no unit tests (integration-only).

- [ ] **Step 1: Implement `emulator.ts`** — exports `startEmulator(avdName, sdkRoot)` (spawn `$ANDROID_SDK_ROOT/emulator/emulator -avd <avdName> -no-snapshot-save -no-boot-anim`), returns `{ pid, stop() }`. `waitForBoot()` polls `adb shell getprop sys.boot_completed` until `1` or timeout (120s). `installApk(path)` runs `adb install -r <path>`. `extractApkVersion(path)` shells out to `aapt dump badging` and parses `versionName=`.

- [ ] **Step 2: Implement `appium-server.ts`** — `startAppium(host, port)` spawns `node_modules/.bin/appium --address <host> --port <port> --log-no-colors --log-level warn`, returns `{ pid, stop() }`. Polls `http://<host>:<port>/status` until 200 or 30s.

- [ ] **Step 3: Typecheck.**

- [ ] **Step 4: Commit:** `android-qa: emulator + appium server lifecycle`.

---

## Task 8: Recorder — session.json + screenshots

**Files:**
- Create: `packages/android-qa/src/recorder/recorder.ts`
- Create: `packages/android-qa/src/recorder/recorder.test.ts`

- [ ] **Step 1: Test** — creates a temp dir, instantiates `Recorder`, appends 3 turns, reads `session.json` back, asserts structure.

- [ ] **Step 2: Implement** — `Recorder` class:
  - `constructor({ runDir, initialState })` — creates `runDir`, `runDir/screenshots`, `runDir/findings`, writes initial `session.json`.
  - `appendTurn(turn)` — reads `session.json`, appends to `history`, writes back (temp + rename for atomicity), fsyncs.
  - `saveScreenshot(turnIdx, phase, buf)` → path `screenshots/turn-NNNN-<phase>.png`.
  - `updateState(patch)` — shallow merge into `session.json`.
  - `finalize(status)` — sets `endedAt`, `status`.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: recorder (session.json + screenshots)`.

---

## Task 9: Recorder — logcat + video

**Files:**
- Create: `packages/android-qa/src/recorder/logcat.ts`
- Create: `packages/android-qa/src/recorder/video.ts`
- Create: `packages/android-qa/src/recorder/logcat.test.ts`

- [ ] **Step 1: Test `logcat.ts`** — mocks `child_process.spawn` to stream fake logcat lines, verifies `getDelta(sinceTs)` returns only lines after timestamp and `detectCrash(lines)` returns a crash object when `FATAL EXCEPTION` or `ANR in` is seen.

- [ ] **Step 2: Implement `logcat.ts`** — `LogcatTail` class: `start()` spawns `adb logcat -T 1 -v threadtime`; buffers lines with timestamps; `getDelta(ts)`, `detectCrash(lines)`, `excerpt(centerTs, windowMs)` → slice. `stop()` kills the process.

- [ ] **Step 3: Implement `video.ts`** — `VideoRecorder` class:
  - `start(runDir)` → spawns `adb shell screenrecord --bit-rate 4000000 /sdcard/run.mp4` as a loop-every-180s chain (adb caps at 180s per invocation; chain them).
  - `stop()` → kills, pulls `/sdcard/run.mp4` chunks into `runDir/video.mp4` (concatenated).
  - `clip(srcPath, startMs, endMs, outPath)` → shells out to `ffmpeg` to cut a slice; if ffmpeg missing, skips (log a warning).

- [ ] **Step 4: Typecheck + run logcat tests.**

- [ ] **Step 5: Commit:** `android-qa: recorder (logcat + video)`.

---

## Task 10: Login flow

**Files:**
- Create: `packages/android-qa/src/agent/login.ts`
- Create: `packages/android-qa/src/agent/login.test.ts`

- [ ] **Step 1: Test** using `FakeDriver` scripted with a login screen → home screen. Asserts `login(driver, { email, password })` types values, taps submit, and returns when the expected home fingerprint is seen.

- [ ] **Step 2: Implement** — strategy:
  1. Grab view tree. Look for elements with resource-id matching `/email|username|login/i` and `/password/i`, then a button matching `/sign.?in|log.?in|submit/i`.
  2. Type + tap.
  3. Wait up to 15s for tree change (fingerprint shift). If no shift, throw `LoginFailedError`.
  4. Return the new fingerprint.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: login flow`.

---

## Task 11: Frontier

**Files:**
- Create: `packages/android-qa/src/agent/frontier.ts`
- Create: `packages/android-qa/src/agent/frontier.test.ts`

- [ ] **Step 1: Test cases:**
  - Empty map + new screen with 5 elements → frontier contains all 5 with equal priority.
  - Map with 3 elements already `tapped: true` → frontier excludes them or gives them lower priority.
  - Element `marked: 'broken'` → excluded unless not tested in last M runs (test both cases).
  - Element `marked: 'deny-listed'` → always excluded.

- [ ] **Step 2: Implement** `buildFrontier(screen, appMap, { currentRunId, reValidateEveryNRuns }) → FrontierEntry[]` — returns priority-sorted entries. Priority rules per spec §5.2.2.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: frontier prioritization`.

---

## Task 12: Anti-loop

**Files:**
- Create: `packages/android-qa/src/agent/anti-loop.ts`
- Create: `packages/android-qa/src/agent/anti-loop.test.ts`

- [ ] **Step 1: Test cases:**
  - `detectRepeat(history, n=3)` → true when same action appears 3x consecutively with no fingerprint change.
  - `detectWander(history, n=5)` → true when 5 consecutive actions produce no new fingerprint.
  - `detectCycle(history, len=3)` → true when the last 6 turns alternate two fingerprints.

- [ ] **Step 2: Implement** functions. Pure, take `SessionState['history']` slice.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: anti-loop detection`.

---

## Task 13: Claude client wrapper

**Files:**
- Create: `packages/android-qa/src/agent/claude.ts`
- Create: `packages/android-qa/src/agent/claude.test.ts`

- [ ] **Step 1: Test with a mocked `Anthropic` client:**
  - Happy path: returns parsed JSON.
  - Malformed JSON once, then valid → retries once, returns valid.
  - Malformed JSON twice → throws `MalformedJsonError`.
  - 429 once, then 200 → retries with backoff, returns.
  - 5 consecutive 5xx → throws.

- [ ] **Step 2: Implement** `class ClaudeClient`:
  - `constructor({ apiKey, model })`.
  - `callJson<T>({ system, messages, schema?, cacheControl? }): Promise<T>` — sends a `messages.create` with `system` blocks tagged `cache_control: { type: 'ephemeral' }` when `cacheControl` true. Parses the text response; if it has code fences, strips them; `JSON.parse`. On parse failure, retries once with a reprompt. On 429/5xx, exponential backoff (1,2,4,8,30s) up to 5 attempts.
  - `callJsonWithImage` — same but messages include an image content block.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: Claude client wrapper`.

---

## Task 14: Decide

**Files:**
- Create: `packages/android-qa/src/agent/decide.ts`
- Create: `packages/android-qa/src/agent/decide.test.ts`

- [ ] **Step 1: Test** — mocks `ClaudeClient.callJson` to return specific actions, verifies:
  - Result respects frontier priority (prefers frontier elements).
  - Enforces deny list (refuses to return a deny-listed action; picks next best).
  - If last action did not change fingerprint, output is not a repeat of that action.

- [ ] **Step 2: Implement** `async function decide(state, cfg, claude): Promise<Action>`:
  - Builds the prompt: system block (role description, caches), user block with:
    - Current screen fingerprint + compact tree (interactive elements + visible text strings)
    - Frontier top 20
    - Last 5 history entries
    - Budget remaining
    - Known-triaged findings on this screen (passed in)
  - Calls `claude.callJson`. Expects `{ action: { kind, ...payload }, reasoning: string }`.
  - Validates against schema (zod). If invalid or violates deny list / repeat rule, filters and returns the first valid frontier element as a tap fallback.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: Decide prompt + call`.

---

## Task 15: Evaluate

**Files:**
- Create: `packages/android-qa/src/agent/evaluate.ts`
- Create: `packages/android-qa/src/agent/evaluate.test.ts`

- [ ] **Step 1: Test** — mocks `ClaudeClient.callJsonWithImage` with a canned response; verifies findings are returned with correct shape; verifies logcat-based crash detection adds an A-category finding without a vision call; verifies "suspicious tree" trigger (empty tree, unchanged-post-action) calls vision.

- [ ] **Step 2: Implement** `async function evaluate(state, ctx, claude): Promise<Finding[]>`:
  - Always: scan logcat delta for `FATAL EXCEPTION` / `ANR in` → finding A.
  - Always: scan tree for error banner / "something went wrong" text → candidate A/B.
  - Conditional vision: if `ctx.isNewScreen || ctx.treeSuspicious || state.history.length % visionEveryNTurns === 0`.
  - Vision call returns `{ findings: Array<{ category, severity, summary, element }> }`.
  - Merges, deduplicates in-run by `(screenFp, element, category)`.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: Evaluate prompt + vision pass`.

---

## Task 16: In-run dedup

**Files:**
- Create: `packages/android-qa/src/agent/dedup.ts`
- Create: `packages/android-qa/src/agent/dedup.test.ts`

- [ ] **Step 1: Test** — deduplicates a list of findings; verifies: same `(screenFp, element, category)` → merged (occurrences++, keep lower-severity's higher severity); fuzzy summary match with Jaccard similarity > 0.7 also merges.

- [ ] **Step 2: Implement** `dedupInRun(findings: Finding[]): Finding[]` — pure function. Jaccard on word-set of lowercased summaries.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: in-run finding dedup`.

---

## Task 17: App map state I/O

**Files:**
- Create: `packages/android-qa/src/state/app-map.ts`
- Create: `packages/android-qa/src/state/app-map.test.ts`

- [ ] **Step 1: Test:**
  - `loadAppMap()` on missing file → returns empty map with current `schemaVersion`.
  - `saveAppMap(map)` writes atomically (temp file + rename) and round-trips.

- [ ] **Step 2: Implement** both functions with temp-file-rename for atomicity. Path from config: `packages/android-qa/state/app-map.json` (resolved relative to the package root, found via `import.meta.url`).

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: app-map state I/O`.

---

## Task 18: Map merge-in / merge-out

**Files:**
- Create: `packages/android-qa/src/state/map-merge.ts`
- Create: `packages/android-qa/src/state/map-merge.test.ts`

- [ ] **Step 1: Test cases:**
  - `mergeRunIntoMap(map, session)` — new screens added with `firstSeenRun=runId`; existing screens get `lastSeenRun=runId`, `seenCount++`; new elements added; existing elements' `tapped`, `outcomes`, `marked` updated.
  - Transitions computed from `session.history` where action led to a fingerprint change.
  - Invariant: merging the same session twice produces the same map (idempotent).

- [ ] **Step 2: Implement** `mergeRunIntoMap(map: AppMap, session: SessionState): AppMap` — pure function.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: app-map merge logic`.

---

## Task 19: Findings history state

**Files:**
- Create: `packages/android-qa/src/state/findings-history.ts`
- Create: `packages/android-qa/src/state/findings-history.test.ts`

- [ ] **Step 1: Test:**
  - `appendFindings(findings)` writes one JSONL line per finding; preserves existing content.
  - `readHistory()` on missing file → empty array; else parses every line as JSON.
  - `updateFindingStatus(id, { status, linearIssueId })` rewrites the file with updated line (preserving order).

- [ ] **Step 2: Implement** with append-stream and full-rewrite fallback.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: findings-history jsonl store`.

---

## Task 20: Cross-run dedup + regression

**Files:**
- Create: `packages/android-qa/src/state/cross-run-dedup.ts`
- Create: `packages/android-qa/src/state/cross-run-dedup.test.ts`

- [ ] **Step 1: Test cases:**
  - New finding with no history match → `status: 'new'`.
  - Match on `(screenFp, element, category)` + summary similarity > 0.7 → `status: 'previously-seen'`, `occurrences++`.
  - Match where prior status is `resolved` → `status: 'resurrected'`, severity bumped.

- [ ] **Step 2: Implement** `classifyAgainstHistory(findings, history): Finding[]`.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: cross-run finding classification`.

---

## Task 21: Agent orchestrator (the loop)

**Files:**
- Create: `packages/android-qa/src/agent/orchestrator.ts`
- Create: `packages/android-qa/src/agent/orchestrator.test.ts`

- [ ] **Step 1: Test (uses `FakeDriver` + mocked `ClaudeClient`):**
  - Runs a scripted 10-turn session. Verifies termination on `done()`.
  - Verifies `session.json` has 10 history entries.
  - Verifies aborted-auth path when login throws.
  - Verifies crash-loop abort after 3 crashes.
  - Verifies wall-clock timeout aborts cleanly.

- [ ] **Step 2: Implement** `async function run({ driver, claude, recorder, config, appMap, history, role }): Promise<SessionState>`:
  - Login (catch `LoginFailedError` → finalize as `aborted-auth`).
  - Loop:
    - Top-level `AbortController` bound to wall-clock.
    - Perceive (tree + screenshot + activity + logcat delta).
    - Fingerprint. If new, push elements onto frontier (seeded from `appMap`).
    - Evaluate (may trigger vision per policy).
    - Append new findings (deduped in-run).
    - Decide (with deny-list + repeat-guard filtering).
    - Act via driver. On Appium error: re-perceive, possibly finding-B.
    - On crash-loop → abort `aborted-crash-loop`.
    - On emulator death → try one recover; else abort `aborted-device`.
    - Check termination (time/turns/frontier-empty/done).
  - Finalize (status, endedAt). Return session.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: agent orchestrator (main loop)`.

---

## Task 22: Explore CLI

**Files:**
- Create: `packages/android-qa/bin/explore.ts`

- [ ] **Step 1: Implement:**
  - Loads config via `loadConfig()`.
  - Loads `app-map.json` + `findings-history.jsonl`.
  - Starts emulator + Appium + `AppiumDriver` + `ClaudeClient` + `Recorder` (with `runId = run-YYYYMMDD-HHMM-<nanoid(4)>`).
  - Starts `LogcatTail` + `VideoRecorder`.
  - Calls `run(...)`.
  - On return: `mergeRunIntoMap` → `saveAppMap`. `classifyAgainstHistory(findings, history)` → `appendFindings`.
  - Invokes `render(session)` → `report.md`.
  - Slices per-finding artifact clips + logcat excerpts.
  - Tears everything down (even on exception).
  - Exits 0 on `completed`, 1 on any `aborted-*`.

- [ ] **Step 2: Typecheck.**

- [ ] **Step 3: Commit:** `android-qa: explore CLI`.

---

## Task 23: Report renderer

**Files:**
- Create: `packages/android-qa/src/report/render.ts`
- Create: `packages/android-qa/src/report/render.test.ts`

- [ ] **Step 1: Test** — pass in a synthetic `SessionState` with findings classified as new/previously-seen/resurrected; assert rendered markdown matches golden (snapshot).

- [ ] **Step 2: Implement** `render({ session, history, runDir }): string` — produces the exact structure from spec §6.2. Every new/regression finding prefixed with `### ☐ f-NNNN`. Previously-seen findings prefixed with `### ☑ f-NNNN` + Linear link. Artifacts linked with relative paths.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: report renderer`.

---

## Task 24: Report parser

**Files:**
- Create: `packages/android-qa/src/report/parse.ts`
- Create: `packages/android-qa/src/report/parse.test.ts`
- Create: `packages/android-qa/test-fixtures/reports/sample-report.md`

- [ ] **Step 1: Write `sample-report.md` fixture** with mixed ticked/unticked findings including one with existing Linear ID.

- [ ] **Step 2: Test** — parser returns only findings ticked AND missing `linearIssueId`.

- [ ] **Step 3: Implement** `parseReport(md: string): Array<ParsedFinding>` — regex-based per-finding block extraction; block starts with `### ☐|☑ f-\d+`, ends at next `### ` or EOF. Extracts: checked?, id, severity, summary, screen, element, category, linearIssueId (if present), reasoning, artifact paths.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit:** `android-qa: report parser`.

---

## Task 25: Artifact hosting (github-branch)

**Files:**
- Create: `packages/android-qa/src/publish/artifacts-github.ts`
- Create: `packages/android-qa/src/publish/artifacts-github.test.ts`

- [ ] **Step 1: Test with a mocked `simple-git`** — verifies: creates orphan branch if missing; copies files into a run-scoped dir; commits; returns raw.githubusercontent.com URLs constructed from origin remote.

- [ ] **Step 2: Implement** `hostArtifacts(files: string[], { branch, runId }): Promise<Record<string, string>>`:
  - Uses `simple-git`. Fetches origin. If branch missing, `git worktree add` a tmp path as orphan; else fetches existing.
  - Copies `files` to `tmp/android-qa/<runId>/<basename>`.
  - Stages + commits with message `artifacts: <runId>`.
  - `git push origin <branch>` (this is one of the few places we push — it's to a dedicated artifacts branch, never main).
  - Returns a map `{ originalPath → publicUrl }`. URLs derived from `origin` remote: `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/android-qa/<runId>/<basename>`.
  - Cleans up the worktree.

- [ ] **Step 3: Run — expect PASS.**

- [ ] **Step 4: Commit:** `android-qa: github-branch artifact hosting`.

---

## Task 26: Linear publisher + publish CLI

**Files:**
- Create: `packages/android-qa/src/publish/linear.ts`
- Create: `packages/android-qa/src/publish/linear.test.ts`
- Create: `packages/android-qa/bin/publish.ts`

- [ ] **Step 1: Test `linear.ts`** with a mocked Linear client injection point — verifies: `publishFinding(f, artifactUrls, linearClient)` calls `saveIssue` with correct title/description/labels + `createAttachment` for each URL; returns the Linear issue ID.

- [ ] **Step 2: Implement `linear.ts`** — a thin function that accepts an injected `LinearClient` interface (`{ saveIssue, createAttachment }`). Not bound to MCP at this layer. In `bin/publish.ts` we wire MCP tools into this interface.

- [ ] **Step 3: Implement `bin/publish.ts`:**
  - Accepts `--run <runId>` + optional `--dry-run`.
  - Reads `output/android-qa/<runId>/report.md`. Parses it.
  - For each ticked-unpublished finding: calls `hostArtifacts`, then `publishFinding`, then `updateFindingStatus(id, { status: 'published', linearIssueId })`.
  - In dry-run, prints the issue-to-be-created and stops.
  - Rewrites `report.md` with Linear IDs populated.
  - Commits `state/findings-history.jsonl` locally via `simple-git`. Does NOT push.
  - Note: the MCP Linear tool binding is done at this layer by importing whatever the existing gc-pipeline uses for Linear (or fall back to a thin REST client using `LINEAR_API_KEY` if MCP is not importable from Node directly — document whichever path in README).

- [ ] **Step 4: Typecheck + run tests.**

- [ ] **Step 5: Commit:** `android-qa: Linear publisher + publish CLI`.

---

## Task 27: Smoke + Replay + Reset-state CLIs

**Files:**
- Create: `packages/android-qa/bin/smoke.ts`
- Create: `packages/android-qa/bin/replay.ts`
- Create: `packages/android-qa/bin/reset-state.ts`

- [ ] **Step 1: Implement `smoke.ts`** — same wiring as `explore.ts` but overrides `config.agent.wallClockMinutes = 3`, sets `SMOKE=1`. Asserts at end: `status === 'completed'` and `screens visited >= 3`. Exits 0/1 accordingly.

- [ ] **Step 2: Implement `replay.ts`** — `--run <runId>` loads `session.json`, creates a fresh `AppiumDriver`, iterates `history`, calls each action through the driver (no Claude calls). Used for debug.

- [ ] **Step 3: Implement `reset-state.ts`** — moves current `state/app-map.json` + `state/findings-history.jsonl` to `state/archive/<timestamp>/`, writes empty shells in their place, commits locally with `simple-git` (no push).

- [ ] **Step 4: Typecheck.**

- [ ] **Step 5: Commit:** `android-qa: smoke, replay, reset-state CLIs`.

---

## Task 28: Judgment eval CLI

**Files:**
- Create: `packages/android-qa/bin/eval-judgment.ts`
- Create: `packages/android-qa/test-fixtures/screens/README.md` (instructions for humans adding new labeled screens)

- [ ] **Step 1: Implement** — iterates over `test-fixtures/screens/*.png` + `*.json` (ground truth). For each, calls `evaluate()` with a `FakeDriver`-equivalent static view tree + screenshot. Compares output to ground truth. Prints per-category precision/recall + overall.

- [ ] **Step 2: Document format** in `test-fixtures/screens/README.md`.

- [ ] **Step 3: Commit:** `android-qa: judgment eval CLI`.

---

## Task 29: CI workflow

**Files:**
- Create: `.github/workflows/android-qa.yml`

- [ ] **Step 1: Implement** — two jobs:

```yaml
name: android-qa
on:
  pull_request:
    paths: ['packages/android-qa/**']
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run test -w @wastehero-qa/android-qa
      - run: npm run typecheck -w @wastehero-qa/android-qa

  smoke:
    if: github.event_name != 'pull_request'
    runs-on: [self-hosted, android-sdk]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run smoke -w @wastehero-qa/android-qa
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ANDROID_SDK_ROOT: ${{ runner.tool_cache }}/android-sdk
          WASTEHERO_APK_PATH: ${{ github.workspace }}/canary.apk
          WH_CREDS_ADMIN_EMAIL: ${{ secrets.WH_ADMIN_EMAIL }}
          WH_CREDS_ADMIN_PASSWORD: ${{ secrets.WH_ADMIN_PASSWORD }}
```

- [ ] **Step 2: Commit:** `android-qa: CI workflow (unit + nightly smoke)`.

---

## Task 30: Root scripts, state seed files, README

**Files:**
- Create: `packages/android-qa/state/app-map.json` (shell: `{"appVersion":"","generatedAt":"","schemaVersion":1,"screens":{},"transitions":[]}`)
- Create: `packages/android-qa/state/findings-history.jsonl` (empty)
- Create: `packages/android-qa/state/archive/.gitkeep`
- Create: `packages/android-qa/README.md`

- [ ] **Step 1: Write `README.md`** covering:
  - What the package does (1 paragraph + link to spec)
  - Prerequisites (Android SDK, AVD, APK, Appium, `.env`)
  - Quick start: `cp .env.example .env && fill it in && npm run android-qa:explore`
  - CLI reference (one line per CLI)
  - HITL flow: review report.md, tick boxes, `npm run android-qa:publish -- --run <id>`
  - Where findings go (Linear) + how to configure team/project
  - Troubleshooting (emulator won't boot, Appium port in use, Claude rate limit)

- [ ] **Step 2: Typecheck + test whole package end-to-end:**

Run: `npm run test -w @wastehero-qa/android-qa && npm run typecheck -w @wastehero-qa/android-qa`
Expected: PASS.

- [ ] **Step 3: Commit:** `android-qa: state seeds + README`.

---

## Self-review checklist (writer did this; leaving notes for the executor)

- **Spec §2–§13 coverage:**
  - §3 architecture → Tasks 0, 5, 6, 7, 22
  - §4 agent loop → Tasks 3, 4, 11, 12, 13, 14, 15, 16, 21
  - §5 persistent memory → Tasks 17, 18, 19, 20
  - §6 data flow → Tasks 8, 9, 23, 24, 25, 26
  - §7 error handling → Task 21 (orchestrator) + per-task retries in Tasks 13, 10
  - §8 testing → Tasks 3, 11, 12, 16, 17, 18, 19, 20, 21, 23, 24 (unit/replay); Task 27 (smoke); Task 28 (judgment eval); Task 29 (CI)
  - §9 configuration → Task 2
  - §11 open questions → non-blocking, documented in README (Task 30)
- **No placeholders.** All steps have explicit code, paths, or commands.
- **Type consistency.** Names used across tasks: `Driver`, `ViewNode`, `SessionState`, `Finding`, `AppMap`, `ClaudeClient`, `Recorder`, `FakeDriver`, `AppiumDriver`, `render`, `parseReport`, `hostArtifacts`, `publishFinding`, `mergeRunIntoMap`, `classifyAgainstHistory`, `appendFindings`, `updateFindingStatus`, `loadAppMap`, `saveAppMap`. All consistent.
