/** Command-line options for `scripts/collab-seed-audit.ts`. */
export interface AuditOptions {
  /** Stop after this many documents — a smoke run before the full one. */
  limit: number;
  /** Rows per query. One query at a time against a `max: 1` pool, always. */
  batchSize: number;
  /** Progress line to stderr every N documents. */
  progressEvery: number;
}

const FLAGS = ['--limit', '--batch-size', '--progress-every'] as const;

/**
 * `--flag value` and `--flag=value` both work; anything else on the command
 * line is refused. `--limt 5` or `--limit=5` silently auditing the whole table
 * is the exact outcome a smoke run exists to avoid.
 */
function numericFlag(argv: readonly string[], flag: string, fallback: number): number {
  const joined = argv.find((token) => token.startsWith(`${flag}=`));
  const index = argv.indexOf(flag);
  if (joined === undefined && index < 0) return fallback;

  const raw = joined === undefined ? argv[index + 1] : joined.slice(flag.length + 1);
  const value = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer, e.g. ${flag} 500`);
  }
  return value;
}

export function parseAuditArgs(argv: readonly string[]): AuditOptions {
  const known = new Set<string>(FLAGS);
  argv.forEach((token, index) => {
    const isFlag = known.has(token) || [...known].some((flag) => token.startsWith(`${flag}=`));
    const isValueOfFlag = index > 0 && known.has(argv[index - 1]);
    if (!isFlag && !isValueOfFlag) {
      throw new Error(`unknown argument ${token}; expected one of ${FLAGS.join(', ')}`);
    }
  });
  return {
    limit: numericFlag(argv, '--limit', Number.POSITIVE_INFINITY),
    batchSize: numericFlag(argv, '--batch-size', 200),
    progressEvery: numericFlag(argv, '--progress-every', 500),
  };
}
