/**
 * Nightly / on-demand smoke: a short explore run used by CI (Task 29) to
 * catch regressions in the device + agent loop without burning an hour of
 * runtime.
 *
 * Overrides (set before runExplore loads config):
 *   - `AGENT_WALL_CLOCK_MIN=3`  — cap the agent loop at 3 minutes.
 *   - `SMOKE=1`                 — breadcrumb for anything downstream that
 *                                 might care (reporter, dashboards).
 *
 * Post-run assertions:
 *   - `session.status === 'completed'` — the agent didn't abort.
 *   - `Object.keys(session.screens).length >= 3` — at least 3 distinct
 *     screens visited, i.e. login + home + one more. Less than that means
 *     the agent never escaped the login screen.
 *
 * Exit: 0 when both assertions hold, 1 otherwise.
 */

import { runExplore } from '../src/cli/run-explore';

const log = (msg: string): void => {
  console.log(`[smoke] ${msg}`);
};

async function main(): Promise<number> {
  // Apply overrides only when the caller hasn't set them explicitly — this
  // lets a developer bump the wall-clock for local debugging without having
  // to edit this file.
  if (!process.env.AGENT_WALL_CLOCK_MIN) {
    process.env.AGENT_WALL_CLOCK_MIN = '3';
  }
  process.env.SMOKE = '1';

  log(`AGENT_WALL_CLOCK_MIN=${process.env.AGENT_WALL_CLOCK_MIN}`);

  const result = await runExplore(process.argv.slice(2));
  const screensVisited = Object.keys(result.session.screens).length;
  const status = result.session.status ?? 'unknown';
  log(`status=${status} screens=${screensVisited} runId=${result.runId}`);

  const ok = status === 'completed' && screensVisited >= 3;
  if (!ok) {
    console.error(
      `[smoke] FAIL: status=${status}, screensVisited=${screensVisited} (need completed + ≥3 screens)`,
    );
    return 1;
  }
  log('PASS');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smoke] unhandled: ${message}`);
    process.exit(1);
  },
);
