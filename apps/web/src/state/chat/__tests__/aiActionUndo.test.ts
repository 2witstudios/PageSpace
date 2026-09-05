/**
 * SPIKE (@adobe/data adoption evidence) — AI actions with atomic undo.
 *
 * Spike question: "should AI tool-driven edits map to actions→single-transaction
 * with the built-in undo/redo stack giving atomic user-facing undo of AI
 * changes?" and its companion constraint, "≤1 transaction per action — do
 * send/answer/abort corrupt the undo stack?"
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { Observe } from '@adobe/data/observe';
import { createChatDatabase } from '../createChatDatabase';

const msg = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

const partsOf = (db: ReturnType<typeof createChatDatabase>['db'], id: string) =>
  db.actions.getEntry('c1').messages.find((m) => m.id === id)?.parts;

const seededDatabase = () => {
  const handle = createChatDatabase();
  handle.db.transactions.applyServerSnapshot({
    conversationId: 'c1',
    generationToken: 0,
    messages: [msg('m1', 'original')],
  });
  return handle;
};

const readOnce = <T>(observe: Observe<T>): T => {
  let captured: { value: T } | null = null;
  observe((value) => {
    captured = { value };
  })();
  if (captured === null) throw new Error('observable did not emit synchronously');
  return (captured as { value: T }).value;
};

describe('AI action → single undoable transaction', () => {
  it('given an AI edit applied through the action, should undo it atomically and leave the original message', () => {
    const { db, undoRedo } = seededDatabase();

    db.actions.aiApplyEdit({
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'ai rewrite' }], editedAt: new Date(0) },
    });
    expect(partsOf(db, 'm1')).toEqual([{ type: 'text', text: 'ai rewrite' }]);

    undoRedo.undo();

    expect(partsOf(db, 'm1')).toEqual([{ type: 'text', text: 'original' }]);
  });

  it('given an undone AI edit, should redo it', () => {
    const { db, undoRedo } = seededDatabase();
    db.actions.aiApplyEdit({
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'ai rewrite' }], editedAt: new Date(0) },
    });
    undoRedo.undo();

    undoRedo.redo();

    expect(partsOf(db, 'm1')).toEqual([{ type: 'text', text: 'ai rewrite' }]);
  });

  it('given two AI edits, should undo only the most recent one (no coalescing)', () => {
    const { db, undoRedo } = seededDatabase();
    db.actions.aiApplyEdit({
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'first' }], editedAt: new Date(0) },
    });
    db.actions.aiApplyEdit({
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'second' }], editedAt: new Date(1) },
    });

    undoRedo.undo();

    expect(partsOf(db, 'm1')).toEqual([{ type: 'text', text: 'first' }]);
  });

  it('given ordinary chat traffic (sends, stream frames, loads), should record nothing on the undo stack', () => {
    const { db, undoRedo } = seededDatabase();

    db.transactions.addOptimisticSend({ conversationId: 'c1', message: msg('m2', 'hello') });
    db.transactions.addStream({
      messageId: 's1',
      pageId: 'p1',
      conversationId: 'c1',
      triggeredBy: { userId: 'u1', displayName: 'Alice' },
      isOwn: true,
    });
    db.transactions.appendPart({ messageId: 's1', part: { type: 'text', text: 'tok' } });
    db.transactions.seedConversation('c2');

    expect(readOnce(undoRedo.undoEnabled)).toBe(false);
  });

  it('given an AI edit surrounded by ordinary chat traffic, should undo the AI edit and nothing else', () => {
    const { db, undoRedo } = seededDatabase();
    db.transactions.addOptimisticSend({ conversationId: 'c1', message: msg('m2', 'hello') });

    db.actions.aiApplyEdit({
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'ai rewrite' }], editedAt: new Date(0) },
    });
    db.transactions.addStream({
      messageId: 's1',
      pageId: 'p1',
      conversationId: 'c1',
      triggeredBy: { userId: 'u1', displayName: 'Alice' },
      isOwn: true,
    });

    undoRedo.undo();

    expect(partsOf(db, 'm1')).toEqual([{ type: 'text', text: 'original' }]);
    expect(db.actions.getEntry('c1').optimisticSends.map((m) => m.id)).toEqual(['m2']);
    expect(db.actions.getStream('s1')).not.toBeNull();
    expect(readOnce(undoRedo.undoEnabled)).toBe(false);
  });
});
