import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';

/**
 * Pipes an AI result's UI message stream to a writer, stripping the inner
 * messageId from 'start' chunks so the outer createUIMessageStream's
 * generateId/idInjectedStream remains the authoritative source for message ID.
 *
 * Write errors are swallowed so server-side processing (onFinish, DB save)
 * continues even when the client disconnects mid-stream.
 */
export async function pipeUIMessageStreamStrippingStart(
  aiResult: { toUIMessageStream(): AsyncIterable<UIMessageChunk> },
  writer: UIMessageStreamWriter,
): Promise<void> {
  for await (const chunk of aiResult.toUIMessageStream()) {
    try {
      if (chunk.type === 'start') {
        writer.write({ type: 'start' });
        continue;
      }
      writer.write(chunk);
    } catch {
      // Client disconnected - continue processing to ensure onFinish fires
    }
  }
}
