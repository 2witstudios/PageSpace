import { describe, it, expect } from 'vitest';
import { canViewMachine, canEditMachine, type MachineAccessDeps } from '../machine-access';
import type { MachineActorContext } from '../machine-branches';
import { PageType } from '../../../utils/enums';

const TERMINAL_ID = 'terminal-1';

const actor: MachineActorContext = {
  userId: 'user-1',
  tenantId: 'user-1',
  actorEmail: 'user-1@example.com',
  tier: 'pro',
};

function makeDeps(overrides: Partial<MachineAccessDeps> = {}): MachineAccessDeps {
  return {
    findPageType: async () => PageType.TERMINAL,
    canUserViewPage: async () => true,
    canUserEditPage: async () => true,
    ...overrides,
  };
}

describe('canViewMachine', () => {
  it('allows when the page is a Terminal page and the user can view it', async () => {
    const deps = makeDeps();
    expect(await canViewMachine(deps, actor, TERMINAL_ID)).toBe(true);
  });

  it('denies when the user cannot view the page', async () => {
    const deps = makeDeps({ canUserViewPage: async () => false });
    expect(await canViewMachine(deps, actor, TERMINAL_ID)).toBe(false);
  });

  it('denies when the page does not exist', async () => {
    const deps = makeDeps({ findPageType: async () => null });
    expect(await canViewMachine(deps, actor, 'missing')).toBe(false);
  });

  it('denies when the page exists but is not a Terminal page', async () => {
    const deps = makeDeps({ findPageType: async () => PageType.DOCUMENT });
    expect(await canViewMachine(deps, actor, TERMINAL_ID)).toBe(false);
  });

  it('never calls the permission check for a non-Terminal page', async () => {
    let called = false;
    const deps = makeDeps({
      findPageType: async () => PageType.DOCUMENT,
      canUserViewPage: async () => {
        called = true;
        return true;
      },
    });
    await canViewMachine(deps, actor, TERMINAL_ID);
    expect(called).toBe(false);
  });
});

describe('canEditMachine', () => {
  it('allows when the page is a Terminal page and the user can edit it', async () => {
    const deps = makeDeps();
    expect(await canEditMachine(deps, actor, TERMINAL_ID)).toBe(true);
  });

  it('denies when the user can view but not edit the page', async () => {
    const deps = makeDeps({ canUserViewPage: async () => true, canUserEditPage: async () => false });
    expect(await canEditMachine(deps, actor, TERMINAL_ID)).toBe(false);
  });

  it('denies when the page does not exist', async () => {
    const deps = makeDeps({ findPageType: async () => null });
    expect(await canEditMachine(deps, actor, 'missing')).toBe(false);
  });

  it('denies when the page exists but is not a Terminal page', async () => {
    const deps = makeDeps({ findPageType: async () => PageType.FOLDER });
    expect(await canEditMachine(deps, actor, TERMINAL_ID)).toBe(false);
  });
});
