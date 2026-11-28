/**
 * Drift guard: the SDK inlines the agent grant URNs and client id (the
 * published SDK never runtime-imports `@pagespace/lib`, see `../pkce.ts`).
 * This devDependency-only import asserts the inlined copies match the
 * server's own registration and metadata.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ASSERTION_GRANT_TYPE as LIB_ASSERTION, AGENT_CLAIM_GRANT_TYPE as LIB_CLAIM } from '@pagespace/lib/auth/oauth/metadata';
import { PAGESPACE_AGENT_CLIENT_ID as LIB_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';
import { AGENT_ASSERTION_GRANT_TYPE, AGENT_CLAIM_GRANT_TYPE, PAGESPACE_AGENT_CLIENT_ID } from '../agent-assertion.js';

describe('agent grant constants — drift guard vs @pagespace/lib', () => {
  it('match the server byte for byte', () => {
    expect(AGENT_ASSERTION_GRANT_TYPE).toBe(LIB_ASSERTION);
    expect(AGENT_CLAIM_GRANT_TYPE).toBe(LIB_CLAIM);
    expect(PAGESPACE_AGENT_CLIENT_ID).toBe(LIB_CLIENT_ID);
  });
});
