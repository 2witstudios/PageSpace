import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { isImagoPost } from './author-avatar';

describe('isImagoPost()', () => {
  test('who posted', () => {
    assert({
      given: "Imago's post, another agent's, a person's, and Imago's before its page id loads",
      should: "pick out Imago's alone",
      actual: [
        isImagoPost({ agent: true, authorKey: 'u1:agent:p-imago' }, 'p-imago'),
        isImagoPost({ agent: true, authorKey: 'u1:agent:p-support' }, 'p-imago'),
        isImagoPost({ agent: false, authorKey: 'u1' }, 'p-imago'),
        isImagoPost({ agent: true, authorKey: 'u1:agent:p-imago' }, null),
      ],
      expected: [true, false, false, false],
    });
  });
});
