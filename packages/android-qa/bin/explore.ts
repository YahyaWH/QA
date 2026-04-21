/**
 * Thin CLI wrapper around `runExplore`. The pipeline itself lives in
 * `src/cli/run-explore.ts` so `bin/smoke.ts` can call it with env overrides
 * + post-run assertions.
 *
 * Exits with the pipeline's exit code (0 on `status === 'completed'`, 1
 * otherwise).
 */

import { runExplore } from '../src/cli/run-explore';

runExplore(process.argv.slice(2)).then(
  (result) => process.exit(result.exitCode),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[explore] unhandled: ${message}`);
    process.exit(1);
  },
);
