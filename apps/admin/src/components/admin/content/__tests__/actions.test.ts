import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { describeTakedownResult } from '../actions';

describe('describeTakedownResult', () => {
  it('says a request that found another run under way changed nothing, rather than "Done"', () => {
    const { ok, message } = describeTakedownResult({ action: 'resume', caseId: 'case-1', status: 'open', inProgress: true });

    expect(ok).toBe(false);
    expect(message).toMatch(/already running/i);
    expect(message).toMatch(/nothing was changed/i);
    expect(message).not.toMatch(/^Done/);
  });

  it('still says "Done" for a takedown that finished', () => {
    expect(describeTakedownResult({ action: 'global', caseId: 'case-1', status: 'actioned' })).toEqual({ ok: true, message: 'Done. Case case-1.' });
  });
});
