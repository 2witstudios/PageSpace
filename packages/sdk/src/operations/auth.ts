/**
 * Identity (Phase 3 leaf 3 of Sign in with PageSpace; ADR 0004 Decision 4).
 *
 * `auth.me` is the one question an app that signed a user in asks first:
 * who is this? `GET /api/auth/me` answers it for a session, a first-party
 * OAuth token (the CLI) and a third-party token holding `profile` — and
 * answers each differently, by consent, not by credential class
 * (`apps/web/src/app/api/auth/me/route.ts`, `decidePrincipalIdentityDisclosure`):
 *
 *   - session / first-party: the full profile, including `role`,
 *     `emailVerified` and `subscriptionTier`;
 *   - third-party with `profile`: exactly `{ id, name, email, image }` —
 *     "see your name, email, and avatar", and not one field more;
 *   - an `mcp_*` key, or a third-party token without `profile`: refused (403).
 *
 * One schema covers both bodies: the identity core is required, the
 * first-party extras are optional and absent from a `profile` answer.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const authMeOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  /** Relative (`/api/...`) or null — the route never discloses an external avatar URL. */
  image: z.string().nullable(),
  /** Session / first-party only. */
  role: z.string().optional(),
  /** Session / first-party only: ISO timestamp, or null when unverified. */
  emailVerified: z.string().nullable().optional(),
  /** Session / first-party only. */
  subscriptionTier: z.string().optional(),
});

export const getAuthMe = defineOperation({
  name: 'auth.me',
  method: 'GET',
  path: '/api/auth/me',
  inputSchema: z.strictObject({}),
  outputSchema: authMeOutputSchema,
  requiredScope: 'profile',
  description:
    "The signed-in user's identity: id, name, email and avatar (plus role, email verification and plan for a first-party caller). Requires the `profile` scope from a third-party app; refused for scoped MCP keys.",
});
