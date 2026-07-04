/**
 * Local `--drive <id>` extraction for `pages`/`trash` verbs. `--drive` is
 * NOT a global flag (`tokens create`'s pre-existing, merged `--drive`/`--role`
 * pairs are repeatable and command-specific, parsed the same way from
 * `CommandIntent.args` — see `tokens/args.ts`) — `parseArgv` only extracts
 * `--json`/`--yes`/`--host`/`--token`/etc. and passes everything else
 * through into `args` verbatim once a command path has started. Each
 * resource command owning a `--drive` flag interprets it itself, the same
 * way `tokens create` interprets its own `--name`/`--role`.
 */
export type ExtractDriveFlagResult =
  | { readonly ok: true; readonly driveId: string | undefined; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

export function extractDriveFlag(args: readonly string[]): ExtractDriveFlagResult {
  const rest: string[] = [];
  let driveId: string | undefined;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--drive') {
      const value = args[i + 1];
      if (value === undefined) {
        return { ok: false, message: 'Flag --drive requires a value.' };
      }
      driveId = value;
      i += 2;
      continue;
    }
    rest.push(args[i]);
    i += 1;
  }
  return { ok: true, driveId, rest };
}
