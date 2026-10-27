/**
 * Pure-leaf constants for the magic-link flow. Lives in its own file so the
 * pure-core invites pipes can import the expiry default without transitively
 * pulling in `magic-link-service.ts` (which imports drizzle + the DB pool at
 * module load).
 */

export const MAGIC_LINK_EXPIRY_MINUTES = 5;
