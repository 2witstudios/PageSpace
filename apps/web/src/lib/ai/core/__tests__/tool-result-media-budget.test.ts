import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  budgetToolResultMedia,
  KEEP_RECENT_MEDIA_RESULTS,
  MAX_HISTORY_MEDIA_CHARS,
} from '../tool-result-media-budget';
import { capStepToolPayloads } from '../cap-step-tool-payloads';

/** ~876 KB JPEG per page, as base64 (the size a 300 dpi scan page renders to). */
const PAGE = 'A'.repeat(1_168_000);

/** One read_page call + its 5-page image result, as the AI SDK records them. */
function readPageStep(id: number, pages = 5): ModelMessage[] {
  const first = (id - 1) * pages + 1;
  const value: Array<Record<string, unknown>> = [{ type: 'text', text: `Showing pages ${first}-${first + pages - 1} of 50.` }];
  for (let p = first; p < first + pages; p++) {
    value.push({ type: 'text', text: `Page ${p}:` }, { type: 'image-data', data: PAGE, mediaType: 'image/jpeg' });
  }
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${id}`, toolName: 'read_page', input: { pages: `${first}-${first + pages - 1}` } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${id}`, toolName: 'read_page', output: { type: 'content', value } as never }] },
  ];
}

function conversation(steps: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'go through every exhibit page' }];
  for (let i = 1; i <= steps; i++) messages.push(...readPageStep(i));
  return messages;
}

/** Media characters the provider would be sent, and which results still carry media. */
function mediaIn(messages: ModelMessage[]) {
  let chars = 0;
  const withMedia: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'content') continue;
      const media = part.output.value.filter((v) => v.type === 'image-data' || v.type === 'file-data');
      if (media.length) withMedia.push(part.toolCallId);
      for (const m of media) chars += 'data' in m && typeof m.data === 'string' ? m.data.length : 0;
    }
  }
  return { chars, withMedia };
}

describe('budgetToolResultMedia', () => {
  it('paging through 50 scanned pages keeps the media sent bounded, newest results first', () => {
    const budgeted = budgetToolResultMedia(conversation(10));
    const { chars, withMedia } = mediaIn(budgeted);

    expect(chars).toBeLessThanOrEqual(MAX_HISTORY_MEDIA_CHARS);
    expect(withMedia.length).toBeLessThanOrEqual(KEEP_RECENT_MEDIA_RESULTS);
    expect(withMedia.at(-1)).toBe('c10');
    expect(withMedia).not.toContain('c1');
  });

  it('is bounded by the budget, not by the length of the conversation', () => {
    expect(mediaIn(budgetToolResultMedia(conversation(50))).chars)
      .toBe(mediaIn(budgetToolResultMedia(conversation(10))).chars);
  });

  it('keeps the text of a degraded result and says how to see it again', () => {
    const budgeted = budgetToolResultMedia(conversation(10));
    const oldest = budgeted[2];
    const part = (oldest.content as Array<{ type: string; output: { type: string; value: Array<{ type: string; text?: string }> } }>)[0];
    const texts = part.output.value.map((v) => v.text);

    expect(part.output.value.every((v) => v.type === 'text')).toBe(true);
    expect(texts).toContain('Page 1:');
    expect(texts.join(' ')).toMatch(/call the tool again/i);
  });

  it('always keeps the newest media result, even one over the budget', () => {
    const huge = conversation(1);
    const value = (huge[2].content as Array<{ output: { value: Array<{ data?: string }> } }>)[0].output.value;
    for (const v of value) if (v.data) v.data = 'A'.repeat(MAX_HISTORY_MEDIA_CHARS);
    expect(mediaIn(budgetToolResultMedia(huge)).withMedia).toEqual(['c1']);
  });

  it('returns the same array when nothing is over budget', () => {
    const messages = conversation(2);
    expect(budgetToolResultMedia(messages)).toBe(messages);
  });

  it('runs inside capStepToolPayloads, so every agent loop applies it each step', () => {
    const { withMedia } = mediaIn(capStepToolPayloads(conversation(10)));
    expect(withMedia.length).toBeLessThanOrEqual(KEEP_RECENT_MEDIA_RESULTS);
  });
});
