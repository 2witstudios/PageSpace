import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      commands: { findFirst: vi.fn(), findMany: vi.fn() },
      pages: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  asc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', parentId: 'parentId', isTrashed: 'isTrashed', position: 'position' },
}));
vi.mock('@pagespace/db/schema/commands', () => ({
  commands: { id: 'id' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
  getBatchPagePermissions: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import { db } from '@pagespace/db/db';
import {
  canUserViewPage,
  getBatchPagePermissions,
  isUserDriveMember,
} from '@pagespace/lib/permissions/permissions';
import { planCommandExecutions } from '../command-resolver';

const mockCommandsFindFirst = db.query.commands.findFirst as unknown as Mock;
const mockCommandsFindMany = db.query.commands.findMany as unknown as Mock;
const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockCanUserViewPage = vi.mocked(canUserViewPage);
const mockIsUserDriveMember = vi.mocked(isUserDriveMember);
const mockBatchPermissions = vi.mocked(getBatchPagePermissions);

const SENDER = 'usr9zmbrgj3atz4a98xxat96';
const CMD_ID = 'tz4a98xxat96iws9zmbrgj3a';
const ENTRY_PAGE_ID = 'pge9zmbrgj3atz4a98xxat96';

const tokenContent = (label = 'release-checklist', id = CMD_ID) => `/[${label}](${id}:command) go`;

function personalCommandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CMD_ID,
    userId: SENDER,
    driveId: null,
    trigger: 'release-checklist',
    description: 'Run the release checklist.',
    entryPageId: ENTRY_PAGE_ID,
    type: 'document',
    enabled: true,
    entryPage: {
      id: ENTRY_PAGE_ID,
      title: 'Release Checklist',
      type: 'DOCUMENT',
      contentMode: 'markdown',
      content: 'Step 1: run tests',
      isTrashed: false,
      driveId: 'drv9zmbrgj3atz4a98xxat96',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPagesFindMany.mockResolvedValue([]);
  mockCommandsFindMany.mockResolvedValue([]);
  mockCanUserViewPage.mockResolvedValue(true);
  mockIsUserDriveMember.mockResolvedValue(true);
  mockBatchPermissions.mockImplementation(
    async (_userId, pageIds) =>
      new Map(
        pageIds.map((id) => [
          id,
          { canView: true, canEdit: false, canShare: false, canDelete: false },
        ])
      )
  );
});

describe('planCommandExecutions', () => {
  it('returns an empty array (and touches no I/O) when the message has no command token', async () => {
    const plans = await planCommandExecutions('just a plain message', SENDER);
    expect(plans).toEqual([]);
    expect(mockCommandsFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a malformed command id before it reaches any DB operation', async () => {
    const [plan] = await planCommandExecutions("/[evil](id'; DROP TABLE--:command)", SENDER);
    expect(plan).toEqual({
      kind: 'skip',
      commandId: "id'; DROP TABLE--",
      label: 'evil',
      reason: 'not_found',
    });
    expect(mockCommandsFindFirst).not.toHaveBeenCalled();
  });

  it('skips with not_found when the command does not exist', async () => {
    mockCommandsFindFirst.mockResolvedValue(undefined);
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toEqual({ kind: 'skip', commandId: CMD_ID, label: 'release-checklist', reason: 'not_found' });
  });

  it("skips with not_found (no leak) for another user's personal command", async () => {
    mockCommandsFindFirst.mockResolvedValue(personalCommandRow({ userId: 'someone-else' }));
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toMatchObject({ kind: 'skip', reason: 'not_found' });
    // Must not even evaluate page access for a command the sender can't use
    expect(mockCanUserViewPage).not.toHaveBeenCalled();
  });

  it('skips with not_found (no leak) for a drive command when the sender is not a member', async () => {
    mockIsUserDriveMember.mockResolvedValue(false);
    mockCommandsFindFirst.mockResolvedValue(
      personalCommandRow({ userId: null, driveId: 'drv9zmbrgj3atz4a98xxat96' })
    );
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toMatchObject({ kind: 'skip', reason: 'not_found' });
    expect(mockIsUserDriveMember).toHaveBeenCalledWith(SENDER, 'drv9zmbrgj3atz4a98xxat96');
  });

  it('skips with disabled for a usable but disabled command', async () => {
    mockCommandsFindFirst.mockResolvedValue(personalCommandRow({ enabled: false }));
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toMatchObject({ kind: 'skip', reason: 'disabled' });
  });

  it('skips with page_trashed when the entry page is in the trash', async () => {
    mockCommandsFindFirst.mockResolvedValue(
      personalCommandRow({ entryPage: { ...personalCommandRow().entryPage, isTrashed: true } })
    );
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toMatchObject({ kind: 'skip', reason: 'page_trashed' });
  });

  it('re-checks entry-page access at use time and skips with no_access', async () => {
    mockCanUserViewPage.mockResolvedValue(false);
    mockCommandsFindFirst.mockResolvedValue(personalCommandRow());
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toMatchObject({ kind: 'skip', reason: 'no_access' });
    expect(mockCanUserViewPage).toHaveBeenCalledWith(SENDER, ENTRY_PAGE_ID);
  });

  it('injects a personal command: serialized entry page + viewable children manifest', async () => {
    mockCommandsFindFirst.mockResolvedValue(personalCommandRow());
    mockPagesFindMany.mockResolvedValue([
      { id: 'child1aaaaaaaaaaaaaaaaaa', title: 'Rollback Plan', type: 'DOCUMENT' },
      { id: 'child2aaaaaaaaaaaaaaaaaa', title: 'Secret Notes', type: 'DOCUMENT' },
    ]);
    mockCanUserViewPage.mockImplementation(async (_userId: string, pageId: string) => {
      return pageId !== 'child2aaaaaaaaaaaaaaaaaa';
    });

    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toEqual({
      kind: 'inject',
      injection: {
        commandId: CMD_ID,
        trigger: 'release-checklist',
        label: 'release-checklist',
        scope: 'user',
        description: 'Run the release checklist.',
        entryPage: {
          id: ENTRY_PAGE_ID,
          title: 'Release Checklist',
          type: 'DOCUMENT',
          serializedContent: 'Step 1: run tests',
        },
        children: [{ id: 'child1aaaaaaaaaaaaaaaaaa', title: 'Rollback Plan', type: 'DOCUMENT' }],
      },
    });
  });

  it('injects a drive command for a member with scope drive', async () => {
    mockCommandsFindFirst.mockResolvedValue(
      personalCommandRow({ userId: null, driveId: 'drv9zmbrgj3atz4a98xxat96' })
    );
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan).toMatchObject({ kind: 'inject', injection: { scope: 'drive' } });
  });

  it('points the AI at read_page for structured entry page types instead of inlining', async () => {
    mockCommandsFindFirst.mockResolvedValue(
      personalCommandRow({
        entryPage: { ...personalCommandRow().entryPage, type: 'TASK_LIST', contentMode: null },
      })
    );
    const [plan] = await planCommandExecutions(tokenContent(), SENDER);
    expect(plan?.kind).toBe('inject');
    if (plan?.kind === 'inject') {
      expect(plan.injection.entryPage?.serializedContent).toContain('read_page');
    }
  });

  it('injects a built-in command from the registry without a command-row lookup', async () => {
    const [plan] = await planCommandExecutions('/[help](builtin:help:command) what can I do', SENDER);
    expect(plan).toMatchObject({
      kind: 'inject',
      injection: { scope: 'builtin', trigger: 'help', entryPage: null, children: [] },
    });
    expect(mockCommandsFindFirst).not.toHaveBeenCalled();
  });

  it('skips with not_found for an unknown built-in trigger', async () => {
    const [plan] = await planCommandExecutions('/[nope](builtin:nope:command) hi', SENDER);
    expect(plan).toMatchObject({ kind: 'skip', reason: 'not_found' });
    expect(mockCommandsFindFirst).not.toHaveBeenCalled();
  });

  describe('/help dynamic section', () => {
    const HELP_TOKEN = '/[help](builtin:help:command) what can I do here?';
    const DRIVE_ID = 'drv9zmbrgj3atz4a98xxat96';

    const personalListRow = (trigger: string) => ({
      id: `user-${trigger}`,
      userId: SENDER,
      driveId: null,
      trigger,
      description: `Personal ${trigger}`,
      entryPageId: `page-${trigger}`,
      type: 'document',
      enabled: true,
      entryPage: { driveId: 'anywhere', isTrashed: false },
    });

    const driveListRow = (trigger: string) => ({
      id: `drive-${trigger}`,
      userId: null,
      driveId: DRIVE_ID,
      trigger,
      description: `Drive ${trigger}`,
      entryPageId: `page-${trigger}`,
      type: 'document',
      enabled: true,
      entryPage: { driveId: DRIVE_ID, isTrashed: false },
    });

    it("injects the sender's actual commands (builtins + personal + drive) in drive context", async () => {
      mockCommandsFindMany
        .mockResolvedValueOnce([personalListRow('release-checklist')])
        .mockResolvedValueOnce([driveListRow('standup')]);

      const [plan] = await planCommandExecutions(HELP_TOKEN, SENDER, { driveId: DRIVE_ID });

      expect(plan?.kind).toBe('inject');
      if (plan?.kind !== 'inject') return;
      expect(plan.injection.dynamicContent).toBeDefined();
      const section = plan.injection.dynamicContent as string;
      expect(section).toContain('/help');
      expect(section).toContain('/release-checklist');
      expect(section).toContain('Personal release-checklist');
      expect(section).toContain('/standup');
      expect(section).toContain('Drive standup');
      expect(mockIsUserDriveMember).toHaveBeenCalledWith(SENDER, DRIVE_ID);
    });

    it('lists only builtins + personal commands when there is no drive context', async () => {
      mockCommandsFindMany.mockResolvedValueOnce([personalListRow('release-checklist')]);

      const [plan] = await planCommandExecutions(HELP_TOKEN, SENDER);

      expect(plan?.kind).toBe('inject');
      if (plan?.kind !== 'inject') return;
      const section = plan.injection.dynamicContent as string;
      expect(section).toContain('/release-checklist');
      // Exactly one command query: personal only, no drive lookup
      expect(mockCommandsFindMany).toHaveBeenCalledTimes(1);
      expect(mockIsUserDriveMember).not.toHaveBeenCalled();
    });

    it('drops drive commands when the sender is not a member of the context drive', async () => {
      mockIsUserDriveMember.mockResolvedValue(false);
      mockCommandsFindMany.mockResolvedValueOnce([personalListRow('mine')]);

      const [plan] = await planCommandExecutions(HELP_TOKEN, SENDER, { driveId: DRIVE_ID });

      expect(plan?.kind).toBe('inject');
      if (plan?.kind !== 'inject') return;
      expect(plan.injection.dynamicContent).toContain('/mine');
      expect(mockCommandsFindMany).toHaveBeenCalledTimes(1);
    });

    it('degrades to the static description (no dynamic section, no throw) when loading fails', async () => {
      mockCommandsFindMany.mockRejectedValue(new Error('db exploded'));

      const [plan] = await planCommandExecutions(HELP_TOKEN, SENDER, { driveId: DRIVE_ID });

      expect(plan).toMatchObject({
        kind: 'inject',
        injection: { scope: 'builtin', trigger: 'help', entryPage: null },
      });
      if (plan?.kind === 'inject') {
        expect(plan.injection.dynamicContent).toBeUndefined();
        expect(plan.injection.description.length).toBeGreaterThan(0);
      }
    });
  });

  it('omits that command\'s plan (no throw) on unexpected resolution errors', async () => {
    mockCommandsFindFirst.mockRejectedValue(new Error('db exploded'));
    const plans = await planCommandExecutions(tokenContent(), SENDER);
    expect(plans).toEqual([]);
  });

  describe('multiple commands in one message', () => {
    const OTHER_CMD_ID = 'ozmbrgj3atz4a98xxat96iws';

    it('resolves two distinct commands independently, in document order', async () => {
      mockCommandsFindFirst
        .mockResolvedValueOnce(personalCommandRow())
        .mockResolvedValueOnce(
          personalCommandRow({
            id: OTHER_CMD_ID,
            trigger: 'other',
            entryPage: { ...personalCommandRow().entryPage, title: 'Other Page' },
          })
        );

      const plans = await planCommandExecutions(
        `/[release-checklist](${CMD_ID}:command) then /[other](${OTHER_CMD_ID}:command)`,
        SENDER
      );

      expect(plans).toHaveLength(2);
      expect(plans[0]).toMatchObject({ kind: 'inject', injection: { commandId: CMD_ID } });
      expect(plans[1]).toMatchObject({ kind: 'inject', injection: { commandId: OTHER_CMD_ID } });
    });

    it('resolves one command and skips another (nonexistent) in the same message, without one affecting the other', async () => {
      mockCommandsFindFirst
        .mockResolvedValueOnce(personalCommandRow())
        .mockResolvedValueOnce(undefined);

      const plans = await planCommandExecutions(
        `/[release-checklist](${CMD_ID}:command) then /[gone](${OTHER_CMD_ID}:command)`,
        SENDER
      );

      expect(plans).toHaveLength(2);
      expect(plans[0]).toMatchObject({ kind: 'inject', injection: { commandId: CMD_ID } });
      expect(plans[1]).toEqual({
        kind: 'skip',
        commandId: OTHER_CMD_ID,
        label: 'gone',
        reason: 'not_found',
      });
    });

    it('an unexpected error resolving one command does not prevent the other from resolving', async () => {
      mockCommandsFindFirst
        .mockRejectedValueOnce(new Error('db exploded'))
        .mockResolvedValueOnce(personalCommandRow({ id: OTHER_CMD_ID, trigger: 'other' }));

      const plans = await planCommandExecutions(
        `/[release-checklist](${CMD_ID}:command) then /[other](${OTHER_CMD_ID}:command)`,
        SENDER
      );

      // The erroring command's plan is omitted entirely (same degrade
      // philosophy as the single-command case); the other still resolves.
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ kind: 'inject', injection: { commandId: OTHER_CMD_ID } });
    });

    it('preserves document order for the surviving plans when a MIDDLE command (of three) errors unexpectedly', async () => {
      const THIRD_CMD_ID = 'thirdzmbrgj3atz4a98xxat9';
      mockCommandsFindFirst
        .mockResolvedValueOnce(personalCommandRow({ trigger: 'first' }))
        .mockRejectedValueOnce(new Error('db exploded'))
        .mockResolvedValueOnce(personalCommandRow({ id: THIRD_CMD_ID, trigger: 'third' }));

      const plans = await planCommandExecutions(
        `/[first](${CMD_ID}:command) then /[second](${OTHER_CMD_ID}:command) then /[third](${THIRD_CMD_ID}:command)`,
        SENDER
      );

      // The middle command's plan is omitted; the first and third stay in
      // their original relative order (Promise.all + filter preserve input
      // order deterministically, but this pins it as an explicit contract
      // that buildCommandPromptSection's block-ordering guarantee depends on).
      expect(plans).toHaveLength(2);
      expect(plans[0]).toMatchObject({ kind: 'inject', injection: { commandId: CMD_ID } });
      expect(plans[1]).toMatchObject({ kind: 'inject', injection: { commandId: THIRD_CMD_ID } });
    });
  });
});
