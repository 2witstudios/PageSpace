import { EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';

/** Pure path+summary pair for one registered command — no handler reference, so this module stays a leaf (no dependency on the route table). */
export interface HelpCommandDescriptor {
  readonly path: readonly string[];
  readonly summary: string;
}

const GLOBAL_FLAG_LINES = [
  'Global flags:',
  '  --json          Emit machine-readable JSON on stdout only',
  '  --host <url>    Override the API host',
  '  --token <tok>   Override the credential',
  '  --yes           Assume yes to confirmation prompts',
  '  --all           Apply to every stored profile (logout)',
  '  --force         Proceed despite a non-fatal failure (logout)',
  '  --help          Show help',
  '  --version       Show the CLI version',
];

function commandLines(commands: readonly HelpCommandDescriptor[]): string[] {
  const entries = commands.map((c) => ({ name: c.path.join(' '), summary: c.summary }));
  const width = Math.max(...entries.map((e) => e.name.length));
  return entries.map((e) => `  ${e.name.padEnd(width)}  ${e.summary}`);
}

/**
 * Builds the `help` handler from the full command list (path + summary for
 * every registered route). Takes the list as a parameter, rather than
 * importing the route table itself, so this module never depends on
 * `router/routes.ts` — which itself depends on this module to build the
 * `help` route's own handler. `router/routes.ts` is the sole caller.
 */
export function createHelpHandler(commands: readonly HelpCommandDescriptor[]): CommandHandler {
  const lines = ['pagespace <command> [flags]', '', 'Commands:', ...commandLines(commands), '', ...GLOBAL_FLAG_LINES];

  return async (ctx, intent) => {
    if (intent.flags.json) {
      ctx.stdout.write(JSON.stringify({ usage: lines }));
    } else {
      ctx.stdout.write(`${lines.join('\n')}\n`);
    }
    return EXIT_SUCCESS;
  };
}
