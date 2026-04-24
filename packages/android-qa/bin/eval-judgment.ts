/**
 * `android-qa:eval-judgment`
 *
 * Offline evaluator for the `evaluate()` pipeline — runs it against a
 * hand-labeled corpus in `test-fixtures/screens/` and prints precision +
 * recall per category. The corpus gives us something concrete to chase when
 * iterating on the prompt, the vision trigger, and the tree/logcat scans.
 *
 * Fixture layout: each screen is a pair `<slug>.png` + `<slug>.json` in
 * `test-fixtures/screens/`. The JSON provides the view tree, the logcat
 * delta, and the ground-truth findings. See
 * `test-fixtures/screens/README.md` for the schema and a worked example.
 *
 * Matching rule: a predicted finding matches a ground-truth entry when their
 * `category` agrees AND the predicted `summary` contains the ground-truth
 * `summaryContains` substring (case-insensitive). Extra predictions in a
 * category that has any ground-truth entries are FPs for that category.
 *
 * ANTHROPIC_API_KEY is required — the CLI makes live vision calls.
 */

import 'dotenv/config';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeClient } from '../src/agent/claude';
import { evaluate } from '../src/agent/evaluate';
import { fingerprintFromTree } from '../src/agent/fingerprint';
import type {
  Category,
  Finding,
  SessionState,
  Severity,
  ViewNode,
} from '../src/types/index';

interface ExpectedFinding {
  category: Category;
  /** Substring matched case-insensitively against the predicted summary. */
  summaryContains: string;
  /** Optional — when set, the predicted severity must match. */
  severity?: Severity;
  /** Optional hint carried through to the printout; not used for matching. */
  note?: string;
}

interface Fixture {
  description: string;
  activity: string;
  viewTree: ViewNode;
  logcat: string[];
  /** If omitted, the vision pass is skipped for this fixture — useful for
   *  tree-only / logcat-only baseline cases where the PNG is a placeholder. */
  runVision?: boolean;
  expected: ExpectedFinding[];
}

interface FixtureFile {
  slug: string;
  pngPath: string;
  jsonPath: string;
  data: Fixture;
}

/** Per-fixture breakdown we print, and fold into the totals. */
interface FixtureOutcome {
  slug: string;
  predicted: Finding[];
  matches: Array<{ predicted: Finding; expected: ExpectedFinding }>;
  unmatchedPredicted: Finding[];
  unmatchedExpected: ExpectedFinding[];
}

const log = (msg: string): void => {
  console.log(`[eval] ${msg}`);
};

/** `test-fixtures/screens` under the package root. `bin/eval-judgment.ts`
 *  → `packages/android-qa/bin/` so up one `..` gets us to the package root. */
function fixturesDir(): string {
  return fileURLToPath(new URL('../test-fixtures/screens/', import.meta.url));
}

/** Require ANTHROPIC_API_KEY at startup so a misconfigured run fails fast
 *  instead of halfway through the corpus. */
function readApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is required for eval-judgment');
  }
  return key;
}

function loadFixtures(dir: string): FixtureFile[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const jsonFiles = entries.filter((f) => f.endsWith('.json') && f !== 'README.md');
  const out: FixtureFile[] = [];
  for (const j of jsonFiles) {
    const slug = basename(j, '.json');
    const pngPath = join(dir, `${slug}.png`);
    const jsonPath = join(dir, j);
    if (!existsSync(pngPath)) {
      console.error(`[eval] skipping ${slug}: missing ${slug}.png`);
      continue;
    }
    const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as Fixture;
    out.push({ slug, pngPath, jsonPath, data });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Match a fixture's predictions against its ground truth. Each expected
 *  entry binds to at most one predicted finding (first match wins, in
 *  fixture declaration order — makes the output stable). */
function scoreFixture(
  slug: string,
  predicted: Finding[],
  expected: ExpectedFinding[],
): FixtureOutcome {
  const matches: FixtureOutcome['matches'] = [];
  const usedPredicted = new Set<number>();
  const unmatchedExpected: ExpectedFinding[] = [];

  for (const e of expected) {
    const needle = e.summaryContains.toLowerCase();
    const idx = predicted.findIndex(
      (p, i) =>
        !usedPredicted.has(i) &&
        p.category === e.category &&
        p.summary.toLowerCase().includes(needle) &&
        (e.severity === undefined || p.severity === e.severity),
    );
    if (idx === -1) {
      unmatchedExpected.push(e);
    } else {
      usedPredicted.add(idx);
      matches.push({ predicted: predicted[idx], expected: e });
    }
  }

  const unmatchedPredicted = predicted.filter((_, i) => !usedPredicted.has(i));
  return { slug, predicted, matches, unmatchedPredicted, unmatchedExpected };
}

const CATEGORIES: Category[] = ['A', 'B', 'C', 'D', 'E'];

interface CategoryCounts {
  tp: number;
  fp: number;
  fn: number;
}

function foldCategoryCounts(outcomes: FixtureOutcome[]): Record<Category, CategoryCounts> {
  const counts: Record<Category, CategoryCounts> = {
    A: { tp: 0, fp: 0, fn: 0 },
    B: { tp: 0, fp: 0, fn: 0 },
    C: { tp: 0, fp: 0, fn: 0 },
    D: { tp: 0, fp: 0, fn: 0 },
    E: { tp: 0, fp: 0, fn: 0 },
  };
  for (const o of outcomes) {
    for (const m of o.matches) counts[m.predicted.category].tp += 1;
    for (const p of o.unmatchedPredicted) counts[p.category].fp += 1;
    for (const e of o.unmatchedExpected) counts[e.category].fn += 1;
  }
  return counts;
}

function pctOrDash(num: number, den: number): string {
  if (den === 0) return '  n/a';
  return `${((num / den) * 100).toFixed(1).padStart(5)}%`;
}

function printReport(outcomes: FixtureOutcome[]): void {
  console.log('');
  for (const o of outcomes) {
    const matched = o.matches.length;
    const expected = o.matches.length + o.unmatchedExpected.length;
    const extras = o.unmatchedPredicted.length;
    console.log(
      `[eval] ${o.slug}: matched=${matched}/${expected} extras=${extras}`,
    );
    for (const m of o.matches) {
      console.log(
        `  ✓ ${m.predicted.category} ${m.predicted.severity.padEnd(8)} "${m.predicted.summary}"`,
      );
    }
    for (const p of o.unmatchedPredicted) {
      console.log(
        `  + ${p.category} ${p.severity.padEnd(8)} "${p.summary}" (extra)`,
      );
    }
    for (const e of o.unmatchedExpected) {
      console.log(
        `  − ${e.category} ${(e.severity ?? '-').padEnd(8)} want:"${e.summaryContains}" (missed)`,
      );
    }
    console.log('');
  }

  const counts = foldCategoryCounts(outcomes);
  console.log('[eval] per-category results:');
  console.log('  cat  precision   recall   tp  fp  fn');
  let totalTP = 0;
  let totalFP = 0;
  let totalFN = 0;
  for (const c of CATEGORIES) {
    const { tp, fp, fn } = counts[c];
    console.log(
      `   ${c}    ${pctOrDash(tp, tp + fp)}   ${pctOrDash(tp, tp + fn)}   ${String(tp).padStart(2)}  ${String(fp).padStart(2)}  ${String(fn).padStart(2)}`,
    );
    totalTP += tp;
    totalFP += fp;
    totalFN += fn;
  }
  console.log(
    `  all    ${pctOrDash(totalTP, totalTP + totalFP)}   ${pctOrDash(totalTP, totalTP + totalFN)}   ${String(totalTP).padStart(2)}  ${String(totalFP).padStart(2)}  ${String(totalFN).padStart(2)}`,
  );
}

async function runFixture(
  fixture: FixtureFile,
  claude: ClaudeClient,
): Promise<FixtureOutcome> {
  const png = readFileSync(fixture.pngPath);
  const screenFp = fingerprintFromTree(
    fixture.data.viewTree,
    fixture.data.activity,
  );

  const state: SessionState = {
    runId: `eval-${fixture.slug}`,
    appVersion: '0.0.0',
    role: 'eval',
    startedAt: new Date().toISOString(),
    budget: { wallClockMs: 60_000, turns: 1 },
    counters: { crashCount: 0, noNewScreenStreak: 0, malformedJsonCount: 0 },
    screens: {},
    frontier: [],
    findings: [],
    history: [],
  };

  const runVision = fixture.data.runVision !== false;
  const findings = await evaluate(
    state,
    {
      currentScreenFp: screenFp,
      currentTree: fixture.data.viewTree,
      logcatDelta: fixture.data.logcat,
      isNewScreen: true,
      treeSuspicious: runVision,
      screenshotBase64: runVision ? png.toString('base64') : null,
      imageMediaType: 'image/png',
    },
    { model: process.env.AGENT_MODEL ?? 'claude-opus-4-7', visionEveryNTurns: 1 },
    claude,
  );

  return scoreFixture(fixture.slug, findings, fixture.data.expected);
}

async function main(): Promise<number> {
  const apiKey = readApiKey();
  const dir = fixturesDir();
  const fixtures = loadFixtures(dir);
  log(`fixtures=${fixtures.length} dir=${dir}`);
  if (fixtures.length === 0) {
    log('no fixtures to evaluate — see test-fixtures/screens/README.md');
    return 0;
  }

  const claude = new ClaudeClient({
    apiKey,
    model: process.env.AGENT_MODEL ?? 'claude-opus-4-7',
  });

  const outcomes: FixtureOutcome[] = [];
  for (const f of fixtures) {
    log(`  running ${f.slug}...`);
    try {
      outcomes.push(await runFixture(f, claude));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[eval] ${f.slug} threw: ${message}`);
      // Surface the failure in the report instead of aborting the whole run:
      // each unmet expected becomes an FN so metrics still reflect the gap.
      outcomes.push({
        slug: f.slug,
        predicted: [],
        matches: [],
        unmatchedPredicted: [],
        unmatchedExpected: f.data.expected,
      });
    }
  }

  printReport(outcomes);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[eval] unhandled: ${message}`);
    process.exit(1);
  },
);
