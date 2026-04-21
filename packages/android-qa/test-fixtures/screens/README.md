# Labeled screens for `eval-judgment`

This directory seeds the offline precision/recall harness that lives at
`bin/eval-judgment.ts`. Each fixture is a pair:

- `<slug>.png` — the screenshot that would be fed to the vision pass.
- `<slug>.json` — the view tree, the logcat delta for that turn, and the
  ground-truth findings a careful human would expect `evaluate()` to report.

The harness runs `evaluate()` against each pair and prints precision + recall
per finding category (A–E) plus an overall row.

## Adding a new fixture

1. **Capture the screenshot.** If you saw the issue during an exploratory run,
   the PNG already exists at `output/android-qa/<runId>/screenshots/turn-NNNN-post.png`.
   Copy it in as `<slug>.png`. `slug` should be lowercase-kebab, stable, and
   descriptive — e.g. `route-detail-blank-on-open`.

2. **Copy the view tree.** From the same run, the tree lives in the recorder's
   per-turn trace JSON. Pluck the `ViewNode` subtree that matches the
   screenshot and paste it into the fixture JSON under `viewTree`. You can
   prune siblings the QA judgement doesn't depend on, but keep structure that
   a reader would need to reproduce the diagnosis.

3. **Grab the logcat slice.** Paste the raw lines that were printed during
   this turn into `logcat` as an array of strings. Leave it `[]` when there
   was nothing notable.

4. **Write the ground truth.** List the findings a careful human would want
   `evaluate()` to produce in `expected`. Each entry is:

   ```jsonc
   {
     "category": "A" | "B" | "C" | "D" | "E",
     "summaryContains": "substring the predicted summary MUST contain",
     "severity": "low" | "med" | "high" | "critical", // optional
     "note": "free-form human context"                // optional
   }
   ```

   Matching is case-insensitive on `summaryContains`; `severity` is only
   enforced when you specify it. Keep `summaryContains` short and factual
   (e.g. `"blank screen"`, `"NullPointerException"`) so it survives the
   model's paraphrasing.

5. **Optional: tag with `"runVision": false`** at the top level of the JSON
   when the fixture is meant to exercise the tree / logcat scans without
   burning a vision call. The PNG is still required (so the fixture layout
   stays uniform) but won't be sent to the model.

## Fixture JSON shape

```jsonc
{
  "description": "Free-form human description of the situation.",
  "activity": "com.wastehero.MainActivity",
  "runVision": true,
  "viewTree": { /* ViewNode — see src/types/index.ts */ },
  "logcat": [
    "2026-04-21 09:12:33.451 12345 12345 E AndroidRuntime: FATAL EXCEPTION: main",
    "2026-04-21 09:12:33.452 12345 12345 E AndroidRuntime: java.lang.NullPointerException"
  ],
  "expected": [
    {
      "category": "A",
      "severity": "critical",
      "summaryContains": "NullPointerException",
      "note": "Route Detail crash when opened from Schedule"
    }
  ]
}
```

## Running the harness

```bash
ANTHROPIC_API_KEY=<key> npm run eval-judgment -w @wastehero-qa/android-qa
```

The CLI prints a per-fixture block (matched / extra / missed) followed by a
per-category summary. Use that summary as the north star when tuning prompts
or trigger heuristics — a change that improves one category but tanks
another will show up immediately.

## What belongs here

Good fixtures:
- A crash we reliably detect (A/critical) — regression canary.
- A blank white screen (A/high) — pure-vision sanity check.
- A misaligned form field (D/low) — guards against polish-drift in the model.
- A screen we intentionally expect to produce NOTHING — guards against
  false-positive drift.

Avoid:
- Long multi-screen scenarios — this is a single-screen evaluator.
- Flaky reproducers (network timeouts, race conditions) — the PNG is fixed,
  but the model's classification can still wobble; keep them out of the
  corpus unless you expect the model to be stable.
