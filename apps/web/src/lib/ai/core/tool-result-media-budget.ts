/**
 * A budget for the images and files tool results carry across a whole
 * conversation, not just one result.
 *
 * read_page caps each result (12 MB), but a result is re-sent on every later
 * step and turn. Paging through a 50-page scan five pages at a time leaves ~58 MB
 * of base64 in history (~210k visual tokens on Claude), which overflows a 200k
 * window and is expensive on a 1M one. So only the newest few media-bearing
 * results keep their media, within a total budget; older ones keep their text
 * (read_page's "Page N:" labels included) and a note to call the tool again.
 *
 * Runs inside capStepToolPayloads, which every agent loop applies before every
 * step (page, global, v1, consult, ask_agent, workflows), so saved history and
 * the current run are bounded by the same rule. Forward-only like the other
 * caps there: the window only moves toward newer results, so a result that
 * loses its media keeps losing it and earlier bytes stay cache-stable.
 */
import type { ModelMessage, ToolResultPart } from 'ai';

/** How many of the newest media-bearing tool results keep their media. */
export const KEEP_RECENT_MEDIA_RESULTS = 3;

/**
 * Most base64 media characters kept across those results (~12 MB of bytes, one
 * read_page result at its cap). The newest result is always kept whole.
 */
export const MAX_HISTORY_MEDIA_CHARS = 16 * 1024 * 1024;

const OMITTED_NOTE =
  '[The images and files in this earlier tool result were removed to keep the conversation within its size budget. ' +
  'Call the tool again (for read_page, with the same pages) to see them again.]';

type ContentOutput = Extract<ToolResultPart['output'], { type: 'content' }>;
type ContentItem = ContentOutput['value'][number];

const isMediaItem = (item: ContentItem): boolean =>
  item.type === 'image-data' || item.type === 'file-data' || item.type === 'image-url' || item.type === 'file-url';

const mediaChars = (item: ContentItem): number =>
  'data' in item && typeof item.data === 'string' ? item.data.length : 0;

function isToolResult(part: unknown): part is ToolResultPart {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'tool-result';
}

interface MediaResult {
  messageIdx: number;
  partIdx: number;
  chars: number;
}

export function budgetToolResultMedia(
  messages: ModelMessage[],
  { keepRecent = KEEP_RECENT_MEDIA_RESULTS, maxChars = MAX_HISTORY_MEDIA_CHARS } = {},
): ModelMessage[] {
  const found: MediaResult[] = [];
  messages.forEach((message, messageIdx) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIdx) => {
      if (!isToolResult(part) || part.output.type !== 'content') return;
      const media = part.output.value.filter(isMediaItem);
      if (media.length === 0) return;
      found.push({ messageIdx, partIdx, chars: media.reduce((sum, item) => sum + mediaChars(item), 0) });
    });
  });

  // Newest first: keep while under both limits; the newest is always kept.
  const dropped = new Set<string>();
  let kept = 0;
  let keptChars = 0;
  for (const result of [...found].reverse()) {
    const fits = kept === 0 || (kept < keepRecent && keptChars + result.chars <= maxChars);
    if (fits) {
      kept++;
      keptChars += result.chars;
    } else {
      dropped.add(`${result.messageIdx}:${result.partIdx}`);
    }
  }
  if (dropped.size === 0) return messages;

  return messages.map((message, messageIdx) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part, partIdx) => {
      if (!dropped.has(`${messageIdx}:${partIdx}`) || !isToolResult(part) || part.output.type !== 'content') return part;
      changed = true;
      const text = part.output.value.filter((item) => !isMediaItem(item));
      return { ...part, output: { type: 'content', value: [...text, { type: 'text', text: OMITTED_NOTE }] } as ContentOutput };
    });
    return changed ? { ...message, content } : message;
  });
}
