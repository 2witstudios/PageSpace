import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import { messagesPlugin } from './messages-plugin';

const { restoreMessageGroups, toggleMessageGroup } = messagesPlugin.transactions;

describe('messagesPlugin', () => {
  test('folding groups', () => {
    const initial = createInitialState();
    const folded = toggleMessageGroup(initial, 'direct');
    assert({
      given: 'nothing folded, then Direct messages toggled twice, then a saved list restored',
      should: 'fold it, open it again, and take the saved list as it is',
      actual: [
        initial.resources.collapsedMessageGroups,
        folded.resources.collapsedMessageGroups,
        toggleMessageGroup(folded, 'direct').resources.collapsedMessageGroups,
        restoreMessageGroups(initial, ['drive:d1']).resources.collapsedMessageGroups,
      ],
      expected: [[], ['direct'], [], ['drive:d1']],
    });
  });
});
