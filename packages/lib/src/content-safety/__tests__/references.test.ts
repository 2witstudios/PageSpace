/**
 * The one behaviour of the reference sweep that Postgres cannot be made to
 * show on demand: the AI-message search failing. The queries themselves are
 * proven against a real database in takedown-db.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messages } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';

const state = vi.hoisted(() => ({ failMessages: false, pageRows: [] as Array<{ id: string; driveId: string; createdBy: string | null }> }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === messages) {
              if (state.failMessages) throw new Error('canceling statement due to statement timeout');
              return [];
            }
            return table === pages ? state.pageRows : [];
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../logging/logger-config', () => ({ loggers: { security: { error: vi.fn() } } }));

import { collectContentReferences } from '../references';
import { loggers } from '../../logging/logger-config';

const HASH = 'a'.repeat(64);

describe('collectContentReferences — when the AI-message search cannot finish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failMessages = false;
    state.pageRows = [{ id: 'page-1', driveId: 'drive-1', createdBy: 'user-1' }];
  });

  it('still returns every other reference, so a slow scan cannot hold a takedown up', async () => {
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
