import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderTaskActivity } from './task-activity.render';
import type { ActivityRow } from './task-activity';

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 'a1',
  actor: 'Dana',
  action: 'edited this task',
  time: '2m',
  byImago: false,
  accountType: null,
  ...overrides,
});

describe('renderTaskActivity() agent marker (Agent Signup Phase 2c)', () => {
  test('agent actor', () => {
    const html = renderToString(renderTaskActivity([row({ actor: 'Helper', accountType: 'agent' })]));
    assert({
      given: 'an activity by an agent account',
      should: 'render the agent marker beside the actor',
      actual: html.includes('aria-label="AI agent account"') && html.includes('Helper'),
      expected: true,
    });
  });

  test('human actor', () => {
    assert({
      given: 'an activity by a human',
      should: 'render exactly what an unmarked row renders',
      actual: renderToString(renderTaskActivity([row({ accountType: 'human' })])),
      expected: renderToString(renderTaskActivity([row()])),
    });
  });

  test('no marker for a human', () => {
    assert({
      given: 'an activity by a human',
      should: 'render no agent marker',
      actual: renderToString(renderTaskActivity([row({ accountType: 'human' })])).includes('AI agent account'),
      expected: false,
    });
  });
});

describe('renderTaskActivity() Imago marker', () => {
  test('a change by Imago', () => {
    assert({
      given: 'an activity Imago made',
      should: 'mark it with Imago’s orb at glyph size',
      actual: renderToString(renderTaskActivity([row({ actor: 'Imago', byImago: true })])).includes('data-imago-orb="glyph"'),
      expected: true,
    });
  });

  test('a change by a person', () => {
    assert({
      given: 'an activity a person made',
      should: 'draw no orb',
      actual: renderToString(renderTaskActivity([row()])).includes('data-imago-orb'),
      expected: false,
    });
  });
});
