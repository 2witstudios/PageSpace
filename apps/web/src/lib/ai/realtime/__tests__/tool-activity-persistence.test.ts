/**
 * A voice tool call, as a row in the thread.
 *
 * The cases that matter are the ones about SHAPE: this row is only useful
 * because it is byte-for-byte the shape the typed surface already produces, so
 * the renderer, the socket payload and the reload path all accept it without
 * knowing voice exists. A part that is nearly right renders as nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { persistVoiceToolActivity } from '../tool-activity-persistence';
import type { TranscriptPersistenceDeps } from '../transcript-persistence';
import type { UIMessage } from 'ai';
import {
  convertGlobalAssistantMessageToUIMessage,
  extractStructuredContentFromParts,
  readMessageText,
} from '../../core/message-utils';

const conversation = (over: Record<string, unknown> = {}) => ({
  id: 'conv1',
  userId: 'u1',
  isShared: false,
  type: 'global',
  contextId: null,
  isActive: true,
  ...over,
});

/** Whatever reached the repository, in the order it got there. */
type SavedRow = Record<string, unknown>;

/**
 * The repository does NOT store what it is handed: when a save carries parts it
 * rewrites `content` into the structured envelope
 * (`message-repository.ts` → `extractStructuredContentFromParts`). A fake that
 * records the arguments verbatim therefore tests a row shape that never reaches
 * the database — and every assertion about what is stored would be about
 * something imaginary. This mirrors that rewrite.
 */
const asStored = async (args: Record<string, unknown>): Promise<SavedRow> => {
  const uiMessage = args.uiMessage as { parts?: UIMessage['parts'] } | undefined;
  if (!uiMessage?.parts?.length) return args as SavedRow;
  return {
    ...args,
    content: await extractStructuredContentFromParts(uiMessage.parts, args.content as string),
  };
};

function deps(over: Partial<TranscriptPersistenceDeps> = {}) {
  const global: SavedRow[] = [];
  const page: SavedRow[] = [];
  const base: TranscriptPersistenceDeps = {
    loadConversation: vi.fn(async () => conversation()),
    createConversation: vi.fn(async () => conversation()),
    canAccess: vi.fn(async () => true),
    saveGlobalMessage: async (args) => {
      global.push(await asStored(args as Record<string, unknown>));
      return { saved: true, rev: 7 };
    },
    savePageMessage: async (args) => {
      page.push(await asStored(args as Record<string, unknown>));
      return { saved: true, rev: 7 };
    },
    newMessageId: vi.fn(() => 'minted1'),
    logger: { warn: vi.fn() },
    ...over,
  };
  return { deps: base, global, page };
}

const running = {
  callId: 'rtc_1',
  userId: 'u1',
  conversationId: 'conv1',
  toolCallId: 'call_1',
  name: 'read_page',
  argumentsJson: '{"title":"Roadmap"}',
};

/** The tool part the row was written with. */
const partOf = (rows: SavedRow[]): Record<string, unknown> =>
  (rows[0]?.uiMessage as { parts: Record<string, unknown>[] }).parts[0];

describe('persistVoiceToolActivity — the running row', () => {
  it('should write a tool part in the shape the typed surface produces', async () => {
    // `chunkToPart` emits exactly this. Every renderer and the reload path key
    // off it, so matching it is what buys all of them.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, running);

    expect(partOf(global)).toEqual({
      type: 'tool-read_page',
      toolCallId: 'call_1',
      toolName: 'read_page',
      input: { title: 'Roadmap' },
      state: 'input-available',
    });
  });

  it('should answer with the row id, which is the only way the result finds it', async () => {
    const { deps: d } = deps();

    const result = await persistVoiceToolActivity(d, running);

    expect(result).toMatchObject({ saved: true, messageId: 'minted1', rev: 7 });
  });

  it('should store NO text, because nothing was said', async () => {
    // Load-bearing, not an omission. The seed replays a message's words as an
    // utterance, so a label here would seed the next call with
    // "Read Page: Roadmap" as though the assistant had said it — and spend the
    // seed's turn budget on things nobody said. Asserted through the reader the
    // seed actually uses, because the stored column is an envelope, not text.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, running);

    expect(global[0].role).toBe('assistant');
    expect(readMessageText(global[0].content as string)).toBe('');
  });

  it('should be written even though it has no text', async () => {
    // The transcript writer refuses a blank body — a spoken turn that said
    // nothing is worse than no row. That reasoning does not reach a row which
    // renders from its parts, and applying it here would drop the record of a
    // tool call that actually ran.
    const { deps: d, global } = deps();

    const result = await persistVoiceToolActivity(d, running);

    expect(result.saved).toBe(true);
    expect(global).toHaveLength(1);
  });

  it('should mark the row as spoken, so the thread shows the mic glyph', async () => {
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, running);

    expect(global[0].source).toBe('voice');
  });
});

describe('persistVoiceToolActivity — the finished row', () => {
  it('should reuse the id it was given rather than minting a second row', async () => {
    // Same id ⇒ the repository updates in place and emits messageUpdated. A new
    // id would leave a spinner stranded above its own result.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, {
      ...running,
      messageId: 'm1',
      output: 'Line 1\nLine 2',
    });

    expect(global[0].messageId).toBe('m1');
    expect(d.newMessageId).not.toHaveBeenCalled();
  });

  it('should move the part to output-available and carry what the model saw', async () => {
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, { ...running, messageId: 'm1', output: 'Line 1' });

    expect(partOf(global)).toMatchObject({
      state: 'output-available',
      output: 'Line 1',
    });
  });

  it('given a failed tool, should render as an error rather than an empty result', async () => {
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, {
      ...running,
      messageId: 'm1',
      output: 'ignored',
      errorText: 'The tool could not be reached.',
    });

    expect(partOf(global)).toMatchObject({
      state: 'output-error',
      errorText: 'The tool could not be reached.',
    });
  });

  it('should populate the columns a reload rebuilds the parts from', async () => {
    // Live delivery rides `uiMessage`; a refresh rebuilds from these. Without
    // both, the call renders once and then disappears.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, { ...running, messageId: 'm1', output: 'Line 1' });

    expect(global[0].toolCalls).toHaveLength(1);
    expect(global[0].toolResults).toHaveLength(1);
  });
});

describe('persistVoiceToolActivity — arguments as they actually arrive', () => {
  it('given arguments that will not parse, should still record the call', async () => {
    // Assembled from streamed deltas. The copy that must be right is parsed in
    // `tool-dispatch.ts`; losing the row over it would hide a call that ran.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, { ...running, argumentsJson: '{"title":' });

    expect(partOf(global)).toMatchObject({
      toolName: 'read_page',
      input: { raw: '{"title":' },
    });
  });

  it('given no arguments, should record an empty object rather than nothing', async () => {
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, { ...running, name: 'list_drives', argumentsJson: '' });

    expect(partOf(global)).toMatchObject({ input: {} });
  });
});

describe('persistVoiceToolActivity — it takes the same guarded path a transcript does', () => {
  it('given a caller who cannot read the conversation, should write nothing', async () => {
    const { deps: d, global } = deps({ canAccess: vi.fn(async () => false) });

    const result = await persistVoiceToolActivity(d, running);

    expect(global).toEqual([]);
    expect(result.saved).toBe(false);
  });

  it('given a page conversation, should attribute the row to the agent', async () => {
    // `userId: null` with `sourceAgentId` is the attribution rule for an
    // agent-authored row, and a tool call is agent-authored.
    const { deps: d, page } = deps({
      loadConversation: vi.fn(async () => conversation({ type: 'page', contextId: 'agent1' })),
    });

    await persistVoiceToolActivity(d, running);

    expect(page[0]).toMatchObject({
      pageId: 'agent1',
      userId: null,
      sourceAgentId: 'agent1',
    });
  });

  it('given a deleted conversation, should refuse rather than write somewhere unreachable', async () => {
    const { deps: d, global } = deps({
      loadConversation: vi.fn(async () => conversation({ isActive: false })),
    });

    const result = await persistVoiceToolActivity(d, running);

    expect(global).toEqual([]);
    expect(result.skipped).toBe('history_deleted');
  });
});

/**
 * The claim being tested is "it is still there when you come back to the
 * thread". Live delivery rides `uiMessage` on the socket event; a RELOAD
 * rebuilds the parts from the stored columns instead, so the two can disagree
 * — and a row that renders once and then vanishes on refresh is worse than one
 * that never rendered.
 *
 * This drives the real reconstruction the thread uses, over exactly what the
 * writer produced, with no database in between.
 */
describe('persistVoiceToolActivity — what comes back after a reload', () => {
  const reload = async (row: SavedRow) =>
    convertGlobalAssistantMessageToUIMessage({
      id: row.messageId as string,
      conversationId: 'conv1',
      userId: null,
      role: 'assistant',
      content: row.content as string,
      toolCalls: row.toolCalls ?? null,
      toolResults: row.toolResults ?? null,
      createdAt: new Date(0),
    } as Parameters<typeof convertGlobalAssistantMessageToUIMessage>[0]);

  it('should come back as the same tool part it was written as', async () => {
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, {
      ...running,
      messageId: 'm1',
      output: 'Line 1\nLine 2',
    });
    const message = await reload(global[0]);

    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({
      type: 'tool-read_page',
      toolCallId: 'call_1',
      state: 'output-available',
      output: 'Line 1\nLine 2',
    });
  });

  it('given a failed tool, should still come back as an error', async () => {
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, {
      ...running,
      messageId: 'm1',
      output: 'ignored',
      errorText: "That didn't work: permission denied",
    });
    const message = await reload(global[0]);

    expect(message.parts[0]).toMatchObject({
      state: 'output-error',
      errorText: "That didn't work: permission denied",
    });
  });

  it('should not reappear as a spoken turn — it never said anything', async () => {
    // The row carries no text, so a reload must not invent an empty utterance
    // above the tool card.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, { ...running, messageId: 'm1', output: 'ok' });
    const message = await reload(global[0]);

    expect(message.parts.filter((part) => part.type === 'text')).toEqual([]);
  });
});
