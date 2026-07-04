/**
 * `pagespace channels send <channelId> <message>` (Phase 5 task 5). Thin
 * projection over `channels.sendMessage` (Phase 3 task 9 defined it; this
 * task wires it onto the client facade — see `@pagespace/sdk`'s `client.ts`).
 * `<message>` is a single argv token, same convention `search text`'s query
 * follows — a multi-word message must be shell-quoted by the caller, never
 * silently rejoined here.
 */
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

export const channelsSendHandler: CommandHandler = async (ctx, intent) => {
  const [channelId, message, ...extra] = intent.args;
  if (!channelId || !message || extra.length > 0) {
    ctx.stderr.write('Usage: pagespace channels send <channelId> <message>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.channels.send({ pageId: channelId, content: message }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }

  ctx.stdout.write(`Sent message ${result.value.id} to ${channelId}.\n`);
  return EXIT_SUCCESS;
};
