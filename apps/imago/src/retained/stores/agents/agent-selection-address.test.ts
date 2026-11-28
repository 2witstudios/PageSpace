import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { agentSelectionAddress } from './agent-selection-address';

describe('agentSelectionAddress()', () => {
  test('a drive’s Console', () => {
    assert({
      given: 'a selection on a drive’s Console',
      should: 'address that drive’s Console screen under /imago',
      actual: agentSelectionAddress('/dashboard/d1/agents?workspace=w1&c=c1', 'd1', '/imago/d1/agents'),
      expected: '/imago/d1/agents?workspace=w1&c=c1',
    });
  });

  test('Home’s Console, with no drive', () => {
    assert({
      given: 'a selection on the every-drive Console, which lives on Home',
      should: 'keep Home’s path and change only the query, never the removed /account/agents',
      actual: [
        agentSelectionAddress('/dashboard/agents?workspace=w1&c=c1', null, '/imago/home/agents'),
        agentSelectionAddress('/dashboard/agents', null, '/imago/home/agents'),
      ],
      expected: ['/imago/home/agents?workspace=w1&c=c1', '/imago/home/agents'],
    });
  });
});
