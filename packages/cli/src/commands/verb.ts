/**
 * The shape every org-write / drive-org verb shares (Spec X-1): fixed positionals, a few
 * `--flag value` options, one SDK call, one rendered line. Argv parsing is pure
 * (`parseVerbArgs`); a verb's own `build` turns the parsed strings into the operation's input
 * (pure, returns a usage error instead of throwing); `ctx.sdk` is the only I/O edge, through
 * `callSdk`. A verb that can remove or suspend access names a `confirm` question (null when this
 * particular input cannot) and goes through the shared confirmation gate (`--yes`, or a TTY "y").
 *
 * Verbs only ASK; the server decides (the web's requireOrgRole, the org's sign-in policy, the
 * key's scope) and its refusal is printed as-is with exit 1.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

export type VerbArgsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface ParsedVerbArgs {
  /** The positionals, in order. */
  readonly positionals: readonly string[];
  /** Each `--flag value` given, keyed by flag name without the dashes. */
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Pure: split `args` into exactly `positionalCount` positionals (or at least `minPositionals`
 * when given, for verbs with a trailing list) and the named `--flag value` options. An
 * unknown flag, a flag without a value, a repeated flag, or the wrong number of positionals is
 * a usage error naming `usage`.
 */
export function parseVerbArgs(
  args: readonly string[],
  spec: { readonly usage: string; readonly positionals: number; readonly variadic?: boolean; readonly flags?: readonly string[] },
): VerbArgsResult<ParsedVerbArgs> {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const allowed = new Set(spec.flags ?? []);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = args[i + 1];
      if (!allowed.has(name)) return { ok: false, message: `Unknown flag ${token}.\n${spec.usage}` };
      if (value === undefined || value.startsWith('--')) return { ok: false, message: `Flag ${token} requires a value.\n${spec.usage}` };
      if (name in options) return { ok: false, message: `Flag ${token} was given twice.\n${spec.usage}` };
      options[name] = value;
      i += 1;
      continue;
    }
    if (token.length === 0) return { ok: false, message: spec.usage };
    positionals.push(token);
  }
  const countOk = spec.variadic ? positionals.length >= spec.positionals : positionals.length === spec.positionals;
  if (!countOk) return { ok: false, message: spec.usage };
  return { ok: true, value: { positionals, options } };
}

/** Pure: `value` must be one of `allowed` (case-sensitive), else a usage error naming them. */
export function oneOf<T extends string>(value: string, allowed: readonly T[], what: string, usage: string): VerbArgsResult<T> {
  return (allowed as readonly string[]).includes(value)
    ? { ok: true, value: value as T }
    : { ok: false, message: `${what} must be one of: ${allowed.join(', ')}.\n${usage}` };
}

export interface VerbSpec<TInput, TOutput> {
  readonly usage: string;
  readonly positionals: number;
  readonly variadic?: boolean;
  readonly flags?: readonly string[];
  /** Pure: the parsed argv as the operation's input, or a usage error. */
  readonly build: (parsed: ParsedVerbArgs) => VerbArgsResult<TInput>;
  readonly call: (sdk: PageSpaceClient, input: TInput) => Promise<TOutput>;
  /** Pure: the human rendering (`--json` prints the raw answer instead). */
  readonly render: (value: TOutput, input: TInput) => string;
  /** Set for a verb that can remove or suspend access: the confirmation question, or null when this input cannot. */
  readonly confirm?: (input: TInput) => string | null;
}

/** The handler for one verb: parse, build, confirm when destructive, call, render. */
export function verbHandler<TInput, TOutput>(spec: VerbSpec<TInput, TOutput>): CommandHandler {
  return async (ctx, intent) => {
    const parsed = parseVerbArgs(intent.args, spec);
    const input = parsed.ok ? spec.build(parsed.value) : parsed;
    if (!input.ok) {
      ctx.stderr.write(`${input.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    const question = spec.confirm?.(input.value) ?? null;
    if (question !== null) {
      const confirmation = await confirmDestructive(question, { isTTY: ctx.isTTY, yes: intent.flags.yes, prompt: ctx.prompt });
      if (!confirmation.ok) {
        ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
        return EXIT_RUNTIME_ERROR;
      }
    }
    const result = await callSdk(ctx, () => spec.call(ctx.sdk, input.value));
    if (!result.ok) return EXIT_RUNTIME_ERROR;
    ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : spec.render(result.value, input.value));
    return EXIT_SUCCESS;
  };
}
