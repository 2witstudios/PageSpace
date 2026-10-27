/**
 * ADR 0005 §8 F18, §10.24 — the manage role and the tenant enforced at
 * runtime for rebind, revoke and describe (G1c E3). Written RED before
 * `decide-store-caller.ts` exists (Control Board §7.2).
 */
import { describe, expect, it } from 'vitest';
import type { AccountId, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { SecretRef, StoreChannel, StoreIdentity } from '../store-adapter';
import { decideStoreCaller } from '../decide-store-caller';

const REF: SecretRef = { tenantId: 'drive:d1' as TenantId, accountId: 'acct_1' as AccountId, kind: 'api_key' };
const identity = (channel: StoreChannel, tenantId: TenantId = REF.tenantId): StoreIdentity => ({ tenantId, identityId: 'tenant-identity', channel, blastRadius: 'tenant' });

describe('decideStoreCaller (G1c E3)', () => {
  it('given a manage identity for the ref tenant, should allow a manage-only operation', () => {
    const actual = decideStoreCaller({ identity: identity('manage'), ref: REF, required: 'manage' });
    expect(actual).toEqual({ ok: true });
  });

  it('given any other channel, should refuse identity_refused', () => {
    const channels: readonly StoreChannel[] = ['http-executor', 'relay-runner', 'browser-worker', 'refresh-worker', 'ingress'];
    const actual = channels.map((channel) => decideStoreCaller({ identity: identity(channel), ref: REF, required: 'manage' }));
    expect(actual).toEqual(channels.map(() => ({ ok: false, reason: 'identity_refused' })));
  });

  it('given an identity for another tenant, should refuse not_found before revealing anything about the role', () => {
    const actual = [
      decideStoreCaller({ identity: identity('manage', 'drive:d2' as TenantId), ref: REF, required: 'manage' }),
      decideStoreCaller({ identity: identity('ingress', 'drive:d2' as TenantId), ref: REF, required: 'manage' }),
    ];
    expect(actual).toEqual([
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'not_found' },
    ]);
  });

  it('given a channel value outside the union (assembled at runtime), should refuse identity_refused', () => {
    const actual = decideStoreCaller({ identity: { ...identity('manage'), channel: 'MANAGE' as StoreChannel }, ref: REF, required: 'manage' });
    expect(actual).toEqual({ ok: false, reason: 'identity_refused' });
  });
});
