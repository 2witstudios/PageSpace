export async function consumeStreamJoin(
  messageId: string,
  signal: AbortSignal,
  onChunk: (text: string) => void,
): Promise<{ aborted: boolean }> {
  let response: Response;
  try {
    response = await fetch(`/api/ai/chat/stream-join/${messageId}`, {
      credentials: 'include',
      signal,
    });
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return { aborted: true };
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(`Stream join failed with status ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal.aborted) {
        return { aborted: true };
      }

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (readErr) {
        if (signal.aborted) return { aborted: true };
        throw readErr;
      }

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice('data: '.length);
        try {
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          if (parsed.done) {
            return { aborted: (parsed.aborted as boolean | undefined) ?? false };
          }
          if (typeof parsed.text === 'string') {
            onChunk(parsed.text);
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { aborted: false };
}
