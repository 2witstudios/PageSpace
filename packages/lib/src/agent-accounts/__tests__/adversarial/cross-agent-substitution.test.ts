import { describe, it } from 'vitest';

// Threat model A3 (ASI03). Table rows over verifyGrant / decideAccountAccess first; I/O cases last (Control Board §7.7).

describe('adversarial: cross-agent-substitution', () => {
  it.todo('given a grant issued for agent page A presented for a run driven by agent page B, should deny (tenant/binding mismatch)');
  it.todo('given a grant issued for conversation C1 presented on run R2 of conversation C2, should deny');
  it.todo('given a user-owned account bound to a shared agent and a different member invoking that agent, should return use false and issue no grant');
  it.todo('given a drive-scoped MCP token whose ceiling excludes the account drive, should read the account as nonexistent (ceiling first) [B0 B-10]');
  it.todo('given a grant for account X and a request naming account Y in resources, should return digest_mismatch');
  it.todo('given the same human, two agent pages, and a delegation for only one, should deny the other with no_delegation');
});
