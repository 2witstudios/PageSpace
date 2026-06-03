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
}

/**
 * Pipes an AI result's UI message stream to a writer, stripping the inner
 * messageId from 'start' chunks so the outer createUIMessageStream's
 * generateId/idInjectedStream remains the authoritative source for message ID.
 *
 * Write errors are swallowed so server-side processing (onFinish, DB save)
 * continues even when the client disconnects mid-stream.
 *
 * With no options the behavior is unchanged (forward a bare `start`, forward
 * everything else). The retry shell passes suppress* flags so it can run several
 * attempts under a single message envelope without emitting duplicate start/finish
 * chunks or leaking a per-attempt error that is about to be retried.
 */
export async function pipeUIMessageStreamStrippingStart(
  aiResult: { toUIMessageStream(): AsyncIterable<UIMessageChunk> },
  writer: UIMessageStreamWriter,
  options: PipeOptions = {},
): Promise<void> {
  for await (const chunk of aiResult.toUIMessageStream()) {
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
