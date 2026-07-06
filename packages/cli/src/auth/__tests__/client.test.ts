/**
 * Drift guard for `PAGESPACE_CLI_CLIENT_ID`, inlined in `auth/client.ts` so
 * the published CLI never runtime-imports `@pagespace/lib` (see
 * `credentials/keychain.ts`'s and `operations/roles.ts`'s equivalent
 * inlining, for the same reason). This test-only import from
 * `@pagespace/lib` (a devDependency, never in the published `dist`) asserts
 * the inlined constant matches the canonical value the OAuth provider
 * actually registers as a first-party client
 * (`packages/lib/src/auth/oauth/clients.ts:23`).
 */
import { describe, expect, it } from 'vitest';
import { PAGESPACE_CLI_CLIENT_ID as LIB_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';
import { PAGESPACE_CLI_CLIENT_ID } from '../client.js';

describe('PAGESPACE_CLI_CLIENT_ID — drift guard vs @pagespace/lib canonical client id', () => {
  it('matches the OAuth provider\'s registered first-party client id exactly', () => {
    expect(PAGESPACE_CLI_CLIENT_ID).toBe(LIB_CLIENT_ID);
  });
});
