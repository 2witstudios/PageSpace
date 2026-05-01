import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/storage', () => ({
  filePages: { fileId: 'fileId', pageId: 'pageId' },
  fileConversations: { fileId: 'fileId', conversationId: 'conversationId' },
}));
vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: {
    id: 'id',
    participant1Id: 'participant1Id',
    participant2Id: 'participant2Id',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a, _b) => 'eq'),
}));

vi.mock('../permissions', () => ({
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { canUserAccessFile } from '../file-access';
import { db } from '@pagespace/db/db';
import { canUserViewPage, isUserDriveMember } from '../permissions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConversationLinkage {
  participant1Id: string;
  participant2Id: string;
}

/**
 * Mock the two parallel queries `canUserAccessFile` issues. The first call
 * resolves to filePages rows; the second resolves to a fileConversations
 * inner-joined with dmConversations result set.
 */
function setupLinkages({
  pages = [],
  conversations = [],
}: {
  pages?: Array<{ pageId: string }>;
  conversations?: ConversationLinkage[];
}) {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(pages),
      }),
    } as unknown as ReturnType<typeof db.select>)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(conversations),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canUserAccessFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('page linkages', () => {
    it('grants when user can view at least one linked page', async () => {
      setupLinkages({ pages: [{ pageId: 'page-1' }, { pageId: 'page-2' }] });
      vi.mocked(canUserViewPage)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      expect(await canUserAccessFile('user-1', 'file-1', 'drive-1')).toBe(true);
    });

    it('denies when user cannot view any linked page (and no conv linkage)', async () => {
      setupLinkages({ pages: [{ pageId: 'page-1' }, { pageId: 'page-2' }] });
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      expect(await canUserAccessFile('user-1', 'file-1', 'drive-1')).toBe(false);
    });

    it('short-circuits on first accessible page', async () => {
      setupLinkages({ pages: [{ pageId: 'page-1' }, { pageId: 'page-2' }] });
      vi.mocked(canUserViewPage).mockResolvedValueOnce(true);

      expect(await canUserAccessFile('user-1', 'file-1', 'drive-1')).toBe(true);
      expect(canUserViewPage).toHaveBeenCalledTimes(1);
    });

    it('does not call isUserDriveMember when linked pages exist', async () => {
      setupLinkages({ pages: [{ pageId: 'page-1' }] });
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      await canUserAccessFile('user-1', 'file-1', 'drive-1');
      expect(isUserDriveMember).not.toHaveBeenCalled();
    });
  });

  describe('conversation linkages', () => {
    it('grants when user is participant1 of a linked conversation', async () => {
      setupLinkages({
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });

      expect(await canUserAccessFile('alice', 'file-1', null)).toBe(true);
    });

    it('grants when user is participant2 of a linked conversation', async () => {
      setupLinkages({
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });

      expect(await canUserAccessFile('bob', 'file-1', null)).toBe(true);
    });

    it('denies a non-participant', async () => {
      setupLinkages({
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });

      expect(await canUserAccessFile('carol', 'file-1', null)).toBe(false);
    });

    it('does not call isUserDriveMember when conv linkages exist', async () => {
      setupLinkages({
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });

      await canUserAccessFile('carol', 'file-1', 'drive-1');
      expect(isUserDriveMember).not.toHaveBeenCalled();
    });
  });

  describe('dual linkages (page + conversation)', () => {
    it('grants via the conversation path when the page check fails', async () => {
      setupLinkages({
        pages: [{ pageId: 'private-page' }],
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      expect(await canUserAccessFile('alice', 'file-1', 'drive-1')).toBe(true);
    });

    it('grants via the page path even when user is not a conv participant', async () => {
      setupLinkages({
        pages: [{ pageId: 'public-page' }],
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });
      vi.mocked(canUserViewPage).mockResolvedValueOnce(true);

      expect(await canUserAccessFile('carol', 'file-1', 'drive-1')).toBe(true);
    });

    it('denies when user fails both branches independently', async () => {
      setupLinkages({
        pages: [{ pageId: 'private-page' }],
        conversations: [{ participant1Id: 'alice', participant2Id: 'bob' }],
      });
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      expect(await canUserAccessFile('carol', 'file-1', 'drive-1')).toBe(false);
    });
  });

  describe('drive-membership fallback (no linkages)', () => {
    it('grants when user is a drive member', async () => {
      setupLinkages({});
      vi.mocked(isUserDriveMember).mockResolvedValue(true);

      expect(await canUserAccessFile('user-1', 'file-1', 'drive-1')).toBe(true);
      expect(isUserDriveMember).toHaveBeenCalledWith('user-1', 'drive-1');
    });

    it('denies when user is not a drive member', async () => {
      setupLinkages({});
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      expect(await canUserAccessFile('user-1', 'file-1', 'drive-1')).toBe(false);
    });

    it('denies when no linkages and driveId is null (no anyone-can-see fallthrough)', async () => {
      setupLinkages({});

      expect(await canUserAccessFile('user-1', 'file-1', null)).toBe(false);
      expect(isUserDriveMember).not.toHaveBeenCalled();
    });

    it('does not call canUserViewPage when no page linkages exist', async () => {
      setupLinkages({});
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      await canUserAccessFile('user-1', 'file-1', 'drive-1');
      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });
});
