/**
 * parseArgv — the CLI's pure grammar (Phase 4 task 1). Turns raw argv tokens
 * into a typed `CommandIntent` or a typed `UsageError`; never touches
 * `process.*`, never throws. Command-tree validity (does "tokens create"
 * resolve to a handler?) is the router's job, not this function's — parseArgv
 * only understands the fixed global-flag grammar every command shares.
 *
 * Zero trust: a rejected flag's value is never echoed back in the error
 * message, only the flag name — the value may be a secret (`--token`).
 *
 * Command-specific flags (e.g. `tokens create --name`) are not part of this
 * global grammar. Once at least one positional/command token has been seen,
 * an unrecognized `--flag` is passed through into `args` verbatim for the
 * command's own pure arg-mapper to interpret — only a `--flag` with NO
 * preceding positional token is a hard usage error (there is no command yet
 * to hand it to).
 *
 * Value-bearing flags (`--host`, `--token`, `--profile`) also accept the equals-joined
 * form (`--host=value`), not just space-separated (`--host value`) —
 * resolved before any other grammar rule so `--host=-looks-like-a-flag` is
 * unambiguously a value, not a following flag. Boolean flags (`--json`,
 * `--yes`, ...) deliberately do NOT accept an equals-joined value: presence
 * always means true, and there is no well-defined meaning for an
 * unrecognized value on a confirmation flag like `--yes=oops` — better to
 * reject it as an unknown flag than silently coerce a typo to `false`.
 */

export interface ParsedFlags {
  readonly json: boolean;
  readonly host: string | undefined;
  readonly token: string | undefined;
  readonly profile: string | undefined;
  readonly yes: boolean;
  readonly all: boolean;
  readonly force: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly device: boolean;
}

export interface CommandIntent {
  readonly kind: 'command';
  /** Positional tokens in order: the command path followed by any command-specific args. */
  readonly args: readonly string[];
  readonly flags: ParsedFlags;
}

export interface UsageError {
  readonly kind: 'usage-error';
  readonly message: string;
}

export type ParseResult = CommandIntent | UsageError;

const VALUE_FLAGS = new Set(['--host', '--token', '--profile']);
const BOOLEAN_FLAGS = new Set(['--json', '--yes', '--all', '--force', '--help', '--version', '--device']);

export function parseArgv(argv: readonly string[]): ParseResult {
  let json = false;
  let host: string | undefined;
  let token: string | undefined;
  let profile: string | undefined;
  let yes = false;
  let all = false;
  let force = false;
  let help = false;
  let version = false;
  let device = false;
  const args: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const eqIndex = current.startsWith('--') ? current.indexOf('=') : -1;
    const flagName = eqIndex === -1 ? current : current.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : current.slice(eqIndex + 1);

    if (VALUE_FLAGS.has(flagName)) {
      const value = inlineValue ?? argv[i + 1];
      const missing = value === undefined || value.length === 0 || (inlineValue === undefined && value.startsWith('-'));
      if (missing) {
        return { kind: 'usage-error', message: `Flag ${flagName} requires a value.` };
      }
      if (flagName === '--host') host = value;
      else if (flagName === '--token') token = value;
      else profile = value;
      if (inlineValue === undefined) i += 1;
      continue;
    }

    if (BOOLEAN_FLAGS.has(current)) {
      if (current === '--json') json = true;
      else if (current === '--yes') yes = true;
      else if (current === '--all') all = true;
      else if (current === '--force') force = true;
      else if (current === '--help') help = true;
      else if (current === '--version') version = true;
      else device = true;
      continue;
    }

    if (current.startsWith('-')) {
      if (args.length === 0) {
        return { kind: 'usage-error', message: `Unknown flag: ${current}` };
      }
      args.push(current);
      continue;
    }

    args.push(current);
  }

  return {
    kind: 'command',
    args,
    flags: { json, host, token, profile, yes, all, force, help, version, device },
  };
}
