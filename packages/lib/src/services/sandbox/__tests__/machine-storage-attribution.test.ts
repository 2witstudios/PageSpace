import { describe, it, expect } from 'vitest';
import { assert } from './riteway';
import {
  storageAttributionPageId,
  storageBillingTarget,
  storageSubjectKey,
  type StorageSubject,
  type PageAttributedStorageSubject,
} from '../machine-storage-attribution';

describe('storageAttributionPageId', () => {
  it("attributes a machine's own Sprite to its own page", () => {
    assert({
      given: "a Machine's own persistent Sprite",
      should: 'bill its own page',
      actual: storageAttributionPageId({ kind: 'machine', pageId: 'machine-page-1' }),
      expected: 'machine-page-1',
    });
  });

  it('attributes a branch Sprite to the OWNING machine page, never the branch row', () => {
    assert({
      given: "a branch-terminal's separate Sprite",
      should: 'bill the owning Machine page — the payer key and the per-machine breakdown key',
      actual: storageAttributionPageId({
        kind: 'branch',
        machineBranchId: 'branch-1',
        machinePageId: 'machine-page-1',
      }),
      expected: 'machine-page-1',
    });
  });

  it('gives every branch of a machine the SAME attribution key', () => {
    const branches: PageAttributedStorageSubject[] = [
      { kind: 'branch', machineBranchId: 'branch-a', machinePageId: 'machine-page-1' },
      { kind: 'branch', machineBranchId: 'branch-b', machinePageId: 'machine-page-1' },
    ];

    assert({
      given: 'two branch Sprites of one Machine',
      should: 'roll up under one machine page (they are one Terminal to the user)',
      actual: branches.map(storageAttributionPageId),
      expected: ['machine-page-1', 'machine-page-1'],
    });
  });
});

describe('storageSubjectKey', () => {
  it('namespaces by kind so a branch row id can never collide with a page id', () => {
    const collidingId = 'same-string';

    expect(storageSubjectKey({ kind: 'machine', pageId: collidingId })).not.toBe(
      storageSubjectKey({ kind: 'branch', machineBranchId: collidingId, machinePageId: 'machine-page-1' }),
    );
  });

  it('is stable per subject (an in-process throttle key, not a random id)', () => {
    const subject: StorageSubject = { kind: 'branch', machineBranchId: 'branch-1', machinePageId: 'machine-page-1' };

    assert({
      given: 'the same subject twice',
      should: 'produce the same key',
      actual: storageSubjectKey(subject) === storageSubjectKey({ ...subject }),
      expected: true,
    });
  });
});


describe('storage attribution — promoted project Sprites (issue #2204 phase 7)', () => {
  it('bills a promoted project Sprite to its OWNING machine page, exactly as a branch Sprite is', () => {
    assert({
      given: "a promoted project subject",
      should: 'attribute to the owning machine page, never the project row',
      actual: storageAttributionPageId({ kind: 'project', machineProjectId: 'proj-1', machinePageId: 'machine-1' }),
      expected: 'machine-1',
    });
  });

  it('keys a project subject distinctly from a branch or machine with the same id', () => {
    assert({
      given: 'a project, a branch and a machine that happen to share an id',
      should: 'produce three distinct bookkeeping keys',
      actual: new Set([
        storageSubjectKey({ kind: 'project', machineProjectId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'branch', machineBranchId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'machine', pageId: 'x' }),
      ]).size,
      expected: 3,
    });
  });
});

describe('storage attribution — per-session agent-terminal Sprites (sessions-per-location)', () => {
  it('bills a session Sprite to its OWNING machine page, exactly as a branch/project Sprite is', () => {
    assert({
      given: 'an agent-terminal subject',
      should: 'attribute to the owning machine page, never the session row',
      actual: storageAttributionPageId({ kind: 'agent-terminal', machineAgentTerminalId: 'agt-1', machinePageId: 'machine-1' }),
      expected: 'machine-1',
    });
  });

  it('keys an agent-terminal subject distinctly from a project, branch or machine with the same id', () => {
    assert({
      given: 'an agent-terminal, project, branch and machine that happen to share an id',
      should: 'produce four distinct bookkeeping keys',
      actual: new Set([
        storageSubjectKey({ kind: 'agent-terminal', machineAgentTerminalId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'project', machineProjectId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'branch', machineBranchId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'machine', pageId: 'x' }),
      ]).size,
      expected: 4,
    });
  });
});

describe('storageBillingTarget — agent-session Sprites (Phase 7, added alongside the machine-tree kinds)', () => {
  it('targets the backing agent page when agentPageId is set', () => {
    assert({
      given: 'an agent-session subject with a backing agent page',
      should: 'target that page, exactly like the machine-tree kinds',
      actual: storageBillingTarget({
        kind: 'agent-session',
        sessionId: 'session-1',
        agentPageId: 'agent-page-1',
        ownerId: 'owner-1',
      }),
      expected: { pageId: 'agent-page-1' },
    });
  });

  it('targets the session ownerId directly when agentPageId is null (a global-assistant session)', () => {
    assert({
      given: 'a global-assistant agent-session subject (no backing page)',
      should: 'target the ownerId directly — no page to attribute to',
      actual: storageBillingTarget({
        kind: 'agent-session',
        sessionId: 'session-1',
        agentPageId: null,
        ownerId: 'owner-1',
      }),
      expected: { ownerId: 'owner-1' },
    });
  });

  it('targets every legacy machine-tree kind exactly as storageAttributionPageId does', () => {
    const machine: StorageSubject = { kind: 'machine', pageId: 'p' };
    assert({
      given: "a Machine's own Sprite",
      should: 'target its own page, matching storageAttributionPageId',
      actual: storageBillingTarget(machine),
      expected: { pageId: storageAttributionPageId(machine as PageAttributedStorageSubject) },
    });
  });

  it('keys an agent-session subject distinctly from every machine-tree kind, even sharing an id', () => {
    assert({
      given: 'an agent-session, agent-terminal, project, branch and machine that happen to share an id',
      should: 'produce five distinct bookkeeping keys',
      actual: new Set([
        storageSubjectKey({ kind: 'agent-session', sessionId: 'x', agentPageId: 'm', ownerId: 'o' }),
        storageSubjectKey({ kind: 'agent-terminal', machineAgentTerminalId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'project', machineProjectId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'branch', machineBranchId: 'x', machinePageId: 'm' }),
        storageSubjectKey({ kind: 'machine', pageId: 'x' }),
      ]).size,
      expected: 5,
    });
  });
});
