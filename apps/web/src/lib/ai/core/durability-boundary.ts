import type { UIMessageChunk } from 'ai';

/**
 * The tool-family chunk types that are durability boundaries — every one except
 * `tool-input-delta`. See `isDurabilityBoundary` for why this is enumerated rather than
 * prefix-matched.
 */
const TOOL_BOUNDARY_CHUNK_TYPES: ReadonlySet<string> = new Set([
  'tool-input-start',
  'tool-input-available',
  'tool-input-error',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
  'tool-approval-request',
]);

/**
 * A frame worth making durable IMMEDIATELY rather than waiting out a throttle.
 *
 * ONE definition, deliberately, and this module exists only so it stays that way. It was a
 * closure inside `createStreamLifecycle`, which was fine while the parts checkpoint was the
 * only thing that had to answer this question. The durable frame log asks the identical
 * question — a rejoining client should see a tool call start or finish without waiting on a
 * batching window — and a second copy of the answer is exactly how the two would drift.
 *
 * A rejoining client should see a tool call start or finish, a route-written data part, or
 * an error as soon as it happens — those are the frames that change what the UI shows,
 * whereas a text delta is one of thousands. This is the successor to the `isToolPart(part)`
 * bypass, restated over chunk types now that both consumers read frames.
 *
 * Deliberately an explicit allow-list rather than "anything that is not a text delta":
 * reasoning streams token-by-token exactly like text, so a negative check would bypass the
 * throttle on every reasoning frame of a long chain-of-thought and turn both the checkpoint
 * and the frame log back into a per-token write.
 *
 * WHICH IS WHY THE TOOL FAMILY IS ENUMERATED AND NOT PREFIX-MATCHED. `tool-input-delta`
 * carries the model's tool ARGUMENTS token by token — the same shape as a text or reasoning
 * delta, and just as numerous for a tool call with a large input. A `startsWith('tool-')`
 * check therefore made every one of those frames a boundary, which is the exact per-token
 * write the paragraph above rejects: `persistInFlight` serializes the checkpoint's writes but
 * does not throttle them, so it would rewrite the whole parts array back-to-back for the
 * length of the argument stream (review finding — coderabbitai, PR #2408). The frame log
 * would answer the same mistake by emitting a one-frame row per argument token.
 *
 * `data-` stays a prefix: those types are open-ended by construction (`data-${string}`), so
 * there is no set to enumerate, and they are route-written and discrete rather than
 * streamed per token.
 */
export const isDurabilityBoundary = (chunk: UIMessageChunk): boolean =>
  TOOL_BOUNDARY_CHUNK_TYPES.has(chunk.type) ||
  chunk.type.startsWith('data-') ||
  chunk.type === 'start-step' ||
  chunk.type === 'finish-step' ||
  chunk.type === 'error' ||
  chunk.type === 'file' ||
  chunk.type === 'source-url' ||
  chunk.type === 'source-document';
