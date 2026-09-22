import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { isInteractiveApprovalTurn } from '../approval-policy';

describe('isInteractiveApprovalTurn', () => {
  it('a browser session is interactive: there is a human with a card to click', () => {
    assert({
      given: 'session auth',
      should: 'be interactive',
      actual: isInteractiveApprovalTurn({ tokenType: 'session' }),
      expected: true,
    });
  });

  it.each(['service', 'mcp', 'oauth'] as const)('%s auth is headless: nobody can answer, so the turn runs as auto', (tokenType) => {
    assert({
      given: `${tokenType} auth`,
      should: 'not be interactive',
      actual: isInteractiveApprovalTurn({ tokenType }),
      expected: false,
    });
  });
});

/**
 * The bypass this fix closes: `X-Agent-Dispatch-Depth` is a plain request header
 * a browser can set, so `interactive` must never be derived from the depth. Both
 * turns decide interactivity from the AUTHENTICATED principal alone.
 */
describe('the turns derive interactive from auth, never from the dispatch-depth header', () => {
  const turns = ['global-chat-turn.ts', 'page-chat-turn.ts'];
  for (const file of turns) {
    const source = readFileSync(resolve(__dirname, '../../chat-pipeline', file), 'utf8');
    it(`${file} calls isInteractiveApprovalTurn`, () => {
      assert({
        given: file,
        should: 'wire the auth-only predicate',
        actual: source.includes('isInteractiveApprovalTurn('),
        expected: true,
      });
    });
    it(`${file} never ties interactive to agentDispatchDepth`, () => {
      const offending = source
        .split('\n')
        .filter((line) => /interactive\b/i.test(line) && /agentDispatchDepth/.test(line));
      assert({
        given: file,
        should: 'have no line deriving interactive from the depth',
        actual: offending,
        expected: [],
      });
    });
  }
});
