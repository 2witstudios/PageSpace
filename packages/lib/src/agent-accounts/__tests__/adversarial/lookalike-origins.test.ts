import { describe, it } from 'vitest';

// Threat model C1 (ASI02). Origin normalization as a table.

describe('adversarial: lookalike-origins', () => {
  it.todo('given a punycode/homoglyph host for an allowed origin, should not match after IDNA→ASCII normalization');
  it.todo('given an allowed origin with a different port, should not match (explicit port always compared)');
  it.todo('given a parent-domain cookie in a capture, should be excluded unless the parent is itself allowed');
  it.todo('given a host with trailing dot or mixed case, should normalize to the same canonical origin');
  it.todo('given userinfo before an allowed host, should refuse at canonicalization');
});
