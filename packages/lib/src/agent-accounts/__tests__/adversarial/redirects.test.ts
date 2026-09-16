import { describe, it } from 'vitest';

// Threat model C2, B0 High (D-28) (ASI02). Credentialed redirects are denied initially.

describe('adversarial: redirects', () => {
  it.todo('given a 302 to another origin from a credentialed request, should not follow and should report the refusal');
  it.todo('given a 302 to the same origin, should re-authorize the new path against the grant resources before following');
  it.todo('given a redirect that would change the method (303) on a write, should refuse');
  it.todo('given a redirect chain longer than the executor cap, should refuse');
  it.todo('given an explicitly configured transition with destination-specific credentials (later), should never forward the original auth header');
});
