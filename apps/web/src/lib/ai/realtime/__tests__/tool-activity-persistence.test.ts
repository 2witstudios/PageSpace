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

function deps(over: Partial<TranscriptPersistenceDeps> = {}) {
  const global: SavedRow[] = [];
  const page: SavedRow[] = [];
  const base: TranscriptPersistenceDeps = {
    loadConversation: vi.fn(async () => conversation()),
    createConversation: vi.fn(async () => conversation()),
    canAccess: vi.fn(async () => true),
    saveGlobalMessage: async (args) => {
      global.push(args as SavedRow);
      return { saved: true, rev: 7 };
    },
    savePageMessage: async (args) => {
      page.push(args as SavedRow);
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

  it('should carry a readable body, not the raw output', async () => {
    // The body is what a surface that cannot render parts shows, and what a
    // notification would quote.
    const { deps: d, global } = deps();

    await persistVoiceToolActivity(d, running);

    expect(global[0]).toMatchObject({
      content: 'Read Page: Roadmap',
      role: 'assistant',
    });
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
