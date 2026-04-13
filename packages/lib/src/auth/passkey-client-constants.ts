/**
 * Passkey constants safe to import from browser bundles.
 *
 * Kept separate from passkey-service.ts (which pulls in db/zod/server-only code)
 * so the web app can derive refresh intervals from the same source of truth
 * without dragging server dependencies into the client bundle.
 */

export const PASSKEY_CHALLENGE_EXPIRY_MINUTES = 5;
