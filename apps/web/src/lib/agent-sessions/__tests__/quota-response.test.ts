/**
 * The plan-limit refusal's COPY, not its plumbing.
 *
 * This string reaches a human: an "Add shell" failure renders `body.error`
 * straight into the product. The project's vocabulary rule is that "session" is
 * the AI/tool/backend word, while the UI speaks of agents, conversations and
 * sandboxes — the same object the status chip beside the shell calls a sandbox.
 *
 * Worth pinning because the rule is invisible to every other check. The original
 * wording ("Live agent-session limit reached for your plan — end an existing
 * session…") type-checked, passed lint, passed its route tests, and read
 * perfectly well to whoever wrote it. Only a reader who knows the convention
 * would catch it, and conventions with no test decay.
 */
import { describe, it, expect } from 'vitest';
import { SESSION_QUOTA_MESSAGE } from '../quota-response';

describe('SESSION_QUOTA_MESSAGE', () => {
  it('should not use the backend vocabulary a human never sees', () => {
    expect(SESSION_QUOTA_MESSAGE.toLowerCase()).not.toContain('session');
  });

  it('should name the thing the user can actually act on, and how', () => {
    // A limit message that does not say what clears it leaves the user stuck:
    // this one clears by stopping a sandbox, never by waiting.
    expect(SESSION_QUOTA_MESSAGE.toLowerCase()).toContain('sandbox');
    expect(SESSION_QUOTA_MESSAGE.toLowerCase()).toMatch(/stop|end/);
  });
});
