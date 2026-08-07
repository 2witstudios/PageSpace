/**
 * Agent activity → live shell feed — the re-keyed successor to
 * `terminal-activity.ts` (Terminal Epic 1 T1.5, activity visibility).
 *
 * An agent's `bash` tool runs in its WORKSPACE's one shared sandbox, but
 * through a separate one-off exec call — never through the interactive PTY a
 * connected human is watching. Without this, a human watching one of that
 * workspace's shells has no visibility into what the agent just did on their
 * sandbox.
 *
 * `apps/web` posts here (HMAC-signed, mirroring /api/broadcast and /api/kick)
 * after a successful bash run, addressed by the workspace
 * (`agent_workspaces.id`) — the only address the tool layer holds; the
 * `(tenantId, driveId, pageId)` machine-session tuple has no successor. The
 * wire field carrying it is still spelled `sessionId`; see
 * `ShellActivityPayload` for why that name is frozen. This handler resolves
 * the workspace's shells to their in-memory keys (an injected DB lookup — no
 * Sprite is ever touched), looks up any LIVE PTY sessions in the shared map,
 * and — for each one — injects an annotated line into its output feed (both
 * the live sockets and the scrollback), so it reads like PTY output to anyone
 * watching or reconnecting. Every live shell of the workspace gets the line:
 * they all share the sandbox the agent just acted on.
 *
 * A 200 with `delivered: false` (no live shell) is the expected common case —
 * most agent runs happen while nobody is watching a shell — and is NOT an
 * error: the agent's command already succeeded independently of whether anyone
 * is watching.
 */

import type { TerminalSessionMap } from './terminal-session-map';
import { appendScrollback, broadcastOutput } from './terminal-session-map';
import { truncateToBytes } from '@pagespace/lib/services/sandbox/output-limit';

/** Cap on the output preview injected into the feed — a live PTY pane, not a log viewer. */
const MAX_FEED_OUTPUT_BYTES = 4 * 1024;

/**
 * C0 control characters EXCEPT tab/LF/CR, and DEL. `command`, `agentLabel`,
 * and `output` are agent-controlled (the model chose the command; its output
 * can carry indirect prompt-injection payloads) and are about to be
 * interpolated into a string that is written VERBATIM into a live,
 * escape-sequence-interpreting xterm.js feed — the header/footer's OWN
 * `\x1b[...m` color codes are added by this module, not by the payload, so
 * anything the payload contributes must be stripped of control bytes first.
 * Otherwise an embedded ESC (0x1B) sequence could spoof output (fake a
 * different exit code, overwrite/hide prior lines) for the human watching.
 */
const CONTROL_CHARS_EXCEPT_WHITESPACE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_EXCEPT_WHITESPACE, '');
}

export interface ShellActivityPayload {
  /**
   * `agent_workspaces.id` — the workspace whose sandbox the agent acted on.
   *
   * The FIELD NAME is frozen at the old spelling on purpose: this is a
   * cross-service wire contract and realtime deploys BEFORE web, so renaming
   * it would need its own accept-both release. `apps/web` maps its
   * `workspaceId` onto this name at the boundary
   * (`sandbox-tools-runtime.ts`), the same way the sandbox billing and storage
   * paths do for `AIUsageData.sessionId`.
   */
  sessionId: string;
  command: string;
  output: string;
  exitCode: number;
  agentLabel: string;
}

interface ParseResult {
  success: boolean;
  payload?: ShellActivityPayload;
  error?: string;
}

export function parseShellActivityRequest(body: string): ParseResult {
  try {
    const payload = JSON.parse(body) as ShellActivityPayload;
    return { success: true, payload };
  } catch {
    return { success: false, error: 'Invalid JSON' };
  }
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateShellActivityPayload(payload: ShellActivityPayload): ValidationResult {
  if (!isNonEmptyString(payload.sessionId)) return { valid: false, error: 'Missing or invalid sessionId' };
  if (!isNonEmptyString(payload.command)) return { valid: false, error: 'Missing or invalid command' };
  if (typeof payload.output !== 'string') return { valid: false, error: 'Missing or invalid output' };
  if (typeof payload.exitCode !== 'number' || !Number.isFinite(payload.exitCode)) {
    return { valid: false, error: 'Missing or invalid exitCode' };
  }
  if (!isNonEmptyString(payload.agentLabel)) return { valid: false, error: 'Missing or invalid agentLabel' };
  return { valid: true };
}

/**
 * Formats a bash run as an annotated PTY-style block: cyan header naming who
 * ran what, the (truncated, CRLF-normalized) output, and a dim exit-code
 * footer. `\r\n` line endings match real PTY output so xterm renders it
 * identically to a shell echoing its own commands.
 */
export function formatShellActivityLine(payload: Pick<ShellActivityPayload, 'command' | 'output' | 'exitCode' | 'agentLabel'>): string {
  const { text: truncatedOutput } = truncateToBytes({ text: payload.output, maxBytes: MAX_FEED_OUTPUT_BYTES });
  const safeAgentLabel = stripControlChars(payload.agentLabel);
  const safeCommand = stripControlChars(payload.command);
  const safeOutput = stripControlChars(truncatedOutput);
  const header = `\r\n\x1b[36m▸ ${safeAgentLabel} ran:\x1b[0m ${safeCommand}\r\n`;
  const body = safeOutput.length > 0 ? `${safeOutput.replace(/\r?\n/g, '\r\n')}\r\n` : '';
  const footer = `\x1b[90m(exit ${payload.exitCode})\x1b[0m\r\n`;
  return header + body + footer;
}

export interface ShellActivityDeps {
  sessionMap: Pick<TerminalSessionMap, 'getByKey'>;
  /**
   * Resolves the workspace's shells to their in-memory session-map keys — a
   * DB-only listing of `agent_workspace_shells` composed with
   * `deriveShellSessionKey`. An empty array means the workspace has no shells
   * (nothing to look up — same as no live session). Never touches a Sprite.
   */
  resolveShellKeys: (workspaceId: string) => Promise<string[]>;
}

export interface ShellActivityResult {
  success: boolean;
  delivered?: boolean;
  error?: string;
}

/**
 * Handle the shell-activity API request. Pure composition over injected deps —
 * no HTTP/socket types here, so this is unit-tested directly.
 */
export async function handleShellActivityRequest(
  deps: ShellActivityDeps,
  body: string,
): Promise<{ status: number; body: ShellActivityResult }> {
  const parsed = parseShellActivityRequest(body);
  if (!parsed.success || !parsed.payload) {
    return { status: 400, body: { success: false, error: parsed.error ?? /* c8 ignore next */ 'Parse error' } };
  }

  const validation = validateShellActivityPayload(parsed.payload);
  if (!validation.valid) {
    return { status: 400, body: { success: false, error: validation.error ?? /* c8 ignore next */ 'Validation error' } };
  }

  const keys = await deps.resolveShellKeys(parsed.payload.sessionId);
  const liveSessions = keys
    .map((key) => deps.sessionMap.getByKey(key))
    .filter((session) => session !== undefined);
  if (liveSessions.length === 0) {
    return { status: 200, body: { success: true, delivered: false } };
  }

  const text = formatShellActivityLine(parsed.payload);
  for (const session of liveSessions) {
    appendScrollback(session, text);
    // An agent's bash run in this session IS activity for the shell's platform
    // task hold: a detached multi-step agent run must not have its hold
    // deleted between steps (the handler's hold heartbeat reads this via
    // latestActivityAt).
    session.lastOutputAt = Date.now();
    broadcastOutput(session, text);
  }

  return { status: 200, body: { success: true, delivered: true } };
}
