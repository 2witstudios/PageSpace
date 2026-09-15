import { describe, it } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { gatedIntegrationToolNames } from '../integration-approval';

describe('gatedIntegrationToolNames', () => {
  it('gates non-read integration tools and leaves reads alone', () => {
    const gated = gatedIntegrationToolNames([
      'int__github__list_repos',
      'int__slack__list_channels',
      'int__slack__send_message',
      'read_page',
      'trash_page',
    ]);
    assert({
      given: 'a github read, a slack read, a slack write, and two PageSpace tools',
      should: 'gate only the slack write (PageSpace tools are not integration tools)',
      actual: [...gated],
      expected: ['int__slack__send_message'],
    });
  });

  it('resolves a multi-connection name by stripping the trailing connection segment', () => {
    assert({
      given: 'a read tool with a connection suffix',
      should: 'not be gated',
      actual: gatedIntegrationToolNames(['int__github__list_repos__abcd1234']).size,
      expected: 0,
    });
    assert({
      given: 'a write tool with a connection suffix',
      should: 'be gated',
      actual: gatedIntegrationToolNames(['int__slack__send_message__abcd1234']).has('int__slack__send_message__abcd1234'),
      expected: true,
    });
  });

  it('gates what it cannot resolve (unknown provider, unknown tool id, malformed name)', () => {
    assert({
      given: 'names the registry cannot resolve',
      should: 'all be gated',
      actual: [...gatedIntegrationToolNames(['int__nope__anything', 'int__github__not_a_tool', 'int__github'])],
      expected: ['int__nope__anything', 'int__github__not_a_tool', 'int__github'],
    });
  });
});
