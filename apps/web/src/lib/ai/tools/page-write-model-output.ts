/**
 * `ToolResultOutput` is derived from `ai`'s own public `Tool` type rather than
 * imported by name from `@ai-sdk/provider-utils`, which only reaches this
 * package transitively — same reasoning as `read-page-vision-output.ts`.
 */
import type { Tool } from 'ai';

type ToolModelOutputFn = NonNullable<Tool['toModelOutput']>;
type ToolResultOutput = Awaited<ReturnType<ToolModelOutputFn>>;

/**
 * Keys carrying the full BEFORE/AFTER document text. Present in the persisted
 * result (RichDiffRenderer needs them to draw the diff a human reviews) and
 * stripped before the result reaches the model.
 */
const CONTENT_KEYS = ['oldContent', 'newContent'] as const;

/**
 * Strip `oldContent`/`newContent` out of a `replace_lines` / `insert_content`
 * result before the model sees it.
 *
 * Without this the model reads back the entire document it just edited on
 * every call — bytes it already has, which is also what routinely pushes
 * these results past the per-step elision cap (`cap-step-tool-payloads.ts`).
 * The counts and identity fields that remain (`newLineCount`, `linesReplaced`,
 * `pageId`, …) are everything an agent needs to decide what to do next.
 *
 * Mirrors `toModelOutputForCopyContent`.
 */
export function toModelOutputForPageWrite(output: unknown): ToolResultOutput {
  if (output === null || typeof output !== 'object') {
    return { type: 'json', value: output } as unknown as ToolResultOutput;
  }

  const lean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if ((CONTENT_KEYS as readonly string[]).includes(key)) continue;
    lean[key] = value;
  }

  return { type: 'json', value: lean } as unknown as ToolResultOutput;
}
