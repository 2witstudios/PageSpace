import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderAgentMark } from './agent-mark.render';
import { AgentMark } from './agent-mark';

describe('renderAgentMark()', () => {
  test('human', () => {
    assert({
      given: 'a human account type',
      should: 'render nothing',
      actual: renderAgentMark({ accountType: 'human' }),
      expected: null,
    });
  });

  test('absent account type', () => {
    assert({
      given: 'no account type (the column default is human)',
      should: 'render nothing',
      actual: [renderAgentMark({}), renderAgentMark({ accountType: null })],
      expected: [null, null],
    });
  });

  test('agent', () => {
    const html = renderToString(renderAgentMark({ accountType: 'agent' }));
    assert({
      given: 'an agent account type',
      should: 'render a labelled Agent marker',
      actual: html.includes('aria-label="AI agent account"') && html.includes('>Agent</span>'),
      expected: true,
    });
  });

  test('AgentMark component', () => {
    assert({
      given: 'the same props',
      should: 'render exactly what renderAgentMark renders',
      actual: renderToString(h(AgentMark, { accountType: 'agent' })),
      expected: renderToString(renderAgentMark({ accountType: 'agent' })),
    });
  });
});
