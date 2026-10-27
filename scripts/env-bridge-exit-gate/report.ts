/**
 * The exit gate's evidence format (Local Environments epic, M1 · t10).
 *
 * Every check in this harness prints ONE line per gate, in a fixed shape, so a
 * run produces evidence a reviewer can diff rather than prose someone has to
 * believe:
 *
 *   GATE <id> <PASS|FAIL|SKIP> expected=<value> actual=<value> :: <note>
 *
 * `expected` is the exact denial reason, HTTP status or close code the task
 * page names — never a category. A gate that cannot decide is a FAIL, not a
 * pass with a caveat; SKIP exists only for a check whose PRECONDITION was not
 * met (no TTY, no second drive member) and every SKIP has to be explained on
 * the task page before the gate can be called passed.
 *
 * Nothing here talks to PageSpace. It is imported by `preflight.ts`,
 * `identity-negatives.ts` and `bridge-proxy.ts`.
 */

export type GateStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface GateResult {
  readonly id: string;
  readonly status: GateStatus;
  readonly expected: string;
  readonly actual: string;
  readonly note: string;
}

/** Keep a value on one line and inside a sane width; the line format is the contract. */
function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = (text ?? 'undefined').replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

const results: GateResult[] = [];

export function record(result: GateResult): GateResult {
  results.push(result);
  process.stdout.write(`GATE ${result.id} ${result.status} expected=${oneLine(result.expected)} actual=${oneLine(result.actual)} :: ${result.note}\n`);
  return result;
}

/** The common shape: a gate passes iff `actual` equals `expected` exactly. */
export function expect(id: string, expected: unknown, actual: unknown, note: string): GateResult {
  const e = oneLine(expected);
  const a = oneLine(actual);
  return record({ id, status: e === a ? 'PASS' : 'FAIL', expected: e, actual: a, note });
}

export function skip(id: string, expected: unknown, why: string): GateResult {
  return record({ id, status: 'SKIP', expected: oneLine(expected), actual: 'not run', note: why });
}

/** A gate whose check threw. An exception is never a pass. */
export function failed(id: string, expected: unknown, error: unknown, note: string): GateResult {
  const message = error instanceof Error ? error.message : String(error);
  return record({ id, status: 'FAIL', expected: oneLine(expected), actual: `threw: ${oneLine(message)}`, note });
}

export function collected(): readonly GateResult[] {
  return results;
}

/**
 * Print the tally and return the process exit code: non-zero if ANYTHING is
 * not a PASS, skips included — a skipped gate is an unfinished gate, and the
 * exit code is what a runner (or a human in a hurry) reads.
 */
export function summarize(label: string): number {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  process.stdout.write(`\nSUMMARY ${label} pass=${pass} fail=${fail.length} skip=${skipped.length}\n`);
  for (const r of [...fail, ...skipped]) process.stdout.write(`  ${r.status} ${r.id} :: ${r.note}\n`);
  return fail.length === 0 && skipped.length === 0 ? 0 : 1;
}

/** Read a required environment variable, or die with a message naming it. */
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stderr.write(`${name} is required. See scripts/env-bridge-exit-gate/README.md ("Environment").\n`);
    process.exit(2);
  }
  return value;
}

export function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}
