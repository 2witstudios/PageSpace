import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  avatarGroupClass,
  avatarGroupFaceClass,
  avatarGroupRestClass,
} from './avatar-group-class';

describe('avatar group classes', () => {
  test('row, overlapping face and the rest count', () => {
    assert({
      given: 'the parts of an avatar group',
      should:
        'lay the faces in an unclipped row, pull each after the first back by the overlap, and set the count small and faint',
      actual: [avatarGroupClass, avatarGroupFaceClass, avatarGroupRestClass],
      expected: [
        'flex flex-none items-center',
        'flex -ml-avatar-overlap first:ml-0',
        'ml-1 text-2xs text-ink-faint tabular-nums',
      ],
    });
  });

  test('nothing clips', () => {
    assert({
      given: 'the group row and its face slots',
      should: 'never hide overflow, so the ringed faces overlap whole',
      actual: [avatarGroupClass, avatarGroupFaceClass].filter((list) =>
        /\boverflow-/.test(list),
      ),
      expected: [],
    });
  });
});
