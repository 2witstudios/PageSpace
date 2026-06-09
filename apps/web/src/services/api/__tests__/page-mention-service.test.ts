import { describe, it, expect, vi, beforeEach } from 'vitest';

// Schema tables are opaque markers in these tests; the mock tx dispatches on
// object identity to decide which "table" a query targets.
vi.mock('@pagespace/db/schema/core', () => ({
  mentions: {
    sourcePageId: 'mentions.sourcePageId',
    targetPageId: 'mentions.targetPageId',
  },
  userMentions: {
    sourcePageId: 'userMentions.sourcePageId',
    targetUserId: 'userMentions.targetUserId',
  },
  pages: { id: 'pages.id' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ['eq', a, b]),
  and: vi.fn((...c) => ['and', ...c]),
  inArray: vi.fn((c, v) => ['inArray', c, v]),
}));
// The service imports `db` only to derive types; provide a stub so the module loads.
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn(async () => []),
  getDriveMemberUserIdsByStandardRole: vi.fn(async () => []),
  getDriveMemberUserIdsByCustomRole: vi.fn(async () => []),
}));

import { syncMentions } from '../page-mention-service';
import { mentions, userMentions, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import {
  getDriveRecipientUserIds,
  getDriveMemberUserIdsByCustomRole,
} from '@pagespace/lib/services/drive-member-service';

/**
 * Build a mock transaction that behaves like Postgres with the real FK
 * constraints: inserting a mention whose targetPageId is not an existing page
 * (or a user mention whose targetUserId is not an existing user) rejects,
 * mirroring `mentions_targetPageId_pages_id_fk` in production.
 */
function makeTx(state: {
  existingPageIds?: string[];
  existingUserIds?: string[];
  existingMentions?: string[];      // current mentions.targetPageId rows for the source page
  existingUserMentions?: string[];  // current userMentions.targetUserId rows
} = {}) {
  const {
    existingPageIds = [],
    existingUserIds = [],
    existingMentions = [],
    existingUserMentions = [],
  } = state;

  const mentionInserts: Array<Record<string, unknown>> = [];
  const userMentionInserts: Array<Record<string, unknown>> = [];
  const deletes: Array<{ table: unknown; cond: unknown }> = [];

  const tx = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: (cond: unknown[]) => {
          if (table === mentions) {
            return Promise.resolve(existingMentions.map(targetPageId => ({ targetPageId })));
          }
          if (table === userMentions) {
            return Promise.resolve(existingUserMentions.map(targetUserId => ({ targetUserId })));
          }
          if (table === pages) {
            const ids = (cond?.[2] as string[]) ?? [];
            return Promise.resolve(ids.filter(id => existingPageIds.includes(id)).map(id => ({ id })));
          }
          if (table === users) {
            const ids = (cond?.[2] as string[]) ?? [];
            return Promise.resolve(ids.filter(id => existingUserIds.includes(id)).map(id => ({ id })));
          }
          return Promise.resolve([]);
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (vals: Array<Record<string, unknown>>) => {
        if (table === mentions) {
          for (const row of vals) {
            if (!existingPageIds.includes(row.targetPageId as string)) {
              return Promise.reject(new Error(
                'insert or update on table "mentions" violates foreign key constraint "mentions_targetPageId_pages_id_fk"'
              ));
            }
          }
          mentionInserts.push(...vals);
        }
        if (table === userMentions) {
          for (const row of vals) {
            if (!existingUserIds.includes(row.targetUserId as string)) {
              return Promise.reject(new Error(
                'insert or update on table "user_mentions" violates foreign key constraint "userMentions_targetUserId_users_id_fk"'
              ));
            }
          }
          userMentionInserts.push(...vals);
        }
        return Promise.resolve();
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: (cond: unknown) => {
        deletes.push({ table, cond });
        return Promise.resolve();
      },
    })),
  };

  return { tx, mentionInserts, userMentionInserts, deletes };
}

type AnyTx = Parameters<typeof syncMentions>[2];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncMentions — literal mention-format examples must not crash saves', () => {
  it('saves a document containing the literal text @[Label](id:type) as plain prose with zero mention rows', async () => {
    const { tx, mentionInserts, userMentionInserts } = makeTx();
    const content = '<p>Mentions use the format @[Label](id:type) in markdown.</p>';

    const result = await syncMentions('source-page', content, tx as unknown as AnyTx);

    expect(mentionInserts).toHaveLength(0);
    expect(userMentionInserts).toHaveLength(0);
    expect(result.newlyMentionedUserIds).toEqual([]);
  });

  it('saves a document containing @[Label](id:type) inside <code> with zero mention rows', async () => {
    const { tx, mentionInserts } = makeTx();
    const content = '<p>Example:</p><code>@[Label](id:type)</code>';

    await expect(syncMentions('source-page', content, tx as unknown as AnyTx)).resolves.toBeDefined();
    expect(mentionInserts).toHaveLength(0);
  });

  it('saves a document containing @[Label](id:type) inside <pre> with zero mention rows', async () => {
    const { tx, mentionInserts } = makeTx();
    const content = '<pre>@[Docs Page](id:page)\n@[Someone](id:user)</pre>';

    await expect(syncMentions('source-page', content, tx as unknown as AnyTx)).resolves.toBeDefined();
    expect(mentionInserts).toHaveLength(0);
  });

  it('does not parse literal user-mention examples into user mention rows', async () => {
    const { tx, userMentionInserts } = makeTx();
    const content = 'To mention a user write @[Their Name](id:user) anywhere.';

    await expect(syncMentions('source-page', content, tx as unknown as AnyTx)).resolves.toBeDefined();
    expect(userMentionInserts).toHaveLength(0);
  });
});

describe('syncMentions — valid mentions still sync', () => {
  it('inserts a page mention whose target page exists (markdown branch)', async () => {
    const { tx, mentionInserts } = makeTx({ existingPageIds: ['page123'] });

    await syncMentions('source-page', 'See @[My Page](page123:page)', tx as unknown as AnyTx);

    expect(mentionInserts).toEqual([
      { sourcePageId: 'source-page', targetPageId: 'page123' },
    ]);
  });

  it('inserts a page mention from the HTML branch (data-page-id anchor)', async () => {
    const { tx, mentionInserts } = makeTx({ existingPageIds: ['page123'] });
    const content = '<p><a data-page-id="page123">My Page</a></p>';

    await syncMentions('source-page', content, tx as unknown as AnyTx);

    expect(mentionInserts).toEqual([
      { sourcePageId: 'source-page', targetPageId: 'page123' },
    ]);
  });

  it('deletes a previously synced mention when it is removed from content', async () => {
    const { tx, mentionInserts, deletes } = makeTx({
      existingPageIds: ['page123'],
      existingMentions: ['page123'],
    });

    await syncMentions('source-page', '<p>no more mentions</p>', tx as unknown as AnyTx);

    expect(mentionInserts).toHaveLength(0);
    const mentionDeletes = deletes.filter(d => d.table === mentions);
    expect(mentionDeletes).toHaveLength(1);
  });

  it('does not re-insert an already-synced mention', async () => {
    const { tx, mentionInserts, deletes } = makeTx({
      existingPageIds: ['page123'],
      existingMentions: ['page123'],
    });

    await syncMentions('source-page', 'Still here: @[My Page](page123:page)', tx as unknown as AnyTx);

    expect(mentionInserts).toHaveLength(0);
    expect(deletes.filter(d => d.table === mentions)).toHaveLength(0);
  });

  it('inserts a user mention whose target user exists and reports it as newly mentioned', async () => {
    const { tx, userMentionInserts } = makeTx({ existingUserIds: ['user42'] });

    const result = await syncMentions(
      'source-page',
      'Hey @[Alice](user42:user)',
      tx as unknown as AnyTx,
      { mentionedByUserId: 'author-1' }
    );

    expect(userMentionInserts).toEqual([
      { sourcePageId: 'source-page', targetUserId: 'user42', mentionedByUserId: 'author-1' },
    ]);
    expect(result.newlyMentionedUserIds).toEqual(['user42']);
  });
});

describe('syncMentions — nonexistent targets are dropped silently', () => {
  it('drops a mention of a nonexistent page ID without throwing', async () => {
    const { tx, mentionInserts } = makeTx({ existingPageIds: ['real-page'] });

    const result = await syncMentions(
      'source-page',
      '@[Real](real-page:page) and @[Gone](deleted-page:page)',
      tx as unknown as AnyTx
    );

    expect(mentionInserts).toEqual([
      { sourcePageId: 'source-page', targetPageId: 'real-page' },
    ]);
    expect(result).toBeDefined();
  });

  it('drops a mention of a nonexistent user ID without throwing', async () => {
    const { tx, userMentionInserts } = makeTx({ existingUserIds: [] });

    const result = await syncMentions(
      'source-page',
      '@[Ghost](no-such-user:user)',
      tx as unknown as AnyTx,
      { mentionedByUserId: 'author-1' }
    );

    expect(userMentionInserts).toHaveLength(0);
    expect(result.newlyMentionedUserIds).toEqual([]);
  });
});

describe('syncMentions — group mention expansion is fail-soft', () => {
  it('does not destroy the save when @everyone expansion throws', async () => {
    vi.mocked(getDriveRecipientUserIds).mockRejectedValueOnce(new Error('drive query failed'));
    const { tx, userMentionInserts } = makeTx();

    await expect(
      syncMentions('source-page', 'Hi @[everyone](everyone:everyone)', tx as unknown as AnyTx, {
        driveId: 'drive-1',
      })
    ).resolves.toBeDefined();
    expect(userMentionInserts).toHaveLength(0);
  });

  it('still validates group-expanded user IDs before inserting', async () => {
    // Expansion returns one real and one stale user; only the real one is inserted.
    vi.mocked(getDriveMemberUserIdsByCustomRole).mockResolvedValueOnce(['real-user', 'stale-user']);
    const { tx, userMentionInserts } = makeTx({ existingUserIds: ['real-user'] });

    await syncMentions('source-page', '@[Designers](role-1:role)', tx as unknown as AnyTx, {
      driveId: 'drive-1',
    });

    expect(userMentionInserts).toEqual([
      { sourcePageId: 'source-page', targetUserId: 'real-user', mentionedByUserId: null },
    ]);
  });
});

describe('syncMentions — HTML branch skips mention nodes inside code regions', () => {
  it('ignores data-page-id anchors inside <pre> and <code> but keeps ones outside', async () => {
    const { tx, mentionInserts } = makeTx({ existingPageIds: ['outside', 'inside-pre', 'inside-code'] });
    const content =
      '<p><a data-page-id="outside">Real</a></p>' +
      '<pre><a data-page-id="inside-pre">Example</a></pre>' +
      '<code><a data-page-id="inside-code">Example</a></code>';

    await syncMentions('source-page', content, tx as unknown as AnyTx);

    expect(mentionInserts).toEqual([
      { sourcePageId: 'source-page', targetPageId: 'outside' },
    ]);
  });
});
