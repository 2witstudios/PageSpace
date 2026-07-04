/**
 * Shared destructive-verb confirmation gate (Phase 5 task 1 law): `--yes`
 * always skips the prompt; a non-TTY invocation without `--yes` fails closed
 * without ever prompting (never hangs waiting on stdin in CI); a TTY
 * invocation without `--yes` prompts and requires an affirmative answer.
 *
 * `isAffirmative` is injected per-call so callers needing a stronger gate
 * (e.g. "type the drive's name") can supply their own answer predicate
 * instead of the plain yes/no default.
 */
export type ConfirmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'non_tty_missing_yes' | 'declined' };

export interface ConfirmDestructiveOptions {
  readonly isTTY: boolean;
  readonly yes: boolean;
  readonly prompt: (message: string) => Promise<string>;
  readonly isAffirmative?: (answer: string) => boolean;
}

/** Pure: no I/O, total. */
export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export async function confirmDestructive(message: string, options: ConfirmDestructiveOptions): Promise<ConfirmOutcome> {
  if (options.yes) {
    return { ok: true };
  }
  if (!options.isTTY) {
    return { ok: false, reason: 'non_tty_missing_yes' };
  }
  const answer = await options.prompt(message);
  const isAffirmative = options.isAffirmative ?? isYes;
  return isAffirmative(answer) ? { ok: true } : { ok: false, reason: 'declined' };
}

export function confirmationFailureMessage(outcome: Extract<ConfirmOutcome, { ok: false }>): string {
  return outcome.reason === 'non_tty_missing_yes'
    ? 'Refusing to proceed without confirmation in a non-interactive session. Re-run with --yes.'
    : 'Aborted: not confirmed.';
}
