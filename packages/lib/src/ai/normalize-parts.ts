/**
 * Canonical part normalization for the summarization pipeline.
 *
 * AI SDK v5 persists tool invocations as `type: 'tool-{name}'` UIMessage parts
 * with `input`/`output` fields and a `state` enum. The compaction/summarization
 * modules reason about `tool-call`/`tool-result` with `args`/`result` — the
 * canonical CompactionMessage format. This module bridges the two.
 *
 * IMPORTANT: apply ONLY before pure decision modules (summarize, estimate in the
 * compaction pipeline). The SDK-dialect parts MUST flow unchanged to
 * `convertToModelMessages`, which interprets `type.startsWith('tool-')` as tool
 * invocations and extracts the tool name via `type.slice(5)` — passing canonical
 * `tool-call`/`tool-result` types there would yield tool names "call"/"result".
 *
 * No `ai`-package dependency — structural types only.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizablePart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  /** SDK: tool arguments */
  input?: unknown;
  /** SDK: tool output */
  output?: unknown;
  /** canonical: tool arguments */
  args?: unknown;
  /** canonical: tool result */
  result?: unknown;
  /** SDK state machine */
  state?: string;
  /** SDK error output */
  errorText?: string;
  [key: string]: unknown;
}

export interface NormalizableMessage {
  role: string;
  parts?: NormalizablePart[];
  [key: string]: unknown;
}

// ─── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Convert SDK-dialect tool parts (`type: 'tool-{name}'`, `input`/`output`) to
 * canonical pairs (`type: 'tool-call'`/`'tool-result'`, `args`/`result`).
 *
 * Rules:
 * - `state: 'output-available'` → one `tool-call` + one `tool-result`
 * - `state: 'input-available'`  → one `tool-call` (result not yet available)
 * - `state: 'output-error'`     → one `tool-call` + one `tool-result` (errorText as result)
 * - `state: 'input-streaming'`  → dropped (incomplete; never reaches summarizer)
 * - Already-canonical parts     → pass through unchanged
 * - Non-tool parts              → pass through unchanged
 *
 * Pure: never mutates. Returns a new messages array.
 */
export function normalizeMessageParts<M extends NormalizableMessage>(messages: M[]): M[] {
  let anyChanged = false;
  const result = messages.map((msg): M => {
    if (!msg.parts || msg.parts.length === 0) return msg;

    const normalizedParts: NormalizablePart[] = [];
    let changed = false;

    for (const part of msg.parts) {
      // Already canonical or non-tool — pass through
      if (
        part.type === 'tool-call' ||
        part.type === 'tool-result' ||
        part.type === 'text' ||
        part.type === 'file' ||
        part.type === 'step-start' ||
        part.type === 'dynamic-tool' ||
        !part.type.startsWith('tool-')
      ) {
        normalizedParts.push(part);
        continue;
      }

      // SDK dialect: type is 'tool-{name}'
      const toolName = part.toolName ?? part.type.slice(5);
      const { state } = part;

      if (state === 'input-streaming') {
        // Drop incomplete — never reaches summarizer in a completed transcript
        changed = true;
        continue;
      }

      if (state === 'input-available') {
        normalizedParts.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName,
          args: part.input,
        });
        changed = true;
      } else if (state === 'output-available') {
        normalizedParts.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName,
          args: part.input,
        });
        normalizedParts.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName,
          result: part.output,
        });
        changed = true;
      } else if (state === 'output-error') {
        normalizedParts.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName,
          args: part.input,
        });
        normalizedParts.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName,
          result: part.errorText ?? '[error]',
        });
        changed = true;
      } else {
        // Unknown state — pass through unchanged
        normalizedParts.push(part);
      }
    }

    if (!changed) return msg;
    anyChanged = true;
    return { ...msg, parts: normalizedParts };
  });
  return anyChanged ? result : messages;
}
