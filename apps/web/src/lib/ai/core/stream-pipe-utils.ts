import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';

export interface PipeOptions {
  /** Drop the inner `start` envelope chunk (the caller owns the outer envelope). */
  suppressStart?: boolean;
  /** Drop the inner `finish` envelope chunk (the caller emits one finish at the very end). */
  suppressFinish?: boolean;
  /**
   * Drop inner `error` chunks. The retry shell owns error surfacing — a per-attempt
   * provider error must NOT reach the client mid-stream when we still intend to retry.
   */
  suppressError?: boolean;
  /**
   * Invoked the first time a non-framing CONTENT chunk is forwarded. Fires even if the
   * stream later throws, so the retry shell can refuse a from-scratch retry once content
   * is already on the wire (the append-only stream cannot retract it).
   */
  onContent?: () => void;
}

// Envelope/framing chunk types that carry no assistant content. Everything else
// (text-*, tool-*, reasoning-*, file, source-*, data-*) is "content" — once any of it
// reaches the client it cannot be retracted, so the retry shell must not re-stream it.
const FRAMING_CHUNK_TYPES = new Set<string>([
  'start',
  'finish',
  'start-step',
  'finish-step',
  'error',
  'message-metadata',
  'abort',
]);

/**
 * Pipes an AI result's UI message stream to a writer. The inner `start` chunk is
 * replaced with a bare `{ type: 'start' }` (its payload, incl. messageId, dropped) so
 * the outer createUIMessageStream's generateId/idInjectedStream stays the authoritative
 * source for the message ID.
 *
 * Write errors are swallowed so server-side processing (onFinish, DB save)
 * continues even when the client disconnects mid-stream.
 *
 * With no options the behavior is unchanged (forward a bare `start`, forward
 * everything else). The retry shell passes suppress* flags so it can run several
 * attempts under a single message envelope without emitting duplicate start/finish
 * chunks or leaking a per-attempt error that is about to be retried.
 *
 * Reports the first content chunk via `options.onContent` — the retry shell uses this to
 * refuse a from-scratch retry once content is already on the wire (which would otherwise
 * duplicate it, since the UI message stream is append-only). The callback fires even if
 * the stream subsequently throws.
 */
export async function pipeUIMessageStreamStrippingStart(
  aiResult: { toUIMessageStream(): AsyncIterable<UIMessageChunk> },
  writer: UIMessageStreamWriter,
  options: PipeOptions = {},
): Promise<void> {
  let contentReported = false;
  for await (const chunk of aiResult.toUIMessageStream()) {
    if (!contentReported && !FRAMING_CHUNK_TYPES.has(chunk.type)) {
      contentReported = true;
      options.onContent?.();
    }
    try {
      if (chunk.type === 'start') {
        if (!options.suppressStart) writer.write({ type: 'start' });
        continue;
      }
      if (chunk.type === 'finish' && options.suppressFinish) continue;
      if (chunk.type === 'error' && options.suppressError) continue;
      writer.write(chunk);
    } catch {
      // Client disconnected - continue processing to ensure onFinish fires
    }
  }
}
