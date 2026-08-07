// @vitest-environment node
/**
 * SERVER-SIDE PAGE PLACEMENT IS ACL'D (security review, MEDIUM on the HIGH 1
 * surface).
 *
 * `open_page_pane` hands `placePagePaneForConversation` a MODEL-SUPPLIED
 * pageId. It used to select that page's title with no access check at all and
 * write it straight into the pane grid and the `workspace:updated` broadcast
 * — so a prompt-injected agent could exfiltrate the titles of pages its own
 * user cannot read, simply by naming ids.
 *
 * The rule: the ACTING USER must be able to view the page. Not the model's
 * claim, not the conversation's mere existence — the same `getUserAccessLevel`
 * gate every page read goes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApplyVerb, mockReadSnapshot, rows, pageAccess } = vi.hoisted(() => ({
  mockApplyVerb: vi.fn(),
  mockReadSnapshot: vi.fn(),
  rows: { conversations: [] as unknown[], pages: [] as unknown[] },
  pageAccess: new Set<string>(),
}));

vi.mock('../workspace-layout-runtime', () => ({
  applyWorkspaceLayoutVerb: (...args: unknown[]) => mockApplyVerb(...args),
  readWorkspaceLayoutSnapshot: (...args: unknown[]) => mockReadSnapshot(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: { __name: 'conversations' | 'pages' }) => ({
        where: () => ({ limit: async () => rows[table.__name] }),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { __name: 'conversations' } }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { __name: 'pages' } }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: async (userId: string, pageId: string) =>
    pageAccess.has(`${userId}:${pageId}`) ? 'VIEW' : null,
}));
vi.mock('@paralleldrive/cuid2', () => ({ createId: () => 'minted' }));

import { placePagePaneForConversation } from '../workspace-placement';

const MALLORY = 'mallory';
const CONVERSATION = 'conv-1';
const WORKSPACE = 'ws-1';

beforeEach(() => {
  vi.clearAllMocks();
  pageAccess.clear();
  rows.conversations = [{ workspaceId: WORKSPACE }];
  rows.pages = [{ title: 'Acquisition targets' }];
  mockReadSnapshot.mockResolvedValue({ rev: 3, grid: null });
  mockApplyVerb.mockResolvedValue({ status: 'ok', rev: 4, grid: [], applied: true });
});

describe('placePagePaneForConversation', () => {
  it('places NOTHING for a page the acting user cannot view', async () => {
    await placePagePaneForConversation({
      conversationId: CONVERSATION,
      pageId: 'page-secret',
      viewerId: MALLORY,
      opId: 'op-1',
    });
    // No verb, therefore no pane row and no broadcast — the title never
    // reaches the grid or the wire.
    expect(mockApplyVerb).not.toHaveBeenCalled();
  });

  it('does not let the model\'s own `title` smuggle a label past the gate', async () => {
    await placePagePaneForConversation({
      conversationId: CONVERSATION,
      pageId: 'page-secret',
      title: 'Something the model made up',
      viewerId: MALLORY,
      opId: 'op-1',
    });
    expect(mockApplyVerb).not.toHaveBeenCalled();
  });

  it('places the pane, with the page\'s REAL title, when the user can view it', async () => {
    pageAccess.add(`${MALLORY}:page-ok`);
    rows.pages = [{ title: 'Sprint notes' }];
    await placePagePaneForConversation({
      conversationId: CONVERSATION,
      pageId: 'page-ok',
      title: 'a worse label',
      viewerId: MALLORY,
      opId: 'op-1',
    });
    expect(mockApplyVerb).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        verb: expect.objectContaining({
          type: 'open_conversation',
          scope: expect.objectContaining({ kind: 'page', targetId: 'page-ok', name: 'Sprint notes' }),
        }),
      }),
    );
  });

  it('is still a harmless no-op for a conversation bound to no workspace', async () => {
    pageAccess.add(`${MALLORY}:page-ok`);
    rows.conversations = [];
    await placePagePaneForConversation({
      conversationId: CONVERSATION,
      pageId: 'page-ok',
      viewerId: MALLORY,
      opId: 'op-1',
    });
    expect(mockApplyVerb).not.toHaveBeenCalled();
  });
});
