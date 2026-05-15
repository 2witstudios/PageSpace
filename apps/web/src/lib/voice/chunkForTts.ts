/**
 * Voice mode TTS chunking utilities.
 *
 * Streaming assistant text arrives token-by-token with raw markdown. The TTS
 * pipeline needs to ship reasonably-sized, speakable chunks to OpenAI's TTS
 * API (4096 char hard limit) without splitting on every newline (which causes
 * audible gaps between line-by-line synthesis calls).
 */

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]]+)\]\([^)]+\)/g;
const HORIZONTAL_RULE = /^[ \t]*[-*_]{3,}[ \t]*$/gm;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|?\s*$/gm;
const BLOCKQUOTE = /^[ \t]*>\s?/gm;
const HEADING = /^[ \t]*#{1,6}[ \t]+/gm;
const LIST_BULLET = /^[ \t]*[-*+][ \t]+/gm;
const LIST_ORDERED = /^[ \t]*\d+[.)][ \t]+/gm;
const STRIKETHROUGH = /~~([^~\n]+?)~~/g;
const BOLD = /(\*\*|__)([^*_\n]+?)\1/g;
const ITALIC = /(?<![*_\w])([*_])([^*_\n]+?)\1(?![*_\w])/g;
const BARE_URL = /\bhttps?:\/\/\S+/g;

const SENTENCE_BOUNDARY = /(?<!\d)[.!?]+(?=\s|$)/g;
const PARAGRAPH_BREAK = /\n{2,}/g;
const HEADING_LINE = /^[ \t]*#{1,6}[ \t]+[^\n]*\n/gm;

const DEFAULT_MAX_CHARS = 1500;

export function normalizeForSpeech(text: string): string {
  let s = text;
  // Extract alt text from images rather than silencing them
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) =>
    alt.trim() ? ` ${alt.trim()} ` : ''
  );
  // Extract code body — strip fence delimiters and language tag, speak the content
  s = s.replace(FENCED_CODE, (m) => {
    const body = m.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    return body ? ` ${body} ` : ' ';
  });
  s = s.replace(LINK, '$1');
  // Tables: strip separator rows first, then extract cell text from content rows.
  // Append '. ' so consecutive rows don't merge into one run-on comma list.
  s = s.replace(TABLE_SEPARATOR, '');
  s = s.replace(/^\|(.+?)\|?\s*$/gm, (_, cells: string) =>
    cells.split('|').map((c: string) => c.trim()).filter(Boolean).join(', ') + '. '
  );
  s = s.replace(HORIZONTAL_RULE, '');
  s = s.replace(BLOCKQUOTE, '');
  s = s.replace(HEADING, '');
  s = s.replace(LIST_BULLET, '');
  s = s.replace(LIST_ORDERED, '');
  s = s.replace(/^[ \t]*\[[ xX]\][ \t]*/gm, ''); // task list checkboxes (line-start only)
  s = s.replace(STRIKETHROUGH, '$1');
  s = s.replace(BOLD, '$2');
  s = s.replace(ITALIC, '$2');
  s = s.replace(INLINE_CODE, '$1');
  s = s.replace(BARE_URL, '');
  s = s.replace(/\n{2,}/g, '. ');
  s = s.replace(/\n/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\s+([.!?,;:])/g, '$1');
  s = s.replace(/([.!?])[.!?]+/g, '$1');
  return s.trim();
}

export interface ChunkResult {
  ready: string[];
  pending: string;
}

export interface ChunkOptions {
  maxChars?: number;
}

/**
 * Find the index of the last "safe" cut point in a streaming raw buffer.
 * Returns the index *after* the last sentence terminator or paragraph break,
 * or -1 if the buffer has no complete sentence yet.
 *
 * Complete fenced code blocks are masked before searching so we don't find
 * false boundaries inside code. Any remaining opening ``` signals an
 * unclosed/streaming block — we stop searching before it to avoid slicing
 * a block mid-flight (which would leave orphaned fence markers in completeRaw).
 */
function findLastSafeBoundary(buffer: string): number {
  // Mask complete code blocks with same-length spaces to preserve indices
  const safeBuffer = buffer.replace(FENCED_CODE, (m) => ' '.repeat(m.length));

  // Any ``` remaining after masking is an unclosed streaming fence
  const unclosedFence = safeBuffer.indexOf('```');
  const searchEnd = unclosedFence >= 0 ? unclosedFence : safeBuffer.length;
  const searchable = safeBuffer.slice(0, searchEnd);

  let last = -1;
  for (const m of searchable.matchAll(SENTENCE_BOUNDARY)) {
    last = m.index + m[0].length;
  }
  for (const m of searchable.matchAll(PARAGRAPH_BREAK)) {
    const end = m.index + m[0].length;
    if (end > last) last = end;
  }
  // Treat a complete ATX heading line as a flush point so headings don't
  // accumulate in pending waiting for the section's first sentence.
  for (const m of searchable.matchAll(HEADING_LINE)) {
    const end = m.index + m[0].length;
    if (end > last) last = end;
  }

  // Fallback: if no boundary found and the searchable buffer is growing large,
  // cut at the last newline so unpunctuated list items don't accumulate silently.
  if (last === -1 && searchable.length > 200) {
    const nl = searchable.lastIndexOf('\n');
    if (nl > 0) last = nl + 1;
  }

  return last;
}

function packSentences(text: string, maxChars: number): string[] {
  const sentences: string[] = [];
  const re = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) sentences.push(s);
  }

  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      for (const sub of splitOversizedForTts(s, maxChars)) out.push(sub);
      continue;
    }
    if (!cur) {
      cur = s;
      continue;
    }
    if (cur.length + 1 + s.length <= maxChars) {
      cur += ' ' + s;
    } else {
      out.push(cur);
      cur = s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Process a streaming raw buffer of assistant text. Returns chunks that are
 * ready to be sent to TTS, plus the unfinished tail to keep buffered.
 *
 * The returned `pending` is RAW (unnormalized) so the caller can keep
 * appending new stream tokens to it before re-processing.
 */
export function chunkStreamingForTts(
  buffer: string,
  opts: ChunkOptions = {}
): ChunkResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  if (!buffer) return { ready: [], pending: '' };

  const cutPoint = findLastSafeBoundary(buffer);
  if (cutPoint <= 0) {
    return { ready: [], pending: buffer };
  }

  const completeRaw = buffer.slice(0, cutPoint);
  const pending = buffer.slice(cutPoint).replace(/^\s+/, '');

  const normalized = normalizeForSpeech(completeRaw);
  if (!normalized) return { ready: [], pending };

  const ready = packSentences(normalized, maxChars);
  return { ready, pending };
}

/**
 * Final-flush variant: normalize the whole buffer (including any unfinished
 * tail) and return all packed chunks. Use this when the AI stream has ended
 * and any remaining text must be spoken.
 */
export function flushForTts(
  buffer: string,
  opts: ChunkOptions = {}
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!buffer) return [];
  const normalized = normalizeForSpeech(buffer);
  if (!normalized) return [];
  return packSentences(normalized, maxChars);
}

/**
 * Split a single oversized chunk on word boundaries so each piece fits under
 * the TTS API's character limit. Used as a final safety net inside `speak()`.
 */
export function splitOversizedForTts(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    const piece = remaining.slice(0, cut).trim();
    if (piece) out.push(piece);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}
