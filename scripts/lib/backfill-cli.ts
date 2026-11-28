/**
 * The CLI shared by the one-shot backfills (`backfill-imago-agents.ts`,
 * `backfill-home-envs.ts`): one copy of the flags, the exit code, and the
 * rule that failure output never carries a row value.
 */

/** Exit 1 when any row failed, so a deploy step sees it; 0 otherwise. */
export function exitCodeFor(summary: { failed: number }): number {
  return summary.failed > 0 ? 1 : 0;
}

export interface CliArgs {
  dryRun: boolean;
  batchSize: number;
  limit: number | undefined;
}

/** `--dry-run`, `--batch-size N`, `--limit N` (also `--flag=N`); anything else throws. */
export function parseArgs(argv: readonly string[], defaultBatchSize: number): CliArgs {
  const args: CliArgs = { dryRun: false, batchSize: defaultBatchSize, limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = () => {
      const raw = inline ?? argv[++i];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        throw new Error(`${flag} needs a positive integer`);
      }
      return Number(raw);
    };
    if (flag === '--dry-run' && inline === undefined) args.dryRun = true;
    else if (flag === '--batch-size') args.batchSize = value();
    else if (flag === '--limit') args.limit = value();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/**
 * Names the failure without any text that could carry a row value: the
 * error's class, the driver's SQLSTATE and, when reported, the constraint and
 * table names — schema identifiers, never data.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const detail = current as Error & { code?: unknown; constraint?: unknown; table?: unknown };
    parts.push(current.constructor.name || 'Error');
    if (typeof detail.code === 'string' && /^[0-9A-Z]{5}$/.test(detail.code)) parts.push(`SQLSTATE ${detail.code}`);
    if (typeof detail.constraint === 'string') parts.push(`constraint ${detail.constraint}`);
    if (typeof detail.table === 'string') parts.push(`table ${detail.table}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'non-Error value thrown';
}
