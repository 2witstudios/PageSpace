/**
 * [D-OW-26] / D-OW-47 addendum: policy keys that set money or a spend source are session-only. The
 * classification lives beside the policy specs (policies-core), one entry per key, so a new key cannot
 * ship unclassified and the route, the read projection and this guard all read the same table.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORG_POLICIES,
  MONEY_POLICY_KEYS,
  ORG_POLICY_KEYS,
  ORG_POLICY_MONEY,
  delegatedPolicyPatchRefusal,
  policiesForDelegatedCredential,
  type MoneyPolicyKey,
} from '../policies-core';

// The MoneyPolicyKey type names exactly the classified money keys (both directions).
const TYPED_MONEY_KEYS: Record<MoneyPolicyKey, true> = { seatAllowanceCents: true, walletFallback: true };

describe('money policy keys ([D-OW-26])', () => {
  it('X-1 (partial) every policy key is classified, and exactly the seat allowance and the wallet fallback touch money', () => {
    expect(Object.keys(ORG_POLICY_MONEY).sort()).toEqual([...ORG_POLICY_KEYS].sort());
    expect(Object.fromEntries(MONEY_POLICY_KEYS.map((key) => [key, ORG_POLICY_MONEY[key]]))).toEqual({
      seatAllowanceCents: 'moves_money',
      walletFallback: 'spend_source',
    });
    expect(Object.keys(TYPED_MONEY_KEYS).sort()).toEqual([...MONEY_POLICY_KEYS].sort());
  });

  it('X-1 (partial) a delegated credential is refused every money key by name, alone or among other keys', () => {
    for (const key of MONEY_POLICY_KEYS) {
      const code = ORG_POLICY_MONEY[key] === 'moves_money' ? 'mcp_token_cannot_move_money' : 'mcp_token_cannot_change_spend_source';
      expect(delegatedPolicyPatchRefusal({ [key]: DEFAULT_ORG_POLICIES[key] })).toMatchObject({ code, key });
      expect(delegatedPolicyPatchRefusal({ publishWeb: false, [key]: DEFAULT_ORG_POLICIES[key] })).toMatchObject({ code, key });
    }
    // Moving money is named first when a patch does both.
    expect(delegatedPolicyPatchRefusal({ walletFallback: 'seat_allowance', seatAllowanceCents: 1 })).toMatchObject({ code: 'mcp_token_cannot_move_money' });
  });

  it('X-1 (partial) a patch of non-money keys is not refused', () => {
    expect(delegatedPolicyPatchRefusal({ publishWeb: false, requireStrongSignIn: true, guests: 'off' })).toBeNull();
    expect(delegatedPolicyPatchRefusal({})).toBeNull();
  });

  it('X-1 (partial) a delegated credential reads the policies without any money key', () => {
    const projected = policiesForDelegatedCredential(DEFAULT_ORG_POLICIES);
    for (const key of MONEY_POLICY_KEYS) expect(projected).not.toHaveProperty(key);
    expect(Object.keys(projected).length).toBe(ORG_POLICY_KEYS.length - MONEY_POLICY_KEYS.length);
  });
});
