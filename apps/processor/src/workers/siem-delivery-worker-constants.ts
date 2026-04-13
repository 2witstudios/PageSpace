/**
 * Constants shared between the SIEM delivery worker and its preflight/loader
 * helpers. Extracted to a standalone module so the worker → preflight →
 * anchor-loader → worker import cycle stays broken: constants live here, and
 * both the worker and its helpers import from this file instead of each other.
 */

/**
 * Stored in siem_delivery_cursors.lastDeliveredId when a cursor is first
 * initialized for a new source. The schema CHECK constraint requires
 * (lastDeliveredId, lastDeliveredAt) to be both null or both non-null; Phase
 * 7 of the dual-read plan requires the cursor to plant at NOW() with zero
 * backfill, so we need a non-null placeholder until the first real row is
 * delivered. Real row ids are cuids and cannot collide with this sentinel.
 */
export const CURSOR_INIT_SENTINEL = '__cursor_init__';
