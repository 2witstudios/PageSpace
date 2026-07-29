/**
 * The ONE agent-session contract — zod schemas + inferred types shared by the
 * web API routes, the realtime PTY bridge, and the frontend hooks. No shape in
 * this surface is ever declared twice: if a payload crosses a process boundary,
 * its schema lives here and every side parses with it.
 *
 * Two semantic invariants govern everything downstream, and this module is where
 * they are written down once:
 *
 * 1. **A session is NOT a conversation — it OWNS conversations.** A session is
 *    a drive-level workspace with its own id (`agent_sessions.id`): it owns the
 *    one sandbox, its id is the Sprite-key fold, and it hosts MANY
 *    conversations (with any of the drive's agents, or the global assistant)
 *    plus any number of shells. `conversations.sessionId` is the binding — set
 *    at creation, permanent, and nullable (a plain chat has no session). A
 *    conversation-derived id must never become a session address again: the
 *    first cut had `sessionId ≡ conversationId`, which forced one environment
 *    per chat thread and made it structurally impossible for two conversations
 *    to share a working context. The old "which id?" worry inverts cleanly:
 *    a DTO carries `sessionId` when it means the workspace and
 *    `conversationId` when it means the thread, and the two are different
 *    kinds of thing, not two names for one. Sessions are USER-VISIBLE — the
 *    sidebar lists them — and the user-facing word is simply "session".
 *
 * 2. **Ids address, names label.** `sessionId` and `shellId` are the addresses:
 *    every wire payload, every tool argument after the spawn, and every Sprite
 *    key folds one of them. `name` is a display label with no addressing role —
 *    session names carry no uniqueness constraint at all, and the
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
 * `sessionId` is the session's OWN id (invariant 1) — the workspace address,
 * never a conversation id. `driveId` is nullable: null means a
 * global-assistant session, which lives outside any drive — access and
 * billing fall back to `ownerId`. There is deliberately no agent field: a
 * session hosts conversations with MANY agents, so the agent association
 * lives on each conversation.
 */
export const agentSessionDtoSchema = z.object({
  /** `agent_sessions.id` — the tool address, the `?session=` URL value, and the Sprite-key fold. */
  sessionId: z.string().min(1),
  /** The drive this workspace belongs to, or null for a global-assistant session. */
  driveId: z.string().min(1).nullable(),
  ownerId: z.string().min(1),
  /** Display label only — no uniqueness, never an address. */
  name: z.string(),
  sandboxStatus: sandboxStatusSchema,
  createdAt: isoTimestamp,
  lastActiveAt: isoTimestamp.nullable(),
  /** Stamped when the session ended; the row survives so its conversations stay readable history. */
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
  /** The owning session's id (`agent_sessions.id`). */
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

/**
 * The internal HTTP routes the realtime shell bridge serves.
 *
 * Declared here, and imported by BOTH sides, because they already drifted once:
 * the phase-3 re-key renamed these from `session-*` to `shell-*` on the server
 * while the web tool client kept posting to the old names, so every agent
 * `read_shell`/`send_shell` 404'd and came back as "could not reach the
 * terminal service". Nothing caught it — each side is unit-tested against a
 * mocked transport, so both suites were green against a hop that could not
 * connect. A string that two apps must agree on is a shape, and this module's
 * rule is that no shape is declared twice.
 */
export const SHELL_BRIDGE_ROUTES = {
  /** `read_shell`, and the multi-shell liveness sweep. */
  read: '/api/shell-read',
  /** `send_shell`. */
  input: '/api/shell-input',
  /** Activity/keepalive pings for a live PTY. */
  activity: '/api/shell-activity',
} as const;

export type ShellBridgeRoute = (typeof SHELL_BRIDGE_ROUTES)[keyof typeof SHELL_BRIDGE_ROUTES];

/**
 * The shell-bridge wire shapes — the request/response bodies that cross the
 * signed HTTP hop between `apps/web`'s tool layer and `apps/realtime`.
 *
 * Here for the same reason the routes are: these were declared twice, once per
 * app, and they drifted. The client sent `{shellId}` where the endpoint takes
 * `{shellIds: []}` and expected a flat body where the endpoint answers per-id.
 * Two independent declarations of one wire format are two things that can
 * disagree while both type-check, and each side's suite mocks the other, so
 * nothing fails until production. One declaration cannot disagree with itself.
 */

/**
 * Opting IN to starting a never-run PTY.
 *
 * Both fields are required to start: `start` because starting a PTY reserves a
 * concurrency slot and begins billing a payer — an effect no caller should get
 * by accident — and `userId` because that start is authorized, metered and
 * audited against a real person, exactly as a socket connect is. A caller that
 * omits them gets the no-start answer.
 */
export interface ShellStartRequest {
  start?: boolean;
  userId?: string;
}

export interface ShellReadPayload extends ShellStartRequest {
  /**
   * A list because this endpoint also serves the multi-shell liveness sweep.
   * `read_shell` always names exactly one — and that is load-bearing, not
   * stylistic: the bridge only STARTS a never-run PTY for a single-addressed
   * read, so naming one id is what keeps start-on-first-read working.
   */
  shellIds: string[];
  /** Lines of scrollback tail; `0` asks for liveness only. */
  limit?: number;
}

export interface ShellReadEntry {
  shellId: string;
  live: boolean;
  /**
   * Has this PTY ever emitted a byte? Reported separately from `output` because
   * a single chunk bigger than the ring is pushed and trimmed straight back off
   * — an empty tail from a loud session is possible, and must not read as
   * silence.
   */
  hasOutput: boolean;
  /** How many humans are watching right now. Zero does not mean not running. */
  viewers: number;
  output: string;
  /** Why nothing is live, when the start refused with a stateable reason. */
  reason?: string;
  /**
   * Did THIS read start the PTY? Present only when it did. The reader needs it:
   * an empty tail from a shell that booted a moment ago is the boot, not the
   * silence of a command that produced nothing.
   */
  started?: true;
}

export interface ShellReadResult {
  success: boolean;
  shells?: ShellReadEntry[];
  error?: string;
}

export interface ShellSendPayload extends ShellStartRequest {
  shellId: string;
  input: string;
}

export interface ShellSendResult {
  success: boolean;
  live?: boolean;
  delivered?: boolean;
  /** Did THIS send start the PTY? Present only when it did. */
  started?: true;
  /** Why nothing is live, when the start refused with a stateable reason. */
  reason?: string;
  error?: string;
}
