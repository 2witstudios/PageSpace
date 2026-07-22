import { describe, it, expect } from 'vitest';
import { assert } from './riteway';
import {
  storageAttributionPageId,
  storageSubjectKey,
  type StorageSubject,
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
    const branches: StorageSubject[] = [
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
