import { describe, expect, it, vi } from 'vitest';
import { MESSAGE_SOURCE_VOICE } from '@pagespace/db/schema/conversations';
import {
  persistVoiceTranscript,
  type TranscriptConversation,
  type TranscriptPersistenceDeps,
  type TranscriptRequest,
} from '../transcript-persistence';

type GlobalSaveArgs = Parameters<TranscriptPersistenceDeps['saveGlobalMessage']>[0];
type PageSaveArgs = Parameters<TranscriptPersistenceDeps['savePageMessage']>[0];

const conversation = (over: Partial<TranscriptConversation> = {}): TranscriptConversation => ({
  id: 'conv1',
  userId: 'u1',
  isShared: false,
  type: 'global',
  contextId: null,
  isActive: true,
  ...over,
});

const request = (over: Partial<TranscriptRequest> = {}): TranscriptRequest => ({
  callId: 'rtc_1',
  userId: 'u1',
  conversationId: 'conv1',
  role: 'user',
  text: 'where are my notes?',
  ...over,
});

function deps(over: Partial<TranscriptPersistenceDeps> = {}) {
  // Typed parameters, not `vi.fn(async () => …)`: without them the mock's
  // argument list infers as `[]` and `mock.calls[0][0]` does not type-check.
  const saveGlobalMessage = vi.fn(async (_args: GlobalSaveArgs) => ({ saved: true, rev: 7 }));
  const savePageMessage = vi.fn(async (_args: PageSaveArgs) => ({ saved: true, rev: 9 }));
  const base: TranscriptPersistenceDeps = {
    loadConversation: vi.fn(async () => conversation()),
    createConversation: vi.fn(async () => conversation()),
    canAccess: vi.fn(async () => true),
    saveGlobalMessage,
    savePageMessage,
    newMessageId: () => 'msg-1',
    logger: { warn: vi.fn() },
    ...over,
  };
  return { deps: base, saveGlobalMessage, savePageMessage };
}

describe('persistVoiceTranscript — global conversations', () => {
  it('given a spoken user turn, should write it as an ordinary message row', async () => {
    const { deps: d, saveGlobalMessage } = deps();

    const result = await persistVoiceTranscript(d, request());

    expect(saveGlobalMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        conversationId: 'conv1',
        role: 'user',
        content: 'where are my notes?',
        userId: 'u1',
      }),
    );
    expect(result).toEqual({ saved: true, messageId: 'msg-1', rev: 7 });
  });

  it('should mark the row as voice-authored so the UI and the seed can tell it apart', async () => {
    const { deps: d, saveGlobalMessage } = deps();
    await persistVoiceTranscript(d, request());

    expect(saveGlobalMessage.mock.calls[0][0]).toMatchObject({ source: MESSAGE_SOURCE_VOICE });
  });

  it('given the assistant spoke, should write an assistant row against the same conversation', async () => {
    const { deps: d, saveGlobalMessage } = deps();
    await persistVoiceTranscript(d, request({ role: 'assistant', text: 'In your Inbox.' }));

    expect(saveGlobalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'In your Inbox.' }),
    );
  });

  it('should attribute the row to the conversation OWNER, matching every other global write', async () => {
    const { deps: d, saveGlobalMessage } = deps({
      loadConversation: vi.fn(async () => conversation({ userId: 'owner' })),
      canAccess: vi.fn(async () => true),
    });

    await persistVoiceTranscript(d, request({ userId: 'owner' }));

    expect(saveGlobalMessage.mock.calls[0][0].userId).toBe('owner');
  });

  it('should trim the text before writing it', async () => {
    const { deps: d, saveGlobalMessage } = deps();
    await persistVoiceTranscript(d, request({ text: '  spoken  ' }));

    expect(saveGlobalMessage.mock.calls[0][0].content).toBe('spoken');
  });

  it('given a save that was skipped, should report saved:false with no message id', async () => {
    const { deps: d } = deps({
      saveGlobalMessage: vi.fn(async (_args: GlobalSaveArgs) => ({ saved: false, rev: 0 })),
    });

    expect(await persistVoiceTranscript(d, request())).toEqual({
      saved: false,
      messageId: null,
      rev: 0,
    });
  });
});

describe('persistVoiceTranscript — page conversations', () => {
  const pageConversation = conversation({ type: 'page', contextId: 'page-1' });

  it('given a page thread, should write through the page path with its page id', async () => {
    const { deps: d, savePageMessage } = deps({
      loadConversation: vi.fn(async () => pageConversation),
    });

    const result = await persistVoiceTranscript(d, request());

    expect(savePageMessage).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-1', role: 'user', userId: 'u1', sourceAgentId: null }),
    );
    expect(result.rev).toBe(9);
  });

  it('given the AGENT spoke, should attribute the row to the agent page, not to a human', async () => {
    // The attribution rule the `messages` table documents: a human author, or
    // NULL with `sourceAgentId` naming the agent that wrote it.
    const { deps: d, savePageMessage } = deps({
      loadConversation: vi.fn(async () => pageConversation),
    });

    await persistVoiceTranscript(d, request({ role: 'assistant' }));

    expect(savePageMessage.mock.calls[0][0]).toMatchObject({
      userId: null,
      sourceAgentId: 'page-1',
    });
  });

  it('given a page conversation with no page, should refuse rather than guess', async () => {
    const { deps: d, savePageMessage } = deps({
      loadConversation: vi.fn(async () => conversation({ type: 'page', contextId: null })),
    });

    const result = await persistVoiceTranscript(d, request());

    expect(result.skipped).toBe('unsupported_conversation_type');
    expect(savePageMessage).not.toHaveBeenCalled();
  });
});

describe('persistVoiceTranscript — refusals', () => {
  it('given a blank transcript, should skip rather than write an empty turn', async () => {
    const { deps: d, saveGlobalMessage } = deps();

    const result = await persistVoiceTranscript(d, request({ text: '   ' }));

    expect(result.skipped).toBe('blank');
    expect(saveGlobalMessage).not.toHaveBeenCalled();
  });

  it('given a caller who cannot access the conversation, should refuse the write', async () => {
    const { deps: d, saveGlobalMessage } = deps({ canAccess: vi.fn(async () => false) });

    const result = await persistVoiceTranscript(d, request({ userId: 'someone-else' }));

    expect(result.skipped).toBe('no_access');
    expect(saveGlobalMessage).not.toHaveBeenCalled();
  });

  it('given the thread was deleted from history mid-call, should drop the turn', async () => {
    // Writing under it would put the turn somewhere no listing can reach.
    const { deps: d, saveGlobalMessage } = deps({
      loadConversation: vi.fn(async () => conversation({ isActive: false })),
    });

    const result = await persistVoiceTranscript(d, request());

    expect(result.skipped).toBe('history_deleted');
    expect(saveGlobalMessage).not.toHaveBeenCalled();
  });

  it('given a drive or client thread, should refuse rather than invent a binding', async () => {
    for (const type of ['drive', 'client']) {
      const { deps: d, saveGlobalMessage, savePageMessage } = deps({
        loadConversation: vi.fn(async () => conversation({ type })),
      });

      const result = await persistVoiceTranscript(d, request());

      expect(result.skipped).toBe('unsupported_conversation_type');
      expect(saveGlobalMessage).not.toHaveBeenCalled();
      expect(savePageMessage).not.toHaveBeenCalled();
    }
  });
});

describe('persistVoiceTranscript — lazy conversation creation', () => {
  it('given no conversation row yet, should create it the way the typed path does and write', async () => {
    const createConversation = vi.fn(async () => conversation());
    const { deps: d, saveGlobalMessage } = deps({
      loadConversation: vi.fn(async () => undefined),
      createConversation,
    });

    const result = await persistVoiceTranscript(d, request());

    expect(createConversation).toHaveBeenCalledWith('u1', 'conv1');
    expect(saveGlobalMessage).toHaveBeenCalled();
    expect(result.saved).toBe(true);
  });

  it('given the id belongs to someone else, should report rather than write', async () => {
    const { deps: d, saveGlobalMessage } = deps({
      loadConversation: vi.fn(async () => undefined),
      createConversation: vi.fn(async () => undefined),
    });

    const result = await persistVoiceTranscript(d, request());

    expect(result.skipped).toBe('create_failed');
    expect(saveGlobalMessage).not.toHaveBeenCalled();
  });

  it('given a freshly created conversation, should not also re-check access against it', async () => {
    // `resolveOrCreateConversation` already enforces owner + type; a second
    // check here would be a second permission model for the same decision.
    const canAccess = vi.fn(async () => false);
    const { deps: d, saveGlobalMessage } = deps({
      loadConversation: vi.fn(async () => undefined),
      canAccess,
    });

    await persistVoiceTranscript(d, request());

    expect(canAccess).not.toHaveBeenCalled();
    expect(saveGlobalMessage).toHaveBeenCalled();
  });
});
