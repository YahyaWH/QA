/**
 * In-place patches for the rendered QA report (`report.md`). Used by the
 * publish CLI to splice Linear identifiers into finding headings after issues
 * are filed, without re-rendering (which would overwrite human edits the
 * spec §6.3 says to respect).
 */

/**
 * Regex-escape a literal string for embedding in a `new RegExp`. Covers only
 * the metacharacters we might see in a display id (`f-XXXX`) — but the full
 * ASCII set is cheap to escape and keeps this helper reusable.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splice ` — <identifier> (open)` onto the heading line for `displayId` in
 * the given markdown. Idempotent when the suffix is already present, and
 * replaces a stale suffix when the identifier differs.
 *
 * Matches BOTH check marks (☐/☑) so the helper is agnostic to whether the
 * box was ticked — the caller is responsible for selecting the right blocks.
 *
 * Returns the input unchanged when no heading matches.
 */
export function patchReportHeader(
  md: string,
  displayId: string,
  identifier: string,
): string {
  const idPattern = escapeRegex(displayId);
  // Anchor: `^### (☐|☑) f-XXXX — [SEV] …`, optionally followed by a
  // ` — WH-NNN (open)` suffix. Summary tail is lazy so we don't eat
  // a pre-existing suffix.
  const re = new RegExp(
    `^(### (?:\\u2610|\\u2611) ${idPattern} \\u2014 \\[[A-Z]+\\] .+?)( \\u2014 WH-\\d+ \\(open\\))?\\s*$`,
    'm',
  );
  const match = re.exec(md);
  if (!match) return md;

  const [full, head, existingSuffix] = match;
  const desiredSuffix = ` \u2014 ${identifier} (open)`;
  if (existingSuffix === desiredSuffix) return md;

  const replacement = `${head}${desiredSuffix}`;
  return md.slice(0, match.index) + replacement + md.slice(match.index + full.length);
}
