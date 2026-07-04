import { EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';

const USAGE_LINES = [
  'pagespace <command> [flags]',
  '',
  'Commands:',
  '  help      Show this help message',
  '  login     Log in via the browser (loopback + PKCE)',
  '  logout    Revoke and remove a stored credential',
  '  whoami    Show the currently authenticated identity',
  '',
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

export const helpHandler: CommandHandler = async (ctx, intent) => {
  if (intent.flags.json) {
    ctx.stdout.write(JSON.stringify({ usage: USAGE_LINES }));
  } else {
    ctx.stdout.write(`${USAGE_LINES.join('\n')}\n`);
  }
  return EXIT_SUCCESS;
};
