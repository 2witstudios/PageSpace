/**
 * `messages.source`'s voice value, in a module the BROWSER can import.
 *
 * The definition lives in `@pagespace/db/schema/conversations`, and that is
 * still the source of truth — but client components in this repo do not import
 * from `@pagespace/db/schema` (it drags Drizzle's pg-core into the browser
 * bundle), so the mic glyph cannot read it there. This is the same duplication
 * trade `realtimeToolSchema` and `voiceLocationContextSchema` already make
 * across the web/realtime boundary, with the same mitigation: a drift guard in
 * the tests that imports BOTH and asserts they are the same string. A copy with
 * a test that fails the moment it diverges is a copy that cannot silently rot.
 *
 * Pure: a constant. No I/O, no clock, no randomness, no module-level mutable
 * state.
 */
export const VOICE_MESSAGE_SOURCE = 'voice';
