/**
 * Pure-leaf TTL constants for the step-up ceremony (Phase 8 task
 * d2wicbqyia6u30axz8j2j4ab). Isolated the same way as
 * `magic-link-constants.ts`/`passkey-client-constants.ts` so browser bundles
 * and pure-core decision code can import a TTL without dragging in the
 * drizzle-touching half of the auth module graph.
 */
export const STEP_UP_CHALLENGE_EXPIRY_MINUTES = 2;
export const STEP_UP_GRANT_EXPIRY_MINUTES = 3;
export const STEP_UP_MAGIC_LINK_EXPIRY_MINUTES = 2;
