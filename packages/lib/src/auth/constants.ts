/**
 * Authentication constants shared across the application
 */

/**
 * Default session duration: 7 days in milliseconds
 * Used for web sessions and OAuth authentication flows
 */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bcrypt cost factor for password hashing.
 * Must be consistent across signup and password-change flows.
 */
export const BCRYPT_COST = 12;
