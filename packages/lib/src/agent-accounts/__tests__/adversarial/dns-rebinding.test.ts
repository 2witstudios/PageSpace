import { describe, it } from 'vitest';

// Threat model C2 (ASI02). Validate DNS and pin the connection; repeat per redirect hop. Executor cases (G2) — I/O.

describe('adversarial: dns-rebinding', () => {
  it.todo('given an origin whose A record changes to a private address between authorization and connect, should refuse the connection (pinned address)');
  it.todo('given a hostname resolving to both a public and a private address, should refuse (all-addresses rule, as the web_fetch shell)');
  it.todo('given a redirect to a host resolving privately, should refuse at that hop');
  it.todo('given a decimal/hex/octal IP literal, should refuse at canonicalization (ip_literal_host)');
});
