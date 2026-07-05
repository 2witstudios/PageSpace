/**
 * Maps read_page's tool output to the AI SDK's tool-result content shape, and
 * degrades an image-bearing result back to metadata-only when needed.
 *
 * The `ToolResultOutput` shape below is written structurally (not imported from
 * `@ai-sdk/provider-utils`, which isn't a direct dependency of this package) so
 * TypeScript checks it against `tool()`'s inferred generic at the `toModelOutput`
 * call site in page-read-tools.ts.
 */

export interface VisualContentDeliveredOutput {
  success: true;
  type: 'visual_content_delivered';
  pageId: string;
  title: string;
  mimeType: string;
  message: string;
  imageBase64: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | {
      type: 'content';
      value: Array<
        | { type: 'text'; text: string }
        | { type: 'image-data'; data: string; mediaType: string }
      >;
    };

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
    };
  }
  return { type: 'json', value: output };
}

/**
 * Strips image bytes from a visual_content_delivered result, returning the same
 * visual_content_metadata shape read_page already produces when a model lacks vision.
 * Non-visual outputs pass through unchanged. Used to degrade STALE image tool-results
 * from an earlier, vision-capable turn when the active model no longer has vision.
 */
export function degradeVisualContentToMetadata(output: unknown): unknown {
  if (!isVisualContentDelivered(output)) return output;

  const { pageId, title, mimeType, sizeBytes, metadata } = output;
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
    metadata: { ...metadata, requiresVisionModel: true, imageOmitted: true },
  };
}
