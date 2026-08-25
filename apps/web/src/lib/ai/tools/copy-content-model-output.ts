/**
 * `ToolResultOutput` is derived from `ai`'s own public `Tool` type rather than
 * imported by name from `@ai-sdk/provider-utils`, which only reaches this
 * package transitively — same reasoning as `read-page-vision-output.ts`.
 */
import type { Tool } from 'ai';

type ToolModelOutputFn = NonNullable<Tool['toModelOutput']>;
type ToolResultOutput = Awaited<ReturnType<ToolModelOutputFn>>;

/**
 * Keys carrying copied BYTES. Present in the persisted result (the diff
 * renderer needs them) and stripped before the result reaches the model.
 */
const BYTE_CARRYING_KEYS = ['oldContent', 'newContent', 'copiedContent'] as const;

/**
 * Strip the copied bytes out of a `copy_content` result before the model sees it.
 *
 * Without this the tool is a PESSIMIZATION, not an optimization. Its whole
 * reason to exist is that the model never spends output tokens on content it
 * already has; echoing that content back as tool output just moves the same
 * bytes to the input side of the ledger, and a large copy would be clipped by
 * the per-step result cap on its way through anyway.
 *
 * The bytes still ride on the PERSISTED result, because RichDiffRenderer needs
 * `oldContent`/`newContent` to draw the diff a human reviews. Only the
 * model-facing projection is reduced — to counts and identity, which is all an
 * agent needs to decide what to do next.
 *
 * Mirrors `toModelOutputForReadPage`; kept in its own module with its own test
 * so the invariant is pinned by a test rather than by a comment someone can
 * delete.
 */
export function toModelOutputForCopyContent(output: unknown): ToolResultOutput {
  if (output === null || typeof output !== 'object') {
    return { type: 'json', value: output } as unknown as ToolResultOutput;
  }

  const lean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if ((BYTE_CARRYING_KEYS as readonly string[]).includes(key)) continue;
    lean[key] = value;
  }

  return { type: 'json', value: lean } as unknown as ToolResultOutput;
}
