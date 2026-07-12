/**
 * Encoding a picker prompt for a PTY — pure, so the rules below are testable
 * without a socket.
 *
 * The realtime bridge (`agent-terminal-handler.ts`, `onInput`) writes a payload
 * only when `data.length <= MAX_INPUT_BYTES` and **silently drops the whole
 * write otherwise** — a 5KB pasted spec would vanish with no error anywhere.
 * So a prompt is split into chunks that each fit, rather than sent as one write.
 */

/** Mirrors `MAX_INPUT_BYTES` in `apps/realtime/src/terminal/agent-terminal-handler.ts`. */
export const PTY_MAX_INPUT_BYTES = 4096;

/** Carriage return: what a tty sees when a human presses Enter. */
const SUBMIT = '\r';

/**
 * The chunks to write into the PTY for a starting prompt, submit included.
 *
 * Newlines are collapsed to spaces. A newline in a tty IS a submit, so a
 * two-line prompt written verbatim would reach the agent as two separate
 * turns — and with `agentType: 'shell'`, as two separate commands. The picker's
 * textarea takes Shift+Enter newlines because prompts get pasted, but what the
 * agent receives is one prompt, submitted once.
 *
 * Chunks are measured in UTF-8 BYTES (the limit the bridge enforces) and split
 * on code-point boundaries, so an emoji or accented character is never cut in
 * half into two invalid writes.
 */
export function toPtyInput(prompt: string, maxBytes: number = PTY_MAX_INPUT_BYTES): string[] {
  const line = prompt.replace(/[\r\n]+/g, ' ').trim();
  if (!line) return [];

  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  // Iterating the string yields code points, not UTF-16 units — a surrogate pair
  // stays whole.
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (chunkBytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += size;
  }
  if (chunk) chunks.push(chunk);

  chunks.push(SUBMIT);
  return chunks;
}
