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
 * The agent types a SHELL can run. PTY-only, because this names what a row in
 * `agent_session_shells` is — a real PTY process — and nothing else.
 *
 * Read narrowly. The legacy `AGENT_LAUNCH_SPECS` carried two entries
 * (`pagespace` → surface `'chat'`, `shell` → surface `'pty'`) because ONE table
 * held both kinds and needed a discriminator. This model splits them:
 * `agent_sessions` holds conversations, `agent_session_shells` holds PTYs. So
 * the chat type has no successor *here* — but that is a fact about this table,
 * NOT about what a pane can display.
 *
 * An earlier draft of this comment claimed PTY-only "by construction" as though
 * it settled the whole surface, and that reading is what removed the ability to
 * open an agent conversation in a pane. A pane's binding carries its own
 * `kind` (`'chat' | 'terminal'`) and the id it addresses — a conversationId or
 * a shellId — written at bind time by the path that knew what it spawned.
 */
export const SHELL_AGENT_TYPES = ['shell'] as const;

export const shellAgentTypeSchema = z.enum(SHELL_AGENT_TYPES);
export type ShellAgentType = z.infer<typeof shellAgentTypeSchema>;

/**
 * What a pane displays. The discriminator lives on the PANE BINDING rather than
 * on either row type, because the two surfaces are now two different tables and
 * a pane is the one place that has to talk about both.
 *
 * `'chat'` addresses a conversation (`sessionId` ≡ `conversationId`);
 * `'terminal'` addresses a `shellId`.
 */
export const PANE_KINDS = ['chat', 'terminal'] as const;

export const paneKindSchema = z.enum(PANE_KINDS);
export type PaneKind = z.infer<typeof paneKindSchema>;

/**
 * A pane's binding: what it shows, and the id it shows it for. `null` id is a
 * bound-but-not-yet-resolved pane (the picker just chose a kind); an unbound
 * pane stores no scope at all and renders the picker.
 */
export const paneScopeSchema = z.object({
  kind: paneKindSchema,
  /** Display label — the conversation title or the shell name. Never an address. */
  name: z.string(),
  /** The conversationId (chat) or shellId (terminal) this pane is bound to. */
  targetId: z.string().min(1).nullable(),
  /**
   * Which agent the conversation belongs to, for a `'chat'` pane. Null for a
   * global-assistant conversation, and irrelevant for a terminal — so a single
   * grid can hold conversations with several different agents side by side.
   */
  agentPageId: z.string().min(1).nullable(),
});

export type PaneScope = z.infer<typeof paneScopeSchema>;

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
