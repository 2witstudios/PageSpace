import { describe, it, expect } from 'vitest';
import {
  canViewMachine,
  canEditMachine,
  decideMachineToggleAccess,
  type MachineAccessDeps,
} from '../machine-access';
import { PageType } from '../../../utils/enums';

const MACHINE_ID = 'machine-1';
const ACTOR_USER_ID = 'user-1';

function makeDeps(overrides: Partial<MachineAccessDeps> = {}): MachineAccessDeps {
  return {
    findPageType: async () => PageType.MACHINE,
    canUserViewPage: async () => true,
    canUserEditPage: async () => true,
    ...overrides,
  };
}

describe('canViewMachine', () => {
  it('allows when the page is a Terminal page and the user can view it', async () => {
    const deps = makeDeps();
    expect(await canViewMachine(deps, ACTOR_USER_ID, MACHINE_ID)).toBe(true);
  });

  it('denies when the user cannot view the page', async () => {
    const deps = makeDeps({ canUserViewPage: async () => false });
    expect(await canViewMachine(deps, ACTOR_USER_ID, MACHINE_ID)).toBe(false);
  });

  it('denies when the page does not exist', async () => {
    const deps = makeDeps({ findPageType: async () => null });
    expect(await canViewMachine(deps, ACTOR_USER_ID, 'missing')).toBe(false);
  });

  it('denies when the page exists but is not a Terminal page', async () => {
    const deps = makeDeps({ findPageType: async () => PageType.DOCUMENT });
    expect(await canViewMachine(deps, ACTOR_USER_ID, MACHINE_ID)).toBe(false);
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
    await canViewMachine(deps, ACTOR_USER_ID, MACHINE_ID);
    expect(called).toBe(false);
  });
});

describe('canEditMachine', () => {
  it('allows when the page is a Terminal page and the user can edit it', async () => {
    const deps = makeDeps();
    expect(await canEditMachine(deps, ACTOR_USER_ID, MACHINE_ID)).toBe(true);
  });

  it('denies when the user can view but not edit the page', async () => {
    const deps = makeDeps({ canUserViewPage: async () => true, canUserEditPage: async () => false });
    expect(await canEditMachine(deps, ACTOR_USER_ID, MACHINE_ID)).toBe(false);
  });

  it('denies when the page does not exist', async () => {
    const deps = makeDeps({ findPageType: async () => null });
    expect(await canEditMachine(deps, ACTOR_USER_ID, 'missing')).toBe(false);
  });

  it('denies when the page exists but is not a Terminal page', async () => {
    const deps = makeDeps({ findPageType: async () => PageType.FOLDER });
    expect(await canEditMachine(deps, ACTOR_USER_ID, MACHINE_ID)).toBe(false);
  });
});

describe('decideMachineToggleAccess', () => {
  const bothOn = { allowPageAgents: true, visibleToGlobalAssistant: true };

  it('allows a page agent when allowPageAgents is on', () => {
    expect(decideMachineToggleAccess({ actor: 'page-agent', settings: bothOn })).toEqual({ allowed: true });
  });

  it('denies a page agent with page_agents_disabled when allowPageAgents is off', () => {
    expect(
      decideMachineToggleAccess({
        actor: 'page-agent',
        settings: { allowPageAgents: false, visibleToGlobalAssistant: true },
      }),
    ).toEqual({ allowed: false, code: 'page_agents_disabled' });
  });

  it('allows the global assistant when visibleToGlobalAssistant is on', () => {
    expect(decideMachineToggleAccess({ actor: 'global-assistant', settings: bothOn })).toEqual({ allowed: true });
  });

  it('denies the global assistant with hidden_from_global when visibleToGlobalAssistant is off', () => {
    expect(
      decideMachineToggleAccess({
        actor: 'global-assistant',
        settings: { allowPageAgents: true, visibleToGlobalAssistant: false },
      }),
    ).toEqual({ allowed: false, code: 'hidden_from_global' });
  });

  it('each toggle gates ONLY its own actor kind', () => {
    expect(
      decideMachineToggleAccess({
        actor: 'global-assistant',
        settings: { allowPageAgents: false, visibleToGlobalAssistant: true },
      }),
    ).toEqual({ allowed: true });
    expect(
      decideMachineToggleAccess({
        actor: 'page-agent',
        settings: { allowPageAgents: true, visibleToGlobalAssistant: false },
      }),
    ).toEqual({ allowed: true });
  });
});
