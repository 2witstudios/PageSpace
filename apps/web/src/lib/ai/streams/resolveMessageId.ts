import { createId } from '@paralleldrive/cuid2';

// Opaque-identifier shape check, deliberately NOT cuid-specific (see below).
// Bounded length + a safe character set: no path separators, whitespace, or
// quoting characters that could misbehave once the id round-trips through a
// URL path segment (edit/delete hit `/conversations/:id/messages/:messageId`).
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves the id to persist a client-originated message under.
 *
 * NOT restricted to cuid2 format. Client ids come from two different
 * generators depending on the sender: `buildUserMessage` mints a cuid2, but
 * surfaces still on the `sendMessage({ text, files })` shorthand
 * (GlobalAssistantView, SidebarChatTab — not yet cut over to
 * `buildUserMessage`, see PR 3 board Assumption B) get the AI SDK's own
 * default id generator, a 16-char string drawn from a mixed-case alphabet
 * that fails `isCuid`'s lowercase-only regex essentially every time. An
 * earlier version of this function required `isCuid` and rejected those —
 * splitting the id `useChat`'s local state and cross-tab broadcasts use from
 * the one actually persisted, so a same-session edit/delete or an
 * `ask_user` result merge would target an id that was never saved (caught in
 * PR review). Validating SHAPE instead of a specific generator's format
 * covers both. The scoped upsert (`saveMessageToDatabase`'s
 * conversation-scoped `WHERE`) is what actually protects against a colliding
 * id crossing conversations — this only guards against something with no
 * business being a primary key at all (absent, empty, unbounded, or
 * containing characters that could break a URL path segment).
 *
 * Mints a fresh id for an absent OR malformed client id, matching the
 * pre-existing `userMessage.id || createId()` fallback for the absent case.
 */
export const resolveMessageId = (clientId: string | undefined | null): string =>
  clientId && SAFE_ID_PATTERN.test(clientId) ? clientId : createId();
