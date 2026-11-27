/**
 * Maps read_page's tool output to the AI SDK's tool-result content shape, and
 * degrades an image-bearing result back to metadata-only when needed.
 *
 * `ToolResultOutput`/`ToolModelOutputFn` are derived from `ai`'s own public `Tool`
 * type (already a direct dependency) rather than imported by name from
 * `@ai-sdk/provider-utils`, which only reaches this package transitively.
 */
import { isToolUIPart } from 'ai';
import type { Tool, UIMessage, FileUIPart } from 'ai';
import type { ModelCapabilities } from '../core/model-capabilities';

type ToolModelOutputFn = NonNullable<Tool['toModelOutput']>;
type ToolResultOutput = Awaited<ReturnType<ToolModelOutputFn>>;

/** What every delivered visual result carries besides its bytes. */
interface DeliveredVisualBase {
  success: true;
  pageId: string;
  title: string;
  /** The page's true upload format (page.mimeType), independent of which
   * bytes were actually delivered. Used when degrading to metadata-only so a
   * stale result reports the real file type. */
  originalMimeType: string;
  message: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

export interface VisualContentDeliveredOutput extends DeliveredVisualBase {
  type: 'visual_content_delivered';
  /** Media type of the delivered bytes (imageBase64) — the processor always
   * re-encodes ai-vision/ai-chat presets as jpeg, so this can differ from the
   * page's true upload format. */
  mimeType: string;
  imageBase64: string;
}

/**
 * One piece of a multi-part visual delivery: a native PDF (`file`) or an image
 * (`image`), such as one rasterized PDF page. `data` is base64.
 */
export interface DeliveredVisualPart {
  kind: 'image' | 'file';
  mediaType: string;
  data: string;
  filename?: string;
  /** The 1-based PDF page a rasterized image shows. */
  pdfPage?: number;
}

/**
 * read_page's result when it hands a file to the model as more than one part,
 * or as a non-image part: a whole PDF for a model that reads PDFs, or a run of
 * rasterized PDF pages for a model that only reads images.
 */
export interface VisualPartsDeliveredOutput extends DeliveredVisualBase {
  type: 'visual_parts_delivered';
  parts: DeliveredVisualPart[];
}

function isVisualPartsDelivered(output: unknown): output is VisualPartsDeliveredOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as Record<string, unknown>).type === 'visual_parts_delivered' &&
    Array.isArray((output as Record<string, unknown>).parts)
  );
}

function isPdfPart(part: DeliveredVisualPart): boolean {
  return part.kind === 'file';
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
 * visual_content_delivered results, and a PDF as a `file-data` part (which the
 * OpenRouter provider sends as a native `file`) or its pages as labelled images for
 * visual_parts_delivered results. Every other output shape passes through as JSON
 * unchanged (today's behavior for text/TASK_LIST/CHANNEL/error results).
 */
export function toModelOutputForReadPage(output: unknown): ToolResultOutput {
  if (isVisualPartsDelivered(output)) {
    const value: Array<Record<string, unknown>> = [{ type: 'text', text: output.message }];
    for (const part of output.parts) {
      if (isPdfPart(part)) {
        value.push({ type: 'file-data', data: part.data, mediaType: part.mediaType, ...(part.filename ? { filename: part.filename } : {}) });
        continue;
      }
      if (part.pdfPage !== undefined) value.push({ type: 'text', text: `Page ${part.pdfPage}:` });
      value.push({ type: 'image-data', data: part.data, mediaType: part.mediaType });
    }
    return { type: 'content', value } as unknown as ToolResultOutput;
  }
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
  if (!isVisualPartsDelivered(output) && !isVisualContentDelivered(output)) return output;
  return toMetadataEnvelope(output, { requiresVisionModel: true, imageOmitted: true });
}

/** A delivered result with its bytes stripped, as visual_content_metadata. */
function toMetadataEnvelope(output: DeliveredVisualBase, extraMetadata: Record<string, unknown>): Record<string, unknown> {
  const { pageId, title, originalMimeType, sizeBytes, metadata } = output;
  return buildVisualContentMetadata({
    pageId,
    title,
    mimeType: originalMimeType,
    sizeBytes,
    metadata: { ...metadata, ...extraMetadata },
  });
}

interface ToolWithModelOutput {
  toModelOutput?: ToolModelOutputFn;
}

/**
 * Drops native PDF parts from a delivered result for a model that reads images but
 * not PDFs. Page images stay. With nothing left, the result degrades to metadata
 * that tells the agent to read the file again for page images.
 */
export function dropPdfParts(output: unknown): unknown {
  if (!isVisualPartsDelivered(output) || !output.parts.some(isPdfPart)) return output;
  const parts = output.parts.filter((part) => !isPdfPart(part));
  if (parts.length > 0) return { ...output, parts };
  return toMetadataEnvelope(output, {
    pdfOmitted: true,
    hint: 'This model cannot read PDFs directly. Call read_page again with `pages` (for example "1-5") to see the pages as images.',
  });
}

/**
 * Wraps a tool so its toModelOutput never re-embeds bytes the current request's
 * model cannot take — guards against a STALE delivered tool-result (persisted from
 * an earlier turn on a different model) being re-sent when convertToModelMessages
 * re-converts history for this turn. No vision: every image and PDF degrades to
 * metadata. Vision but no PDF input: native PDF parts are dropped, page images stay.
 * Pass the same capabilities the turn's tool context gets, so the two agree.
 */
export function guardReadPageToolForVision<T extends ToolWithModelOutput>(
  tool: T,
  { hasVision, hasPdfInput }: Pick<ModelCapabilities, 'hasVision' | 'hasPdfInput'>,
): T {
  if (hasVision && hasPdfInput) return tool;
  const toModelOutput: ToolModelOutputFn = hasVision
    ? ({ output }) => toModelOutputForReadPage(dropPdfParts(output))
    : ({ output }) => toModelOutputForReadPage(degradeVisualContentToMetadata(output));
  return { ...tool, toModelOutput } as T;
}

/**
 * Strict base64: standard alphabet, length a multiple of 4, at most two `=` and
 * only at the end. The provider decodes the same string, so anything that
 * doesn't decode cleanly can't be hashed into what the model would see —
 * callers fail closed on it. A linear scan, not a regex: a whole PDF is ~13 MB
 * of base64, and the backtracking regex this replaces overflowed the stack on
 * anything over ~4 MB.
 */
function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  for (let i = 0; i < end; i++) {
    const c = value.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!ok) return false;
  }
  return true;
}

/**
 * The image and PDF bytes of every output-available `read_page` visual result in
 * `messages` (static or dynamic tool parts), as `data:` file parts for the
 * content blocklist screen. The
 * client-supplied `mimeType` is deliberately ignored — the hash depends only on
 * the bytes, and a crafted type (`image/png;charset=utf-8`) must not stop the
 * screen from decoding them. `undecodable` is true when any `imageBase64` is
 * not strict base64. Multi-part results (`visual_parts_delivered`) contribute every
 * part.
 */
export function visualToolResultScreenParts(
  messages: readonly UIMessage[],
): { parts: FileUIPart[]; undecodable: boolean } {
  const parts: FileUIPart[] = [];
  let undecodable = false;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      // Static (`tool-read_page`) and dynamic (`dynamic-tool`) parts alike, whatever
      // tool name they claim: any visual payload reaching the model is screened.
      if (!isToolUIPart(part) || part.state !== 'output-available') continue;
      const output: unknown = part.output;
      // A part whose data is not even a string cannot be checked: undecodable.
      const payloads: unknown[] = isVisualContentDelivered(output)
        ? [output.imageBase64]
        : isVisualPartsDelivered(output)
          ? output.parts.map((p) => (p as Partial<DeliveredVisualPart> | null)?.data)
          : [];
      for (const base64 of payloads) {
        if (base64 === '') continue;
        if (typeof base64 !== 'string' || !isStrictBase64(base64)) {
          undecodable = true;
          continue;
        }
        parts.push({ type: 'file', mediaType: 'application/octet-stream', url: `data:application/octet-stream;base64,${base64}` });
      }
    }
  }
  return { parts, undecodable };
}
