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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_QUOTA_MESSAGE,
  SESSION_CONVERSATION_LIMIT_MESSAGE,
  sessionQuotaExceeded,
  sessionConversationLimitExceeded,
} from '../quota-response';

const mockAuditRequest = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

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

describe('sessionQuotaExceeded', () => {
  const request = new Request('https://example.test/api/agent-workspaces/ses-1');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a provisioner's raw diagnostic code NEVER reaches the response body — the human sentence does", async () => {
    // Mutation check: this is the live P1 PR #2253 caught — the provisioner's
    // denial always sets a diagnostic enum (`quota.reason`, e.g.
    // 'concurrency_limit'), so restoring the old `detail ?? SESSION_QUOTA_MESSAGE`
    // shape (feeding that enum straight into `error`) makes this assertion fail:
    // the body would read 'concurrency_limit' instead of the sandbox sentence.
    const response = sessionQuotaExceeded(request, 'user-1', 'ses-1', 'agent-workspaces/[workspaceId]', {
      reasonCode: 'concurrency_limit',
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe(SESSION_QUOTA_MESSAGE);
    expect(body.error).not.toContain('concurrency_limit');
  });

  it('records the diagnostic code in the audit row, not the response', () => {
    sessionQuotaExceeded(request, 'user-1', 'ses-1', 'agent-workspaces/[workspaceId]', {
      reasonCode: 'concurrency_limit',
    });

    expect(mockAuditRequest).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        eventType: 'security.rate.limited',
        details: expect.objectContaining({
          reason: 'session_limit_reached',
          route: 'agent-workspaces/[workspaceId]',
          reasonCode: 'concurrency_limit',
        }),
      }),
    );
  });

  it('an already-human message override (e.g. a live count) is used verbatim — not replaced by the generic sentence', async () => {
    // The pre-mint refusal: no workspace row exists yet, so the caller passes
    // null — and the audit row honestly carries NO resourceId, never a
    // fabricated sentinel id.
    const response = sessionQuotaExceeded(request, 'user-1', null, 'agent-sessions', {
      message: 'You have 100 active sessions — end some before starting more.',
    });

    const body = await response.json();
    expect(body.error).toBe('You have 100 active sessions — end some before starting more.');
    const [, audited] = mockAuditRequest.mock.calls[0];
    expect(audited).not.toHaveProperty('resourceId');
  });

  it('with neither reasonCode nor message, falls back to the generic sentence and audits no reason code', () => {
    const response = sessionQuotaExceeded(request, 'user-1', 'ses-1', 'agent-workspaces/[workspaceId]');

    return response.json().then((body) => {
      expect(body.error).toBe(SESSION_QUOTA_MESSAGE);
      const [, details] = mockAuditRequest.mock.calls[0];
      expect(details.details).not.toHaveProperty('reasonCode');
    });
  });
});

describe('sessionConversationLimitExceeded', () => {
  // The PER-SESSION conversation ceiling (`SessionFullError`, PR #2269) — a
  // second quota refusal added to this file alongside the sandbox-count one
  // above. It takes no `detail`/`reasonCode` parameter at all today, so there
  // is currently no path for a diagnostic enum to reach its body — this pins
  // that shape so it can't regress the same way `sessionQuotaExceeded` did:
  // the body is ALWAYS the fixed human sentence, never anything computed or
  // passed through from a caller.
  const request = new Request('https://example.test/api/agent-workspaces/ses-1/conversations');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always answers with the fixed human sentence — there is no parameter that could leak a diagnostic code', async () => {
    const response = sessionConversationLimitExceeded(
      request,
      'user-1',
      'ses-1',
      'agent-workspaces/[workspaceId]/conversations',
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe(SESSION_CONVERSATION_LIMIT_MESSAGE);
    // Guards against ever widening the signature to accept a raw code and
    // splicing it into the body the way the sandbox-quota path once did.
    expect(sessionConversationLimitExceeded.length).toBeLessThanOrEqual(4);
  });

  it('records the conversation-limit reason in the audit row, distinct from the sandbox-quota reason', () => {
    sessionConversationLimitExceeded(request, 'user-1', 'ses-1', 'agent-workspaces/[workspaceId]/conversations');

    expect(mockAuditRequest).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        eventType: 'security.rate.limited',
        details: expect.objectContaining({
          reason: 'session_conversation_limit_reached',
          route: 'agent-workspaces/[workspaceId]/conversations',
        }),
      }),
    );
  });
});
