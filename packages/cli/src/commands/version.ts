import { SDK_VERSION } from '@pagespace/sdk';
import { EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';

/** @pagespace/cli npm package version — keep in sync with package.json. */
export const CLI_VERSION = '0.1.0';

export const versionHandler: CommandHandler = async (ctx, intent) => {
  if (intent.flags.json) {
    ctx.stdout.write(JSON.stringify({ version: CLI_VERSION, sdkVersion: SDK_VERSION }));
  } else {
    ctx.stdout.write(`pagespace/${CLI_VERSION} (sdk ${SDK_VERSION})\n`);
  }
  return EXIT_SUCCESS;
};
