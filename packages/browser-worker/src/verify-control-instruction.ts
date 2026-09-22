/**
 * Does this request carry an instruction the worker must obey? — pure, given
 * the Ed25519 verify primitive, the worker's clock reading and the nonces it
 * has already seen. The worker (`browser-control-worker.ts`) runs nothing
 * that did not come back `ok: true` from here, and records the nonce only
 * after it does.
 *
 * Fail-closed order, first failure wins:
 *  1. shape of the wire form (two non-empty base64url segments);
 *  2. the SIGNATURE over the payload bytes as received — before a single
 *     claim is parsed, so an attacker's JSON is never interpreted;
 *  3. version and audience (an env-bridge grant is not a browser order);
 *  4. every claim well formed;
 *  5. this session, and only this session;
 *  6. the time window: not expired, not from the future beyond the skew,
 *     never longer than {@link CONTROL_INSTRUCTION_MAX_TTL_MS};
 *  7. a nonce never seen before (replay);
 *  8. a typed command (`parseControlCommand`), which
 *  9. the actor may issue: the agent issues typed operations and nothing
 *     else; a human takes over, releases, views and types into the pane.
 */
import {
  CONTROL_INSTRUCTION_AUDIENCE,
  CONTROL_INSTRUCTION_MAX_CLOCK_SKEW_MS,
  CONTROL_INSTRUCTION_MAX_TTL_MS,
  CONTROL_INSTRUCTION_VERSION,
  type ControlActor,
  type ControlClaims,
  type ControlCommandType,
  type Ed25519Verify,
} from './control-instruction.js';
import { parseControlCommand } from './parse-control-command.js';

export type ControlInstructionDenyReason =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-version'
  | 'wrong-audience'
  | 'wrong-session'
  | 'expired'
  | 'not-yet-valid'
  | 'ttl-too-long'
  | 'replayed'
  | 'invalid-command'
  | 'actor-not-permitted';

export type ControlInstructionVerdict =
  | { readonly ok: true; readonly claims: ControlClaims }
  | { readonly ok: false; readonly reason: ControlInstructionDenyReason };

export type VerifyControlInstructionOptions = {
  readonly instruction: string;
  readonly verify: Ed25519Verify;
  readonly now: number;
  readonly sessionId: string;
  readonly seenNonces: ReadonlySet<string>;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_ID_LENGTH = 128;

const PERMITTED_COMMANDS: Readonly<Record<ControlActor['kind'], readonly ControlCommandType[]>> = {
  agent: ['operation'],
  human: ['take-over', 'release', 'view-frame', 'human-input', 'audit'],
};

const deny = (reason: ControlInstructionDenyReason): ControlInstructionVerdict => ({ ok: false, reason });

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

const parseActor = (value: unknown): ControlActor | null => {
  if (typeof value !== 'object' || value === null) return null;
  const actor = value as Readonly<Record<string, unknown>>;
  if (actor.kind === 'agent' && isId(actor.agentId)) return { kind: 'agent', agentId: actor.agentId };
  if (actor.kind === 'human' && isId(actor.userId)) return { kind: 'human', userId: actor.userId };
  return null;
};

const parseJsonObject = (text: string): Readonly<Record<string, unknown>> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
};

export const verifyControlInstruction = ({ instruction, verify, now, sessionId, seenNonces }: VerifyControlInstructionOptions): ControlInstructionVerdict => {
  const segments = instruction.split('.');
  if (segments.length !== 2) return deny('malformed');
  const [payload, signature] = segments;
  if (!BASE64URL.test(payload) || !BASE64URL.test(signature)) return deny('malformed');

  if (!verify(new TextEncoder().encode(payload), new Uint8Array(Buffer.from(signature, 'base64url')))) return deny('bad-signature');

  const raw = parseJsonObject(Buffer.from(payload, 'base64url').toString('utf8'));
  if (raw === null) return deny('malformed');
  if (raw.v !== CONTROL_INSTRUCTION_VERSION) return deny('wrong-version');
  if (raw.aud !== CONTROL_INSTRUCTION_AUDIENCE) return deny('wrong-audience');

  const actor = parseActor(raw.actor);
  const { sid, iat, exp, nonce } = raw;
  if (actor === null || !isId(sid) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || typeof nonce !== 'string' || !NONCE.test(nonce)) {
    return deny('malformed');
  }
  const issuedAt = iat as number;
  const expiresAt = exp as number;

  if (sid !== sessionId) return deny('wrong-session');
  if (expiresAt <= now) return deny('expired');
  if (issuedAt > now + CONTROL_INSTRUCTION_MAX_CLOCK_SKEW_MS) return deny('not-yet-valid');
  if (expiresAt - issuedAt > CONTROL_INSTRUCTION_MAX_TTL_MS) return deny('ttl-too-long');
  if (seenNonces.has(nonce)) return deny('replayed');

  const command = parseControlCommand(raw.command);
  if (command === null) return deny('invalid-command');
  if (!PERMITTED_COMMANDS[actor.kind].includes(command.type)) return deny('actor-not-permitted');

  return {
    ok: true,
    claims: { v: CONTROL_INSTRUCTION_VERSION, aud: CONTROL_INSTRUCTION_AUDIENCE, sid, iat: issuedAt, exp: expiresAt, nonce, actor, command },
  };
};
