/**
 * Agent activity → live Terminal feed (Terminal Epic 1 T1.5, activity visibility).
 *
 * An agent's `bash` tool runs on the SAME persistent machine Sprite a human's
 * machine-scope 'shell' agent terminal reconnects to (services/sandbox/
 * machine-session.ts), but through a separate one-off exec call — never
 * through the interactive PTY a connected human is watching. Without this, a
 * human watching that shell has no visibility into what an agent just did on
 * their machine.
 *
 * `apps/web` posts here (HMAC-signed, mirroring /api/broadcast and /api/kick)
 * after a successful bash run. This handler resolves the SAME in-memory
 * session key `agent-terminal-handler.ts` uses for the machine's conventional
 * 'shell' terminal, looks up any LIVE session in `agentTerminalSessionMap`,
 * and — if one exists — injects an annotated line into its output feed (both
 * the live socket and its scrollback), so it reads like PTY output to anyone
 * watching or reconnecting.
 *
 * A 200 with `delivered: false` (no live session, or no driveId) is the
 * expected common case — most agent runs happen while nobody is watching the
 * Terminal — and is NOT an error: the agent's command already succeeded
 * independently of whether anyone is watching.
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

export interface TerminalActivityPayload {
  tenantId: string;
  driveId?: string;
  pageId: string;
  command: string;
  output: string;
  exitCode: number;
  agentLabel: string;
}

interface ParseResult {
  success: boolean;
  payload?: TerminalActivityPayload;
  error?: string;
}

export function parseTerminalActivityRequest(body: string): ParseResult {
  try {
    const payload = JSON.parse(body) as TerminalActivityPayload;
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

export function validateTerminalActivityPayload(payload: TerminalActivityPayload): ValidationResult {
  if (!isNonEmptyString(payload.tenantId)) return { valid: false, error: 'Missing or invalid tenantId' };
  if (!isNonEmptyString(payload.pageId)) return { valid: false, error: 'Missing or invalid pageId' };
  if (!isNonEmptyString(payload.command)) return { valid: false, error: 'Missing or invalid command' };
  if (typeof payload.output !== 'string') return { valid: false, error: 'Missing or invalid output' };
  if (typeof payload.exitCode !== 'number' || !Number.isFinite(payload.exitCode)) {
    return { valid: false, error: 'Missing or invalid exitCode' };
  }
  if (!isNonEmptyString(payload.agentLabel)) return { valid: false, error: 'Missing or invalid agentLabel' };
  if (payload.driveId !== undefined && !isNonEmptyString(payload.driveId)) {
    return { valid: false, error: 'Invalid driveId' };
  }
  return { valid: true };
}

/**
 * Formats a bash run as an annotated PTY-style block: cyan header naming who
 * ran what, the (truncated, CRLF-normalized) output, and a dim exit-code
 * footer. `\r\n` line endings match real PTY output so xterm renders it
 * identically to a shell echoing its own commands.
 */
export function formatTerminalActivityLine(payload: Pick<TerminalActivityPayload, 'command' | 'output' | 'exitCode' | 'agentLabel'>): string {
  const { text: truncatedOutput } = truncateToBytes({ text: payload.output, maxBytes: MAX_FEED_OUTPUT_BYTES });
  const safeAgentLabel = stripControlChars(payload.agentLabel);
  const safeCommand = stripControlChars(payload.command);
  const safeOutput = stripControlChars(truncatedOutput);
  const header = `\r\n\x1b[36m▸ ${safeAgentLabel} ran:\x1b[0m ${safeCommand}\r\n`;
  const body = safeOutput.length > 0 ? `${safeOutput.replace(/\r?\n/g, '\r\n')}\r\n` : '';
  const footer = `\x1b[90m(exit ${payload.exitCode})\x1b[0m\r\n`;
  return header + body + footer;
}

export interface TerminalActivityDeps {
  sessionMap: Pick<TerminalSessionMap, 'getByKey'>;
  /**
   * Resolves the machine's conventional 'shell' agent-terminal session key
   * for (tenant, drive, page), or null if no Sprite has ever been
   * provisioned for it (nothing to look up — same as no live session).
   */
  resolveSessionKey: (input: { tenantId: string; driveId: string; pageId: string }) => Promise<string | null>;
}

export interface TerminalActivityResult {
  success: boolean;
  delivered?: boolean;
  error?: string;
}

/**
 * Handle the terminal-activity API request. Pure composition over injected
 * deps — no HTTP/socket types here, so this is unit-tested directly.
 */
export async function handleTerminalActivityRequest(
  deps: TerminalActivityDeps,
  body: string,
): Promise<{ status: number; body: TerminalActivityResult }> {
  const parsed = parseTerminalActivityRequest(body);
  if (!parsed.success || !parsed.payload) {
    return { status: 400, body: { success: false, error: parsed.error ?? /* c8 ignore next */ 'Parse error' } };
  }

  const validation = validateTerminalActivityPayload(parsed.payload);
  if (!validation.valid) {
    return { status: 400, body: { success: false, error: validation.error ?? /* c8 ignore next */ 'Validation error' } };
  }

  const { tenantId, driveId, pageId } = parsed.payload;
  // No drive context (e.g. the global assistant's "own" machine) — a Terminal
  // page's live session is always keyed by (tenant, drive, page), so there is
  // no session to look up. Not an error: the agent's run already succeeded.
  if (!driveId) {
    return { status: 200, body: { success: true, delivered: false } };
  }

  const sessionKey = await deps.resolveSessionKey({ tenantId, driveId, pageId });
  const session = sessionKey ? deps.sessionMap.getByKey(sessionKey) : undefined;
  if (!session) {
    return { status: 200, body: { success: true, delivered: false } };
  }

  const text = formatTerminalActivityLine(parsed.payload);
  appendScrollback(session, text);
  // An agent's bash run on this machine IS activity for the session's
  // platform task hold: a detached multi-step agent run must not have its
  // hold deleted between steps (agent-terminal-handler's hold heartbeat
  // reads this via latestActivityAt).
  session.lastOutputAt = Date.now();
  broadcastOutput(session, text);

  return { status: 200, body: { success: true, delivered: true } };
}
