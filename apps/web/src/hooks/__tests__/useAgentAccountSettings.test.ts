/**
 * Slice 2 — `sendAccountChange`: a change that widens comes back 401
 * `step_up_required`; the client then runs the step-up ceremony bound to THAT
 * account and sends the same change again with the grant. Any other failure is
 * the caller's to show; with no passkey, the change is parked for the
 * magic-link return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAttemptStepUp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/step-up-ceremony', () => ({ attemptStepUp: mockAttemptStepUp }));

import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { PENDING_ACCOUNT_CHANGE_KEY, sendAccountChange, takePendingAccountChange } from '../useAgentAccountSettings';

const change = { accountId: 'acct_1', method: 'PATCH' as const, url: '/api/agent-accounts/acct_1', body: { allowedOrigins: ['https://a.example.com'] } };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('sendAccountChange', () => {
  it('given a change that narrows, should send it once and never ask for step-up', async () => {
    const send = vi.fn().mockResolvedValue('done');
    const actual = { result: await sendAccountChange(change, send), sends: send.mock.calls.length, asked: mockAttemptStepUp.mock.calls.length };
    expect(actual).toEqual({ result: 'done', sends: 1, asked: 0 });
  });

  it('given step_up_required, should run the ceremony bound to this account and resend the same change with the grant', async () => {
    const send = vi.fn().mockRejectedValueOnce(new ApiRequestError('step_up_required', 401)).mockResolvedValueOnce('done');
    mockAttemptStepUp.mockResolvedValue({ status: 'ready', stepUpToken: 'grant_1' });
    const result = await sendAccountChange(change, send);
    const actual = { result, binding: mockAttemptStepUp.mock.calls[0]?.[0], resent: send.mock.calls[1]?.[0] };
    expect(actual).toEqual({ result: 'done', binding: { action: 'agent_account_widen', accountId: 'acct_1' }, resent: { ...change.body, stepUpToken: 'grant_1' } });
  });

  it('given no passkey, should park the change for the email link and report awaiting_email', async () => {
    const send = vi.fn().mockRejectedValueOnce(new ApiRequestError('step_up_required', 401));
    mockAttemptStepUp.mockResolvedValue({ status: 'awaiting_email' });
    const result = await sendAccountChange(change, send);
    const stored = localStorage.getItem(PENDING_ACCOUNT_CHANGE_KEY) !== null;
    // localStorage, so the emailed link opening in a NEW tab still finds it; taken once, and never after it expires.
    const actual = { result, stored, taken: takePendingAccountChange(Date.now()), again: takePendingAccountChange(Date.now()) };
    expect(actual).toEqual({ result: 'awaiting_email', stored: true, taken: change, again: null });
  });

  it('given a parked change past its lifetime, should not hand it back', () => {
    localStorage.setItem(PENDING_ACCOUNT_CHANGE_KEY, JSON.stringify({ change, expiresAt: Date.now() - 1 }));
    expect(takePendingAccountChange(Date.now())).toBeNull();
  });

  it('given any other refusal, should rethrow it without asking for step-up', async () => {
    const send = vi.fn().mockRejectedValue(new ApiRequestError('conflict', 409));
    await expect(sendAccountChange(change, send)).rejects.toThrow('conflict');
    expect(mockAttemptStepUp).not.toHaveBeenCalled();
  });
});
