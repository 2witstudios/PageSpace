/**
 * L2·G2 — the personal-login acknowledgment (Λ3; threat model §9; task entry
 * 2026-09-21 "restated because it is load-bearing").
 *
 * The add-account dialog defaults to "create a dedicated account for this
 * agent". A personal credential is stored only after the explicit
 * acknowledgment "this is a personal login I share with my agent", and the
 * acknowledgment given is what the reference row records.
 */
import { describe, expect, it } from 'vitest';
import type { AccountKind } from '@pagespace/db/schema/agent-accounts';
import { decideAcknowledgment } from '../decide-acknowledgment';

const KINDS: readonly AccountKind[] = ['api_key', 'bearer', 'oauth2', 'session', 'password'];

describe('decideAcknowledgment', () => {
  it('given a dedicated account for the agent, of any kind, should need no acknowledgment and record dedicated_agent_account', () => {
    const actual = KINDS.map((kind) => decideAcknowledgment({ kind, ownership: 'dedicated', acknowledged: false }));
    const expected = KINDS.map(() => ({ ok: true, required: false, acknowledgment: 'dedicated_agent_account' }));
    expect(actual).toEqual(expected);
  });

  it('given a personal login without the explicit acknowledgment, of any kind, should refuse to store it', () => {
    const actual = KINDS.map((kind) => decideAcknowledgment({ kind, ownership: 'personal', acknowledged: false }));
    const expected = KINDS.map(() => ({ ok: false, required: true, reason: 'acknowledgment_required' }));
    expect(actual).toEqual(expected);
  });

  it('given a personal login with the explicit acknowledgment, should record personal_login_acknowledged', () => {
    const actual = KINDS.map((kind) => decideAcknowledgment({ kind, ownership: 'personal', acknowledged: true }));
    const expected = KINDS.map(() => ({ ok: true, required: true, acknowledgment: 'personal_login_acknowledged' }));
    expect(actual).toEqual(expected);
  });

  it('given an acknowledgment flag that is anything but true, should not count it as given', () => {
    const actual = [1, 'true', null, undefined].map((acknowledged) => decideAcknowledgment({ kind: 'api_key', ownership: 'personal', acknowledged: acknowledged as unknown as boolean }).ok);
    const expected = [false, false, false, false];
    expect(actual).toEqual(expected);
  });
});
