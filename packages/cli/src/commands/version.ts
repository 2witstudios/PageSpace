import { SDK_VERSION } from '@pagespace/sdk';
import { EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';

/**
 * @pagespace/cli npm package version. Must equal package.json's `version` —
 * guarded by `commands/__tests__/version.test.ts`, which reads package.json
 * directly, so bumping one without the other fails the suite.
 */
export const CLI_VERSION = '1.7.0';

export const versionHandler: CommandHandler = async (ctx, intent) => {
  if (intent.flags.json) {
    ctx.stdout.write(JSON.stringify({ version: CLI_VERSION, sdkVersion: SDK_VERSION }));
  } else {
    ctx.stdout.write(`pagespace/${CLI_VERSION} (sdk ${SDK_VERSION})\n`);
  }
  return EXIT_SUCCESS;
};
