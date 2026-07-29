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
import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { SESSION_QUOTA_MESSAGE, sessionQuotaExceeded } from '../quota-response';

/**
 * The tests above pin the COPY. These pin the PATH to it — the gap that let the
 * copy be right and unreachable at the same time.
 */
describe('sessionQuotaExceeded', () => {
  const call = (detail?: string) =>
    sessionQuotaExceeded(new Request('https://x.test/api'), 'user_1', 'ses_1', 'route/under/test', detail);

  it('should answer 429, not an authorization status', async () => {
    expect(call().status).toBe(429);
  });

  it('should send the human sentence to the caller even when the provisioner names a code', async () => {
    // The regression: `detail` is ALWAYS set (`quota.reason` === 'concurrency_limit'),
    // so a `detail ?? SESSION_QUOTA_MESSAGE` body rendered the enum into the product.
    const body = await call('concurrency_limit').json();
    expect(body.error).toBe(SESSION_QUOTA_MESSAGE);
  });

  it('should never leak a provisioner code to the caller, whatever it says', async () => {
    const body = await call('some_internal_reason_code').json();
    expect(JSON.stringify(body)).not.toContain('some_internal_reason_code');
  });

  it('should keep the code in the audit trail, where diagnostics belong', () => {
    vi.mocked(auditRequest).mockClear();
    call('concurrency_limit');
    expect(vi.mocked(auditRequest).mock.calls[0][1]).toMatchObject({
      eventType: 'security.rate.limited',
      details: { reason: 'session_limit_reached', route: 'route/under/test', detail: 'concurrency_limit' },
    });
  });
});

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
