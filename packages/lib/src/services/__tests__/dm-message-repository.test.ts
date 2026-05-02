import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateReturning,
  mockDeleteWhere,
  mockDeleteReturning,
  mockExecute,
  mockTransaction,
} = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockExecute: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      dmConversations: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
      fileConversations: { findFirst: vi.fn() },
      directMessages: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({ set: mockUpdateSet })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    execute: mockExecute,
    transaction: mockTransaction,
  },
}));

vi.mock('@pagespace/db/operators', () => {
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    {
      join: vi.fn((items: unknown[], separator: unknown) => ({ items, separator })),
    }
  );

  return {
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    desc: vi.fn((field: unknown) => ({ op: 'desc', field })),
    eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
    isNotNull: vi.fn((field: unknown) => ({ op: 'isNotNull', field })),
    isNull: vi.fn((field: unknown) => ({ op: 'isNull', field })),
    lt: vi.fn((field: unknown, value: unknown) => ({ op: 'lt', field, value })),
    or: vi.fn((...conditions: unknown[]) => ({ op: 'or', conditions })),
    sql,
  };
});

vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: {
    id: 'dm_conversations.id',
    participant1Id: 'dm_conversations.participant1Id',
    participant2Id: 'dm_conversations.participant2Id',
    lastMessageAt: 'dm_conversations.lastMessageAt',
  },
  directMessages: {
    id: 'direct_messages.id',
    conversationId: 'direct_messages.conversationId',
    senderId: 'direct_messages.senderId',
    content: 'direct_messages.content',
    fileId: 'direct_messages.fileId',
    attachmentMeta: 'direct_messages.attachmentMeta',
    isRead: 'direct_messages.isRead',
    readAt: 'direct_messages.readAt',
    isActive: 'direct_messages.isActive',
    deletedAt: 'direct_messages.deletedAt',
    createdAt: 'direct_messages.createdAt',
  },
}));

vi.mock('@pagespace/db/schema/storage', () => ({
  files: {
    id: 'files.id',
    createdBy: 'files.createdBy',
  },
  fileConversations: {
    fileId: 'file_conversations.fileId',
    conversationId: 'file_conversations.conversationId',
  },
}));

import { db } from '@pagespace/db/db';
import { directMessages } from '@pagespace/db/schema/social';
import { isNotNull, lt } from '@pagespace/db/operators';
import { dmMessageRepository } from '../dm-message-repository';

describe('dmMessageRepository lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUpdateReturning.mockResolvedValue([{ id: 'msg-1' }]);
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

    mockDeleteReturning.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', fileId: 'file-1' },
    ]);
    mockDeleteWhere.mockReturnValue({ returning: mockDeleteReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);
    mockExecute.mockResolvedValue({ rows: [] });
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        delete: vi.mocked(db.delete),
        execute: mockExecute,
      })
    );
  });

  it('given_softDelete_recordsDeletedAtWithoutFalsifyingReadReceipt', async () => {
    const count = await dmMessageRepository.softDeleteMessage('msg-1');

    expect(count).toBe(1);
    const updatePayload = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updatePayload.isActive).toBe(false);
    expect(updatePayload.deletedAt).toBeInstanceOf(Date);
    expect(updatePayload).not.toHaveProperty('isRead');
    expect(updatePayload).not.toHaveProperty('readAt');
  });

  it('given_inactiveDmsPastRetention_purgesByDeletedAtAndReleasesConversationFileLinks', async () => {
    const cutoff = new Date('2026-04-01T00:00:00.000Z');

    const count = await dmMessageRepository.purgeInactiveMessages(cutoff);

    expect(count).toBe(1);
    expect(isNotNull).toHaveBeenCalledWith(directMessages.deletedAt);
    expect(lt).toHaveBeenCalledWith(directMessages.deletedAt, cutoff);
    expect(mockDeleteReturning).toHaveBeenCalledWith({
      id: directMessages.id,
      conversationId: directMessages.conversationId,
      fileId: directMessages.fileId,
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
