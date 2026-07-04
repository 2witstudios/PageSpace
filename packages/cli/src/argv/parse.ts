/**
 * parseArgv — the CLI's pure grammar (Phase 4 task 1). Turns raw argv tokens
 * into a typed `CommandIntent` or a typed `UsageError`; never touches
 * `process.*`, never throws. Command-tree validity (does "tokens create"
 * resolve to a handler?) is the router's job, not this function's — parseArgv
 * only understands the fixed global-flag grammar every command shares.
 *
 * Zero trust: a rejected flag's value is never echoed back in the error
 * message, only the flag name — the value may be a secret (`--token`).
 */

export interface ParsedFlags {
  readonly json: boolean;
  readonly host: string | undefined;
  readonly token: string | undefined;
  readonly yes: boolean;
  readonly all: boolean;
  readonly force: boolean;
  readonly help: boolean;
  readonly version: boolean;
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

const VALUE_FLAGS = new Set(['--host', '--token']);
const BOOLEAN_FLAGS = new Set(['--json', '--yes', '--all', '--force', '--help', '--version']);

export function parseArgv(argv: readonly string[]): ParseResult {
  let json = false;
  let host: string | undefined;
  let token: string | undefined;
  let yes = false;
  let all = false;
  let force = false;
  let help = false;
  let version = false;
  const args: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (VALUE_FLAGS.has(current)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'usage-error', message: `Flag ${current} requires a value.` };
      }
      if (current === '--host') host = value;
      else token = value;
      i += 1;
      continue;
    }

    if (BOOLEAN_FLAGS.has(current)) {
      if (current === '--json') json = true;
      else if (current === '--yes') yes = true;
      else if (current === '--all') all = true;
      else if (current === '--force') force = true;
      else if (current === '--help') help = true;
      else version = true;
      continue;
    }

    if (current.startsWith('-')) {
      return { kind: 'usage-error', message: `Unknown flag: ${current}` };
    }

    args.push(current);
  }

  return {
    kind: 'command',
    args,
    flags: { json, host, token, yes, all, force, help, version },
  };
}
