/**
 * Pure consent core (GDPR / ePrivacy). Client-safe — no Node.js dependencies.
 * Side effects (cookie store, analytics tracker, DB writes) live in thin edges that
 * consume these functions.
 */
export * from './consent-core';
export * from './ai-consent';
export * from './age-gate';
