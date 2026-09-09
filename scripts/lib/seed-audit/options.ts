/** Command-line options for `scripts/collab-seed-audit.ts`. */
export interface AuditOptions {
  /** Stop after this many documents — a smoke run before the full one. */
  limit: number;
  /** Rows per query. One query at a time against a `max: 1` pool, always. */
  batchSize: number;
  /** Progress line to stderr every N documents. */
  progressEvery: number;
}

function numericFlag(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;

  const value = Number(argv[index + 1]);
  // Refuse rather than fall back: `--limit` with a typo after it would
  // otherwise silently audit the whole table when a sample was asked for.
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer, e.g. ${flag} 500`);
  }
  return value;
}

export function parseAuditArgs(argv: readonly string[]): AuditOptions {
  return {
    limit: numericFlag(argv, '--limit', Number.POSITIVE_INFINITY),
    batchSize: numericFlag(argv, '--batch-size', 200),
    progressEvery: numericFlag(argv, '--progress-every', 500),
  };
}
