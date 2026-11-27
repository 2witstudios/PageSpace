/**
 * The stdout sentinel protocol, as a pure module.
 *
 * A command that ends with `echo "<sentinel> $?"` reports its exit code on its
 * last stdout line. The Sprite driver reads it there to answer at first byte
 * (`RunCommandArgs.stdoutSentinel`), and the copy runners in `tool-runners.ts`
 * read it on every substrate. Kept free of any import because `tool-runners.ts`
 * is reachable from client bundles (through `sandbox-tools.ts`), where the
 * Sprite driver's `node:*` imports cannot be resolved.
 */

/**
 * Pure: locate a `<sentinel> <exit-code>` line in collected stdout. Returns the
 * stdout BEFORE that line and the parsed code, or null when the sentinel has not
 * arrived yet (or arrived without a numeric code — treated as not-yet, so a
 * partial chunk boundary cannot fake a result).
 */
export function findSentinel(stdout: string, sentinel: string): { stdout: string; exitCode: number } | null {
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith(sentinel)) continue;
    const code = Number(line.slice(sentinel.length).trim());
    if (!Number.isInteger(code)) return null;
    // Only a COMPLETE line counts: a sentinel at the very end with no newline
    // may still be mid-chunk (the code could be `12` of `127`).
    if (i === lines.length - 1) return null;
    return { stdout: lines.slice(0, i).join('\n'), exitCode: code };
  }
  return null;
}
