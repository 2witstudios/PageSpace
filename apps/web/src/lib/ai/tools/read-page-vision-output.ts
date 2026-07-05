/**
 * Maps read_page's tool output to the AI SDK's tool-result content shape, and
 * degrades an image-bearing result back to metadata-only when needed.
 *
 * `ToolResultOutput`/`ToolModelOutputFn` are derived from `ai`'s own public `Tool`
 * type (already a direct dependency) rather than imported by name from
 * `@ai-sdk/provider-utils`, which only reaches this package transitively.
 */
import type { Tool } from 'ai';

type ToolModelOutputFn = NonNullable<Tool['toModelOutput']>;
type ToolResultOutput = Awaited<ReturnType<ToolModelOutputFn>>;

export interface VisualContentDeliveredOutput {
  success: true;
  type: 'visual_content_delivered';
  pageId: string;
  title: string;
  /** Media type of the delivered bytes (imageBase64) — the processor always
   * re-encodes ai-vision/ai-chat presets as jpeg, so this can differ from the
   * page's true upload format. */
  mimeType: string;
  /** The page's true upload format (page.mimeType), independent of which
   * preset's bytes were actually delivered. Used when degrading to
   * metadata-only so a stale result reports the real file type. */
  originalMimeType: string;
  message: string;
  imageBase64: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

function isVisualContentDelivered(output: unknown): output is VisualContentDeliveredOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as Record<string, unknown>).type === 'visual_content_delivered' &&
    typeof (output as Record<string, unknown>).imageBase64 === 'string'
  );
}

/**
 * read_page's toModelOutput: delivers image bytes as a real image content part for
 * visual_content_delivered results; every other output shape passes through as JSON
 * unchanged (today's behavior for text/TASK_LIST/CHANNEL/error results).
 */
export function toModelOutputForReadPage(output: unknown): ToolResultOutput {
  if (isVisualContentDelivered(output)) {
    return {
      type: 'content',
      value: [
        { type: 'text', text: output.message },
        { type: 'image-data', data: output.imageBase64, mediaType: output.mimeType },
      ],
    } as unknown as ToolResultOutput;
  }
  // output is an arbitrary, already-JSON-serializable tool result at runtime;
  // ToolResultOutput's json variant requires a JSONValue, which can't be proven
  // statically from `unknown` here.
  return { type: 'json', value: output } as unknown as ToolResultOutput;
}

/**
 * Builds the "visual_content_metadata" envelope read_page returns whenever it can't
 * (or won't) deliver image bytes — no vision-capable preset available, or a stale
 * delivered result degraded back down. Shared so the two call sites (page-read-tools.ts's
 * own no-preset-available fallback, and degradeVisualContentToMetadata below) can't drift.
 */
export function buildVisualContentMetadata(params: {
  pageId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  const { pageId, title, mimeType, sizeBytes, metadata } = params;
  return {
    success: true,
    type: 'visual_content_metadata',
    pageId,
    title,
    message: `Found visual content: "${title}" (${mimeType})`,
    mimeType,
    sizeBytes,
    summary: 'This is a visual file that requires vision capabilities to process',
    stats: {
      documentType: 'VISUAL',
      mimeType,
      sizeBytes,
      sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    },
    metadata,
  };
}

/**
 * Strips image bytes from a visual_content_delivered result, returning the same
 * visual_content_metadata shape read_page already produces when a model lacks vision.
 * Non-visual outputs pass through unchanged. Used to degrade STALE image tool-results
 * from an earlier, vision-capable turn when the active model no longer has vision.
 */
export function degradeVisualContentToMetadata(output: unknown): unknown {
  if (!isVisualContentDelivered(output)) return output;

  const { pageId, title, originalMimeType, sizeBytes, metadata } = output;
  return buildVisualContentMetadata({
    pageId,
    title,
    mimeType: originalMimeType,
    sizeBytes,
    metadata: { ...metadata, requiresVisionModel: true, imageOmitted: true },
  });
}

interface ToolWithModelOutput {
  toModelOutput?: ToolModelOutputFn;
}

/**
 * Wraps a tool so its toModelOutput never re-embeds image bytes when the current
 * request's model lacks vision — guards against a STALE visual_content_delivered
 * tool-result (persisted from an earlier turn where the model did have vision) being
 * re-sent as an image when convertToModelMessages re-converts history for this turn.
 */
export function guardReadPageToolForVision<T extends ToolWithModelOutput>(tool: T, hasVision: boolean): T {
  if (hasVision) return tool;
  const toModelOutput: ToolModelOutputFn = ({ output }) =>
    toModelOutputForReadPage(degradeVisualContentToMetadata(output));
  return { ...tool, toModelOutput } as T;
}
