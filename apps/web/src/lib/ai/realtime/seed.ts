/**
 * Prior conversation turns, projected onto the `conversation.item.create`
 * client events that give a realtime session its history.
 *
 * This is the mechanism behind "start voice on a thread you were already
 * typing in": the model cannot be handed the thread, so the thread is replayed
 * into the session as text items before it speaks. The SAME function reseeds a
 * fresh session when one hits the API's session ceiling — a reseed is a cold
 * session plus this history, which is exactly what a cold start is.
 *
 * THE CAP IS THE POINT, NOT A GUARD. Realtime cannot take assistant AUDIO as
 * history, so prior turns can only be injected as TEXT (see the item shapes
 * below). Injecting a LARGE text history into a session with audio output
 * enabled is a documented, widely-reported way to get NO AUDIO AT ALL, and it
 * worsens as the history grows. So a seed that is merely "complete" is a seed
 * that silently mutes the call. Both caps below are therefore hard, and the
 * most recent turns are what survive them — latency and liveness win a live
 * turn; completeness happens in the thread afterwards.
 *
 * ITEM SHAPES, and they are NOT symmetric — this is the part that is easy to
 * get wrong and hard to debug, because a wrong content-part type is rejected
 * as an opaque `error` event rather than as a validation message:
 *   - a `role: 'user'` item takes content parts of type `input_text`
 *   - a `role: 'assistant'` item takes content parts of type `text`
 * Verified against the Realtime conversations guide (which shows the user item
 * verbatim) and openai/openai-realtime-api-beta#57, which added assistant/user
 * history injection and documents the same split — along with the limitation
 * that assistant AUDIO items cannot be populated at all, which is precisely
 * why this module exists.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state. The
 * caller loads the messages and hands them in.
 */

/**
 * The minimum a caller must carry per message. Structural on purpose: a full
 * `messages` row (`packages/db/src/schema/conversations.ts`) satisfies it, and
 * so does a hand-built literal in a test, so nothing is forced to construct DB
 * rows to build a seed.
 *
 * `role` is `string` rather than a union because that is what the column is —
 * narrowing happens here, once, instead of at every call site.
 */
export type SeedMessage = {
  readonly role: string;
  readonly content: string;
  /** `messages.createdAt`. Anything `Date`-constructible; absent sorts oldest. */
  readonly createdAt?: Date | string | number | null;
};

/** One `conversation.item.create` client event, ready to send. */
export type SeedEvent = {
  readonly type: 'conversation.item.create';
  readonly item: {
    readonly type: 'message';
    readonly role: 'user' | 'assistant';
    // Not a `readonly` array: this shape must be assignable to
    // `RealtimeSeedEventWire` (the zod-inferred wire type on the attach
    // payload), and a readonly array is not assignable to a mutable one. A
    // drift guard in the tests asserts the two agree in both directions.
    readonly content: { readonly type: 'input_text' | 'text'; readonly text: string }[];
  };
};

export type SeedOptions = {
  /** Hard ceiling on turns emitted. Most recent kept. */
  readonly maxTurns?: number;
  /** Hard ceiling on ESTIMATED tokens across the emitted turns. */
  readonly maxTokens?: number;
};

/**
 * Twenty turns is about ten exchanges — enough for the model to know what
 * "that one" refers to, and short enough to stay well inside the range where
 * seeded sessions reliably still speak.
 */
export const DEFAULT_SEED_MAX_TURNS = 20;

/**
 * ~4k tokens of history. The turn cap alone does not bound anything: twenty
 * turns of pasted document is a different quantity from twenty turns of
 * conversation, and it is the QUANTITY that mutes the session.
 */
export const DEFAULT_SEED_MAX_TOKENS = 4000;

/**
 * Chars per token. A deliberate ESTIMATE, not a measurement: pulling a real
 * tokenizer in would add a dependency (and its vocabulary download) to a
 * module whose only job is to stay conservatively under a soft failure
 * threshold. Four is the usual English approximation and errs toward
 * over-counting on prose, which is the safe direction — over-count and the
 * seed is a little shorter than it could be; under-count and the call goes
 * silent.
 */
export const SEED_CHARS_PER_TOKEN = 4;

/** Deterministic token estimate for one string. See {@link SEED_CHARS_PER_TOKEN}. */
export const estimateSeedTokens = (text: string): number =>
  Math.ceil(text.length / SEED_CHARS_PER_TOKEN);

/** Roles a seed can carry. `system` is deliberately absent — see `buildRealtimeSeed`. */
type SeedRole = 'user' | 'assistant';

const isSeedRole = (role: string): role is SeedRole =>
  role === 'user' || role === 'assistant';

/**
 * Sort key. An absent/unparseable `createdAt` sorts oldest rather than being
 * dropped: a row with no timestamp is still something that was said, and
 * `Array.prototype.sort` is stable, so same-key rows keep their input order.
 */
const sortKey = (message: SeedMessage): number => {
  const raw = message.createdAt;
  if (raw === undefined || raw === null) return Number.NEGATIVE_INFINITY;
  const time = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

/**
 * Cut to a word boundary and say what was left out, so the model is never
 * handed a severed word and never treats a truncation as the end of a turn.
 *
 * Carries no "already short enough" guard: it is called only after the
 * estimate has exceeded the budget, and `ceil(len / 4) > maxTokens` implies
 * `len > maxTokens * 4`, so the guard would be unreachable.
 */
const truncateToTokens = (text: string, maxTokens: number): string => {
  const maxChars = maxTokens * SEED_CHARS_PER_TOKEN;
  const window = text.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(' ');
  const head = (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
  return `${head}… (earlier part of this message omitted)`;
};

const toEvent = (role: SeedRole, text: string): SeedEvent => ({
  type: 'conversation.item.create',
  item: {
    type: 'message',
    role,
    // The asymmetry that has to be right: `input_text` for the user's side,
    // `text` for the assistant's. Never `input_audio` — assistant audio cannot
    // be injected as history at all, which is why the assistant's own turns
    // come back as text even though they were originally spoken.
    content: [{ type: role === 'user' ? 'input_text' : 'text', text }],
  },
});

/**
 * Build the ordered seed for a conversation.
 *
 * Order of operations, and each step is load-bearing:
 *  1. drop anything unseedable — a non user/assistant role (a `system` row is
 *     the app's own instruction, which the session's `instructions` already
 *     carry; replaying it as a turn would have the model answer it) and any
 *     blank/whitespace-only content (an empty item is a turn that says
 *     nothing, and a streaming placeholder is exactly that);
 *  2. sort chronologically, because "the most recent N" is meaningless over an
 *     unordered list and callers should not have to guarantee order;
 *  3. take the most recent `maxTurns`;
 *  4. drop oldest-first until the estimate is inside `maxTokens` — the turn cap
 *     can be satisfied while the token budget is not, so this runs regardless.
 *
 * The one exception to "drop": if the single most recent turn ALONE exceeds the
 * budget, it is truncated rather than dropped. Dropping it would return an
 * empty seed for a conversation that plainly has context — the caller asked to
 * continue a thread, and answering "there is no thread" because its last
 * message was long is the one outcome nobody wants. The cap still holds
 * absolutely; only the way it is met changes.
 *
 * An empty (or entirely unseedable) list returns `[]`: a fresh conversation
 * seeds nothing, and sending zero items is how that is said.
 */
export const buildRealtimeSeed = (
  messages: readonly SeedMessage[],
  options: SeedOptions = {},
): SeedEvent[] => {
  const maxTurns = options.maxTurns ?? DEFAULT_SEED_MAX_TURNS;
  const maxTokens = options.maxTokens ?? DEFAULT_SEED_MAX_TOKENS;

  if (maxTurns <= 0 || maxTokens <= 0) return [];

  const seedable = messages
    .filter((message) => isSeedRole(message.role) && message.content.trim().length > 0)
    .map((message) => ({
      role: message.role as SeedRole,
      text: message.content.trim(),
      key: sortKey(message),
    }));

  const ordered = [...seedable].sort((a, b) => a.key - b.key);
  const window = ordered.slice(Math.max(0, ordered.length - maxTurns));

  let tokens = window.reduce((total, turn) => total + estimateSeedTokens(turn.text), 0);
  let start = 0;
  // `window.length - 1` and not `window.length`: the last turn is never dropped,
  // only truncated below.
  while (tokens > maxTokens && start < window.length - 1) {
    tokens -= estimateSeedTokens(window[start].text);
    start += 1;
  }

  const kept = window.slice(start);
  if (kept.length === 0) return [];

  if (tokens > maxTokens) {
    // Only reachable with exactly one turn left (the loop above stops there).
    const only = kept[0];
    return [toEvent(only.role, truncateToTokens(only.text, maxTokens))];
  }

  return kept.map((turn) => toEvent(turn.role, turn.text));
};
