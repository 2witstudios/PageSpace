/**
 * The SHELL half of the agent-workspace contract — zod schemas + inferred types
 * for PTY shells and the shell bridge, shared by the web API routes, the
 * realtime PTY bridge, and the frontend hooks.
 *
 * Split out of `./contract`, which had grown to hold three unrelated concerns at
 * once (shells, session identity, and the old layout model) and so made a
 * boundary problem look like coupling. A session's own identity and lifecycle
 * shapes are in `./session-contract`; what is left in `./contract` is the old
 * layout model's wire shape.
 *
 * The rule that governed the original module still governs this one: no shape in
 * this surface is ever declared twice. If a payload crosses a process boundary,
 * its schema lives here and every side parses with it. `SHELL_BRIDGE_ROUTES` and
 * the bridge wire shapes below are in this module precisely because each was
 * once declared twice, once per app, and each drifted.
 *
 * The two semantic invariants that govern this whole surface — a session OWNS
 * conversations, and ids address while names label — are written down once, in
 * `./session-contract`. The second one is why a `shellId` is the only thing that
 * ever addresses a shell and a shell `name` never is.
 */

import { z } from 'zod';

/**
 * The agent types a SHELL can run. PTY-only, because this names what a row in
 * `agent_workspace_shells` is — a real PTY process — and nothing else.
 *
 * Read narrowly. The legacy `AGENT_LAUNCH_SPECS` carried two entries
 * (`pagespace` → surface `'chat'`, `shell` → surface `'pty'`) because ONE table
 * held both kinds and needed a discriminator. This model splits them:
 * `agent_workspaces` holds conversations, `agent_workspace_shells` holds PTYs. So
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
 * Wire timestamps are ISO-8601 strings; `Date` never crosses the boundary.
 *
 * The same one-line primitive is declared in `./session-contract`. Deliberately
 * duplicated rather than shared: it is a validator primitive, not a wire shape,
 * and making either concern import the other for one line would recreate the
 * cross-concern edge this split exists to remove.
 */
const isoTimestamp = z.string().datetime();

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
  /** The owning workspace's id (`agent_workspaces.id`). */
  workspaceId: z.string().min(1),
  /** @deprecated ROLLING-DEPLOY COMPAT, one release only — see `agentSessionDtoSchema.sessionId` in `./session-contract`. */
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

/** How many shells one read may ask about — a session's listing, not a crawl. */
export const MAX_SHELLS_PER_READ = 100;

/** Upper bound on a single stdin write — mirrors the socket path's `MAX_INPUT_BYTES`. */
export const MAX_SHELL_INPUT_BYTES = 4096;

/**
 * Upper bound on the requested scrollback tail, in lines. The answer is
 * byte-capped anyway (`MAX_SCROLLBACK_TAIL_BYTES`) and the ring holds 64 KiB,
 * so any larger ask is indistinguishable from this one — bounded here so the
 * wire shape carries no unbounded number at all.
 */
export const MAX_SCROLLBACK_TAIL_LINES = 10_000;

/**
 * Opting IN to starting a never-run PTY.
 *
 * Both fields are required to start: `start` because starting a PTY reserves a
 * concurrency slot and begins billing a payer — an effect no caller should get
 * by accident — and `userId` because that start is authorized, metered and
 * audited against a real person, exactly as a socket connect is. A caller that
 * omits them gets the no-start answer. Whether a start is actually attempted
 * (userId required with `start: true`, single-addressed reads only) is the
 * bridge's pure `planSessionStart` decision, not a shape question — the schema
 * validates each field on its own terms.
 */
export const shellStartRequestSchema = z.object({
  start: z.boolean().optional(),
  userId: z.string().min(1).optional(),
});

export type ShellStartRequest = z.infer<typeof shellStartRequestSchema>;

export const shellReadPayloadSchema = shellStartRequestSchema.extend({
  /**
   * A list because this endpoint also serves the multi-shell liveness sweep.
   * `read_shell` always names exactly one — and that is load-bearing, not
   * stylistic: the bridge only STARTS a never-run PTY for a single-addressed
   * read, so naming one id is what keeps start-on-first-read working.
   */
  shellIds: z.array(z.string().min(1)).min(1).max(MAX_SHELLS_PER_READ),
  /** Lines of scrollback tail; `0` asks for liveness only. */
  limit: z.number().int().min(0).max(MAX_SCROLLBACK_TAIL_LINES).optional(),
});

export type ShellReadPayload = z.infer<typeof shellReadPayloadSchema>;

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

export const shellSendPayloadSchema = shellStartRequestSchema.extend({
  shellId: z.string().min(1),
  // Bounded in BYTES, not code units (multi-byte characters count as what the
  // PTY receives), and refused rather than truncated: half a command typed
  // into a live shell is a command the caller never wrote, and the PTY would
  // run it. `TextEncoder` rather than `Buffer` because this schema is parsed
  // on both sides of the hop, including in the browser bundle.
  input: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).length <= MAX_SHELL_INPUT_BYTES, {
      message: `input exceeds ${MAX_SHELL_INPUT_BYTES} bytes`,
    }),
});

export type ShellSendPayload = z.infer<typeof shellSendPayloadSchema>;

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
