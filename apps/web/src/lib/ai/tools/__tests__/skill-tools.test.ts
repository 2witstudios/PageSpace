import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutionContext } from '../../core/types';

const { mockLoadAvailableCommands, mockIsUserDriveMember, mockResolveBuiltin, mockResolveById } =
  vi.hoisted(() => ({
    mockLoadAvailableCommands: vi.fn(),
    mockIsUserDriveMember: vi.fn(),
    mockResolveBuiltin: vi.fn(),
    mockResolveById: vi.fn(),
  }));

vi.mock('@/lib/commands/available-commands', () => ({
  loadAvailableCommands: mockLoadAvailableCommands,
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: mockIsUserDriveMember,
}));

vi.mock('../../core/command-resolver', () => ({
  resolveBuiltinInjection: mockResolveBuiltin,
  resolveCommandInjectionById: mockResolveById,
}));

import { skillTools } from '../skill-tools';

type ExecuteFn = (
  input: { name: string },
  options: { experimental_context?: ToolExecutionContext }
) => Promise<string>;

const execute = skillTools.load_skill.execute as unknown as ExecuteFn;

const baseContext = { userId: 'user-1' } as ToolExecutionContext;

const builtinWinner = (trigger: string) => ({
  id: `builtin:${trigger}`,
  trigger,
  description: 'desc',
  scope: 'builtin' as const,
  type: 'builtin' as const,
  kind: 'skill' as const,
});

const userWinner = (trigger: string, id = 'cmd1234567890') => ({
  id,
  trigger,
  description: 'desc',
  scope: 'user' as const,
  type: 'document' as const,
});

const injectPlan = (trigger: string, dynamicContent?: string) => ({
  kind: 'inject' as const,
  injection: {
    commandId: `builtin:${trigger}`,
    trigger,
    label: trigger,
    scope: 'builtin' as const,
    description: 'desc',
    entryPage: null,
    children: [],
    dynamicContent,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsUserDriveMember.mockResolvedValue(false);
  mockLoadAvailableCommands.mockResolvedValue({ winners: [], shadowed: [] });
});

describe('load_skill', () => {
  it('soft-degrades without authentication context (a load never fails the turn)', async () => {
    const result = await execute({ name: 'spreadsheets' }, {});
    expect(result).toContain('failed');
    expect(result).toContain('no authenticated user');
  });

  it('rejects malformed names before any lookup (hostile-input shape gate)', async () => {
    const result = await execute(
      { name: 'Not A Trigger!' },
      { experimental_context: baseContext }
    );
    expect(result).toContain('No skill or command named');
    expect(mockLoadAvailableCommands).not.toHaveBeenCalled();
  });

  it('loads a builtin skill through resolveBuiltinInjection', async () => {
    mockLoadAvailableCommands.mockResolvedValue({
      winners: [builtinWinner('spreadsheets')],
      shadowed: [],
    });
    mockResolveBuiltin.mockResolvedValue(injectPlan('spreadsheets', '# Sheet skill body'));

    const result = await execute(
      { name: 'spreadsheets' },
      { experimental_context: { ...baseContext, enabledTools: ['edit_sheet_cells'] } }
    );

    expect(mockResolveBuiltin).toHaveBeenCalledWith('spreadsheets', 'user-1', { driveId: null });
    expect(result).toContain('<skill_instructions name="spreadsheets">');
    expect(result).toContain('# Sheet skill body');
    expect(result).toContain('load_skill("spreadsheets")');
  });

  it('loads a builtin skill regardless of the allowlist (requiredTools gates discovery, not load)', async () => {
    mockLoadAvailableCommands.mockResolvedValue({
      winners: [builtinWinner('spreadsheets')],
      shadowed: [],
    });
    mockResolveBuiltin.mockResolvedValue(injectPlan('spreadsheets', 'body'));

    const result = await execute(
      { name: 'spreadsheets' },
      { experimental_context: { ...baseContext, enabledTools: ['read_page'] } }
    );

    expect(result).toContain('<skill_instructions');
    expect(mockResolveBuiltin).toHaveBeenCalled();
  });

  it('treats an unrestricted agent (no enabledTools allowlist) as eligible', async () => {
    mockLoadAvailableCommands.mockResolvedValue({
      winners: [builtinWinner('spreadsheets')],
      shadowed: [],
    });
    mockResolveBuiltin.mockResolvedValue(injectPlan('spreadsheets', 'body'));

    const result = await execute({ name: 'spreadsheets' }, { experimental_context: baseContext });
    expect(result).toContain('<skill_instructions');
  });

  it('loads a user command through the permission-checked by-id resolver', async () => {
    mockLoadAvailableCommands.mockResolvedValue({
      winners: [userWinner('release-checklist')],
      shadowed: [],
    });
    mockResolveById.mockResolvedValue({
      kind: 'inject',
      injection: {
        commandId: 'cmd1234567890',
        trigger: 'release-checklist',
        label: 'release-checklist',
        scope: 'user',
        description: 'desc',
        entryPage: {
          id: 'page-1',
          title: 'Checklist',
          type: 'DOCUMENT',
          serializedContent: 'step 1',
        },
        children: [{ id: 'child-1', title: 'Extra', type: 'DOCUMENT' }],
      },
    });

    const result = await execute(
      { name: 'release-checklist' },
      { experimental_context: baseContext }
    );

    expect(mockResolveById).toHaveBeenCalledWith('cmd1234567890', 'user-1', 'release-checklist');
    expect(result).toContain('step 1');
    expect(result).toContain('NOT loaded');
    expect(result).toContain('child-1');
  });

  it('maps a permission-denied resolution to a soft unavailable message', async () => {
    mockLoadAvailableCommands.mockResolvedValue({
      winners: [userWinner('secret')],
      shadowed: [],
    });
    mockResolveById.mockResolvedValue({
      kind: 'skip',
      commandId: 'cmd1234567890',
      label: 'secret',
      reason: 'no_access',
    });

    const result = await execute({ name: 'secret' }, { experimental_context: baseContext });
    expect(result).toContain('could not be loaded');
    expect(result).toContain('no longer have access');
  });

  it('returns unavailable for an unknown name', async () => {
    const result = await execute({ name: 'nonexistent' }, { experimental_context: baseContext });
    expect(result).toContain('No skill or command named "nonexistent"');
  });

  it('only scopes to the drive when the sender is a member (degrades to personal)', async () => {
    mockIsUserDriveMember.mockResolvedValue(false);
    await execute(
      { name: 'anything' },
      {
        experimental_context: {
          ...baseContext,
          locationContext: { currentDrive: { id: 'drive-1', name: 'D', slug: 'd' } },
        },
      }
    );
    expect(mockLoadAvailableCommands).toHaveBeenCalledWith('user-1', null);

    mockIsUserDriveMember.mockResolvedValue(true);
    await execute(
      { name: 'anything' },
      {
        experimental_context: {
          ...baseContext,
          locationContext: { currentDrive: { id: 'drive-1', name: 'D', slug: 'd' } },
        },
      }
    );
    expect(mockLoadAvailableCommands).toHaveBeenLastCalledWith('user-1', 'drive-1');
  });

  it('degrades unexpected errors to a soft failure string (never throws mid-turn)', async () => {
    mockLoadAvailableCommands.mockRejectedValue(new Error('db down'));
    const result = await execute({ name: 'spreadsheets' }, { experimental_context: baseContext });
    expect(result).toContain('failed unexpectedly');
  });
});
