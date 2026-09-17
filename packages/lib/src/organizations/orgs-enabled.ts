/**
 * Dark-ship switch for every org-facing server surface (Organizations & Wallets,
 * Sequence Spec "Dark shipping"). While false, every /api/orgs route answers 404.
 *
 * A CODE CONSTANT, never an environment variable (D-OW-17): separately deployed
 * apps cannot be trusted to agree on an env flag, so turning orgs on is one commit.
 * It cannot be flipped while B1's temporary GDPR/tenant-export exclusions for org
 * tables exist (scripts/__tests__/orgs-enabled-export-precondition.test.ts, X-2).
 */
export const ORGS_ENABLED: boolean = false;
