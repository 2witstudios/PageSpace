import { describe, expect, it } from 'vitest';
import { classifyHttpError } from '@pagespace/sdk';
import { formatCliError } from '../format-error.js';
import { callSdk } from '../commands/sdk-error.js';

describe('CLI error output for an org sign-in denial (D-OW-45)', () => {
  it('SEC-2 (partial) strong sign-in tells the person to log in again with a passkey', () => {
    const err = classifyHttpError(403, {}, { error: 'Refused', code: 'org_strong_sign_in_required', orgId: 'org_nw' });
    expect(formatCliError(err)).toBe('Refused\nThis organization requires strong sign-in. Run "pagespace login" and sign in with a passkey (fingerprint, face or PIN), then try again.');
  });

  it('SEC-3 (partial) a sign-in that is too old tells the person to log in again', () => {
    const err = classifyHttpError(403, {}, { error: 'Refused', code: 'org_reauthentication_required' });
    expect(formatCliError(err)).toBe('Refused\nThis organization requires a recent sign-in. Run "pagespace login" again, then try again.');
  });

  it('any other failure prints its message alone', () => {
    expect(formatCliError(classifyHttpError(403, {}, { error: 'Nope', code: 'insufficient_role' }))).toBe('Nope');
    expect(formatCliError('plain')).toBe('plain');
  });

  it('SEC-2 (partial) every verb that calls the SDK through callSdk prints the hint', async () => {
    const out: string[] = [];
    const result = await callSdk({ write: (s: string) => { out.push(s); } }, async () => {
      throw classifyHttpError(403, {}, { error: 'Refused', code: 'org_strong_sign_in_required' });
    });
    expect(result).toEqual({ ok: false });
    expect(out.join('')).toContain('pagespace login');
  });
});
