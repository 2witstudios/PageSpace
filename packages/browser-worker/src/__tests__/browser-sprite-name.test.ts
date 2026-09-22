import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { browserSpriteName } from '../browser-sprite-name.js';

describe('browserSpriteName', () => {
  it('derives one short DNS-safe label per session', () => {
    const long = `bws_${'a1'.repeat(40)}`;
    assert({
      given: 'a session id with an underscore prefix, and one far longer than a label allows',
      should: 'give a lowercase bws- name, cut to the 48-character label budget',
      actual: [browserSpriteName('bws_0123ABCdef'), browserSpriteName(long)],
      expected: ['bws-0123abcdef', `bws-${'a1'.repeat(22)}`],
    });
  });
});
