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
