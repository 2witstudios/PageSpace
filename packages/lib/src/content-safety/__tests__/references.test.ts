/**
 * The one behaviour of the reference sweep that Postgres cannot be made to
 * show on demand: the AI-message search failing. The queries themselves are
 * proven against a real database in takedown-db.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messages } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';

const state = vi.hoisted(() => ({
  failMessages: false,
  pageRows: [] as Array<{ id: string; driveId: string; createdBy: string | null }>,
  messageRows: [] as Array<{ id: string; conversationId: string; userId: string | null; role: string; content: string }>,
  transactions: 0,
  statements: [] as string[],
}));

vi.mock('@pagespace/db/db', () => {
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === messages) {
            if (state.failMessages) throw new Error('canceling statement due to statement timeout');
            return state.messageRows;
          }
          return table === pages ? state.pageRows : [];
        },
      }),
    }),
  });
  return {
    db: {
      select,
      transaction: async (run: (tx: { execute: (query: unknown) => Promise<void>; select: typeof select }) => Promise<unknown>) => {
        state.transactions += 1;
        return run({
          execute: async (query: unknown) => {
            const chunks = (query as { queryChunks?: Array<{ value?: string[] }> }).queryChunks ?? [];
            state.statements.push(chunks.flatMap((chunk) => chunk.value ?? []).join(''));
          },
          select,
        });
      },
    },
  };
});
vi.mock('../../logging/logger-config', () => ({ loggers: { security: { error: vi.fn() } } }));

import { collectAiMessageReferences, collectContentReferences } from '../references';
import { loggers } from '../../logging/logger-config';

const HASH = 'a'.repeat(64);
const KEY = `chat-attachments/${HASH}/original`;
/** A persisted AI-chat message body that really attaches the file. */
const attachedEnvelope = (filePart: Record<string, string> = { storageKey: KEY }) =>
  JSON.stringify({ textParts: ['look'], fileParts: [filePart], partsOrder: [{ index: 0, type: 'text' }, { index: 0, type: 'file' }] });
/** A message that only TALKS about the key: the substring is there, no attachment is. */
const mentionEnvelope = () =>
  JSON.stringify({ textParts: [`see ${KEY}`], partsOrder: [{ index: 0, type: 'text' }] });

describe('collectContentReferences (a lookup) — when the AI-message search cannot finish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failMessages = false;
    state.pageRows = [{ id: 'page-1', driveId: 'drive-1', createdBy: 'user-1' }];
    state.messageRows = [{ id: 'msg-1', conversationId: 'conv-1', userId: 'chat-user', role: 'user', content: attachedEnvelope() }];
  });

  it('still returns every other reference', async () => {
    state.failMessages = true;

    const refs = await collectContentReferences(HASH);

    expect(refs.pageIds).toEqual(['page-1']);
    expect(refs.driveIds).toEqual(['drive-1']);
    expect(refs.uploaderUserIds).toEqual(['user-1']);
    expect(refs.aiMessageIds).toEqual([]);
  });

  it('says so on the result and in the log, rather than passing an incomplete list off as complete', async () => {
    state.failMessages = true;

    const refs = await collectContentReferences(HASH);

    expect(refs.aiMessageScanFailed).toBe(true);
    expect(loggers.security.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(loggers.security.error).mock.calls)).not.toContain(HASH);
  });

  it('does not set the flag when the search succeeds', async () => {
    const refs = await collectContentReferences(HASH);
    expect(refs.aiMessageScanFailed).toBeUndefined();
    expect(loggers.security.error).not.toHaveBeenCalled();
  });
});

describe('collectAiMessageReferences (the takedown step)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failMessages = false;
    state.transactions = 0;
    state.statements = [];
    state.messageRows = [
      { id: 'msg-1', conversationId: 'conv-1', userId: 'chat-user', role: 'user', content: attachedEnvelope() },
      { id: 'msg-2', conversationId: 'conv-1', userId: null, role: 'user', content: attachedEnvelope() },
    ];
  });

  it('records a message that only mentions the key, but never names its author as an uploader', async () => {
    state.messageRows = [
      { id: 'msg-text', conversationId: 'conv-1', userId: 'talker', role: 'user', content: `raw ${KEY}` },
      { id: 'msg-env', conversationId: 'conv-2', userId: 'quoter', role: 'user', content: mentionEnvelope() },
      { id: 'msg-real', conversationId: 'conv-3', userId: 'uploader', role: 'user', content: attachedEnvelope() },
    ];
    expect(await collectAiMessageReferences(HASH)).toEqual({
      aiMessageIds: ['msg-text', 'msg-env', 'msg-real'],
      conversationIds: ['conv-1', 'conv-2', 'conv-3'],
      uploaderUserIds: ['uploader'],
      truncated: false,
    });
  });

  it('names no uploader for a file part that is not exactly this attachment key', async () => {
    state.messageRows = [
      { id: 'm1', conversationId: 'c', userId: 'external-url', role: 'user', content: attachedEnvelope({ url: `https://evil.example/${KEY}` }) },
      { id: 'm2', conversationId: 'c', userId: 'longer-key', role: 'user', content: attachedEnvelope({ storageKey: `x/${KEY}` }) },
      { id: 'm3', conversationId: 'c', userId: 'other-hash', role: 'user', content: attachedEnvelope({ storageKey: `chat-attachments/${'b'.repeat(64)}/original` }) },
    ];
    expect((await collectAiMessageReferences(HASH)).uploaderUserIds).toEqual([]);
  });

  it('names no uploader for an assistant message, even one carrying the attachment', async () => {
    state.messageRows = [
      { id: 'm1', conversationId: 'c', userId: 'human-in-chat', role: 'assistant', content: attachedEnvelope() },
    ];
    expect((await collectAiMessageReferences(HASH)).uploaderUserIds).toEqual([]);
  });

  it('returns the messages, their conversations and their human authors', async () => {
    expect(await collectAiMessageReferences(HASH)).toEqual({
      aiMessageIds: ['msg-1', 'msg-2'],
      conversationIds: ['conv-1'],
      uploaderUserIds: ['chat-user'],
      truncated: false,
    });
  });

  it('runs at the ordinary timeout by default and in its own transaction with a longer one when asked', async () => {
    await collectAiMessageReferences(HASH);
    expect(state.transactions).toBe(0);

    await collectAiMessageReferences(HASH, { extendedTimeout: true });
    expect(state.transactions).toBe(1);
    expect(state.statements).toEqual(["set local statement_timeout = '120s'"]);
  });

  it('throws when the search cannot finish, rather than returning a partial list as if it were whole', async () => {
    state.failMessages = true;
    await expect(collectAiMessageReferences(HASH)).rejects.toThrow('statement timeout');
    expect(JSON.stringify(vi.mocked(loggers.security.error).mock.calls)).not.toContain(HASH);
  });
});
