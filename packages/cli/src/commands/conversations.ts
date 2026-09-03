/**
 * `pagespace conversations list|read` — thin projections over the
 * `conversations.list` / `conversations.read` SDK operations. Both operations
 * already existed and were already served over MCP (`mcp/serve.ts` imports
 * `listConversations`/`readConversation`); only the CLI had no verb for them,
 * which is what made `agents ask`'s own timeout advice — "check the agent's
 * conversation history before asking again" — impossible to act on from the
 * CLI. This module adds no SDK surface: the registry stays the single source
 * of truth for all three facades.
 *
 * WHY THESE TWO VERBS ARE THE TIMEOUT RECOVERY PATH. `agents.ask` is a
 * non-idempotent POST that is never auto-retried, and the consult route runs
 * to completion regardless of whether its caller is still listening — it does
 * not read `request.signal`. So a client-side timeout means the answer is
 * still being written, not that it was lost: the route eagerly creates the
 * `conversations` row before generating, and persists the assistant message
 * when generation finishes. `conversations list` finds that row and
 * `conversations read` returns the answer. Without these, a caller who timed
 * out had paid for a result with no way to reach it.
 *
 * Message rendering follows the canonical `parts` array (project law — see
 * `packages/lib/src/types.ts`), never an assumed flat `content` string: a
 * consult answer arrives as text parts, but a conversation that ran tools
 * also carries `tool-*` parts, and dropping them silently would misrepresent
 * what the agent actually did. Every CONTENT-bearing part therefore renders,
 * as a labelled placeholder when it has no text of its own — including part
 * types this CLI has never heard of, since the `parts` union grows server-side
 * and a renderer that silently drops what it does not recognize gets quieter
 * over time without anyone noticing. `step-start` is the one deliberate
 * exception: it is a structural marker with no content, and labelling it would
 * add noise to every transcript rather than information.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type ConversationsListResult = Awaited<ReturnType<PageSpaceClient['conversations']['list']>>;
type ConversationsReadResult = Awaited<ReturnType<PageSpaceClient['conversations']['read']>>;
type ConversationMessage = ConversationsReadResult['messages'][number];

/** Pure: no I/O. */
export function renderConversationsList(value: ConversationsListResult): string {
  if (value.conversations.length === 0) return 'No conversations.\n';
  const lines = value.conversations.map(
    (entry) => `${entry.id}  ${entry.updatedAt}  ${entry.messageCount} msg  ${entry.title}`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Pure: no I/O. Flattens one message's `parts` into displayable text.
 *
 * A part with no text is NOT dropped — a tool call renders as `[tool: name]`
 * so a transcript that is entirely tool activity does not render as an empty
 * message, which would read as "the agent said nothing" when in fact it did
 * a great deal.
 */
export function renderMessageParts(message: ConversationMessage): string {
  const rendered = message.parts
    .map((part) => {
      if (typeof part.text === 'string' && part.text.length > 0) return part.text;
      if (part.type.startsWith('tool-')) return `[tool: ${part.toolName ?? part.type.slice('tool-'.length)}]`;
      if (part.type === 'file') return `[file: ${part.filename ?? part.mediaType ?? 'attachment'}]`;
      // Structural only — no content to show, so showing a label is noise.
      if (part.type === 'step-start') return '';
      // Anything else IS content, including a `data-*` part or a type added
      // after this was written. Named rather than dropped: a message made only
      // of unrecognized parts must not render as though the agent said nothing.
      return `[${part.type}]`;
    })
    .filter((chunk) => chunk.length > 0);
  return rendered.join('\n');
}

/** Pure: no I/O. */
export function renderConversation(value: ConversationsReadResult): string {
  if (value.messages.length === 0) return 'No messages.\n';
  const blocks = value.messages.map((message) => {
    const body = renderMessageParts(message);
    return `${message.role} (${message.createdAt}):\n${body}`;
  });
  return `${blocks.join('\n\n')}\n`;
}

export const conversationsListHandler: CommandHandler = async (ctx, intent) => {
  const [agentId, ...extra] = intent.args;
  if (!agentId || extra.length > 0) {
    ctx.stderr.write('Usage: pagespace conversations list <agentPageId> [--json]\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.conversations.list({ agentId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }
  ctx.stdout.write(renderConversationsList(result.value));
  return EXIT_SUCCESS;
};

export const conversationsReadHandler: CommandHandler = async (ctx, intent) => {
  const [agentId, conversationId, ...extra] = intent.args;
  if (!agentId || !conversationId || extra.length > 0) {
    ctx.stderr.write('Usage: pagespace conversations read <agentPageId> <conversationId> [--json]\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.conversations.read({ agentId, conversationId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }
  ctx.stdout.write(renderConversation(result.value));
  return EXIT_SUCCESS;
};
