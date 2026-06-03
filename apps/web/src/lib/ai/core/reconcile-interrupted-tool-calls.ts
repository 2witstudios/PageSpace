import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';

/**
 * Reconcile a model-message list before re-feeding it to a retry attempt.
 *
 * When a stream drops mid-loop, the last assistant turn can contain a tool-call
 * whose result never came back ("dangling"). Two problems follow if we re-feed
 * as-is or strip the call:
 *   - Re-feeding as-is errors: the provider rejects an assistant tool-call with
 *     no matching tool-result.
 *   - Stripping the call makes the next attempt RE-RUN that tool, which
 *     DUPLICATES side effects for mutating tools (e.g. `create_page` twice).
 *
 * Instead, for every tool-call with no matching result we inject a synthetic
 * `interrupted` tool-result so the model is told the call's outcome is unknown
 * and decides whether to repeat it (idempotent/read-only tools are safe to
 * repeat; mutating tools should be verified first). Completed tool-results are
 * preserved untouched.
 *
 * Pure — no IO, returns a new array.
 */
export function reconcileInterruptedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  // 1. Collect every tool-call id that already has a result anywhere in the list
  //    (tool messages, plus provider-executed inline results on assistant turns).
  const resolved = new Set<string>();
  for (const message of messages) {
    const content = message.content;
    if (typeof content === 'string') continue;
    for (const part of content) {
      if (part.type === 'tool-result') {
        resolved.add(part.toolCallId);
      }
    }
  }

  // 2. Walk the list; after any assistant message with unresolved tool-calls,
  //    inject a synthetic tool message resolving them.
  const injected = new Set<string>();
  const out: ModelMessage[] = [];

  for (const message of messages) {
    out.push(message);
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;

    const interrupted: ToolResultPart[] = [];
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;
      if (resolved.has(part.toolCallId) || injected.has(part.toolCallId)) continue;
      injected.add(part.toolCallId);
      interrupted.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: {
          type: 'json',
          value: {
            interrupted: true,
            note: 'The previous response stream was interrupted before this tool returned. Its outcome is unknown — verify current state before repeating any mutating action.',
          },
        },
      });
    }

    if (interrupted.length > 0) {
      const toolMessage: ToolModelMessage = { role: 'tool', content: interrupted };
      out.push(toolMessage);
    }
  }

  return out;
}
