import { describe, expect, it } from 'vitest';
import { decideDerivedContentAccess } from '../org-derived-content';

describe('derived content (Pulse, memory) is served only to a credential every contributing org admits (D-OW-62)', () => {
  it('SEC-2 (partial) content no org contributed to is always served', () => {
    expect(decideDerivedContentAccess([])).toEqual({ allowed: true });
  });

  it('SEC-2 (partial) one refusing org withholds the whole item and names it', () => {
    expect(decideDerivedContentAccess([
      { orgId: 'org-b', decision: { allowed: true } },
      { orgId: 'org-a', decision: { allowed: false, code: 'org_reauthentication_required' } },
    ])).toEqual({ allowed: false, code: 'org_reauthentication_required', orgIds: ['org-a'] });
  });

  it('SEC-2 (partial) SEC-3 (partial) a passkey requirement anywhere is the code, since a fresh passkey also satisfies a maximum age', () => {
    expect(decideDerivedContentAccess([
      { orgId: 'org-c', decision: { allowed: false, code: 'org_reauthentication_required' } },
      { orgId: 'org-a', decision: { allowed: false, code: 'org_strong_sign_in_required' } },
    ])).toEqual({ allowed: false, code: 'org_strong_sign_in_required', orgIds: ['org-a', 'org-c'] });
  });
});
