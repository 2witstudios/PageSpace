/**
 * The ONE agent-session contract — zod schemas + inferred types shared by the
 * web API routes, the realtime PTY bridge, and the frontend hooks. No shape in
 * this surface is ever declared twice: if a payload crosses a process boundary,
 * its schema lives here and every side parses with it.
 *
 * Two semantic invariants govern everything downstream, and this module is where
 * they are written down once:
 *
 * 1. **sessionId ≡ conversationId.** A session and a conversation are ONE
 *    object with two audiences: "session" is the tool/backend word (it owns a
 *    sandbox, it is the Sprite-key fold, `agent_sessions.conversationId` is the
 *    primary key), "conversation" is the UI word (what a user opens, `?c=` in
 *    the URL, what `chat_messages` key on). There is therefore NO
 *    session-binding field anywhere in this contract, and none may be added:
 *    the chat body's `conversationId` IS the session address. A DTO that
 *    carried both would immediately raise the "which id?" question this design
 *    exists to delete. User-facing copy says only "conversation" — "session"
 *    never appears in it.
 *
 * 2. **Ids address, names label.** `sessionId` and `shellId` are the addresses:
 *    every wire payload, every tool argument after the spawn, and every Sprite
 *    key folds one of them. `name` is a display label with no addressing role —
 *    worker-session names carry no uniqueness constraint at all, and the
 *    shell-name uniqueness that does exist (`(sessionId, name)`) is there for
 *    unambiguous tab titles, never for lookups. Renaming can therefore never
 *    break a connection, and two identically-named things are never ambiguous.
 */

import { z } from 'zod';

/**
 * The sandbox states the UI and tools discriminate between, and the ONLY four
 * that exist. `'none'` = the session has never acquired a Sprite (the common
 * case — most conversations never touch one); `'starting'` = provisioning is in
 * flight; `'running'` = a Sprite is linked (INCLUDING a hibernating one — idle
 * sandboxes hibernate and wake on demand, which is invisible to the user and so
 * is deliberately not a status of its own); `'ended'` = the session's Sprite was
 * explicitly torn down, the row retained and re-provisionable under the same key.
 */
export const SANDBOX_STATUSES = ['none', 'starting', 'running', 'ended'] as const;

export const sandboxStatusSchema = z.enum(SANDBOX_STATUSES);
export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;

/**
 * The agent types a shell can run. PTY-only by construction: a shell is always a
 * real PTY process, and the session's chat surface is the conversation itself —
 * so the legacy `'pagespace'` chat-surface type has no successor here. New PTY
 * agent CLIs are added as entries; nothing branches on which one it got.
 */
export const SHELL_AGENT_TYPES = ['shell'] as const;

export const shellAgentTypeSchema = z.enum(SHELL_AGENT_TYPES);
export type ShellAgentType = z.infer<typeof shellAgentTypeSchema>;

/** Wire timestamps are ISO-8601 strings; `Date` never crosses the boundary. */
const isoTimestamp = z.string().datetime();

/**
 * One agent session as served to any client.
 *
 * `sessionId` IS the conversation id (invariant 1). `agentPageId` is nullable:
 * null means a global-assistant session, which has no agent page to derive
 * access or billing from — those paths fall back to `ownerId`.
 */
export const agentSessionDtoSchema = z.object({
  /** ≡ the conversation id. The tool address, the `?c=` URL value, and the Sprite-key fold. */
  sessionId: z.string().min(1),
  ownerId: z.string().min(1),
  /** The AI_CHAT page this session belongs to, or null for a global-assistant session. */
  agentPageId: z.string().min(1).nullable(),
  /** Display label only — no uniqueness, never an address. */
  name: z.string(),
  sandboxStatus: sandboxStatusSchema,
  createdAt: isoTimestamp,
  lastActiveAt: isoTimestamp.nullable(),
  /** Stamped when the session was explicitly ended; the row survives for re-provisioning. */
  endedAt: isoTimestamp.nullable(),
});

export type AgentSessionDTO = z.infer<typeof agentSessionDtoSchema>;

/**
 * One named PTY inside its session's shared sandbox.
 *
 * Deliberately carries NO Sprite columns — the inversion vs the legacy
 * per-terminal model: the SESSION owns the sandbox, and every shell in it shares
 * that one Sprite. "Shell" is the only word for this thing; "terminal" survives
 * solely inside xterm internals.
 */
export const shellDtoSchema = z.object({
  /** The wire address. Everything after the spawn addresses a shell by this and nothing else. */
  shellId: z.string().min(1),
  /** ≡ the conversation id of the owning session. */
  sessionId: z.string().min(1),
  ownerId: z.string().min(1),
  /** Tab label. Unique within a session for tab clarity — still not an address. */
  name: z.string().min(1),
  agentType: shellAgentTypeSchema,
  /** Optional per-shell program override; null runs the agent type's default. */
  command: z.string().nullable(),
  createdAt: isoTimestamp,
});

export type ShellDTO = z.infer<typeof shellDtoSchema>;

/**
 * PTY dimension bounds, ported verbatim from the realtime bridge's local
 * `validation.ts` so both sides clamp identically. Out-of-range dimensions are
 * CLAMPED (a browser reporting a huge or tiny viewport is not an error);
 * nonsense — zero, negative, non-finite, non-numeric — is REJECTED.
 */
export const MIN_COLS = 10;
export const MIN_ROWS = 5;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;

export function clampShellDimensions({ cols, rows }: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(cols))),
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows))),
  };
}

const positiveFiniteNumber = z
  .number()
  .refine((value) => Number.isFinite(value) && value > 0, { message: 'must be a positive finite number' });

/**
 * The shell connect payload — the whole address is `{shellId}`.
 *
 * This replaces a compound `{machineId, projectName?, branchName?, name}` tuple:
 * the bridge resolves shell row → session → sandbox, so no scope tuple exists
 * anywhere on the wire. Unknown keys are stripped rather than rejected (a client
 * that sends a stale extra field connects fine), which also means a
 * session-binding field cannot sneak in through a client: `shellId` resolves the
 * session server-side.
 *
 * Parsing applies the clamps, so a caller never has to remember to.
 */
export const shellConnectPayloadSchema = z
  .object({
    shellId: z.string().min(1),
    cols: positiveFiniteNumber,
    rows: positiveFiniteNumber,
    /**
     * Distinguishes one client-side shell's PTY stream from another when several
     * are multiplexed over the SAME socket (one socket per browser tab, not per
     * shell). Optional — the bridge falls back to the socket's own id.
     */
    connectionId: z.string().min(1).optional(),
  })
  .transform((payload) => ({
    ...payload,
    ...clampShellDimensions({ cols: payload.cols, rows: payload.rows }),
  }));

export type ShellConnectPayload = z.output<typeof shellConnectPayloadSchema>;
