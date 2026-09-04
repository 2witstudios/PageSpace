/**
 * The bridge wire protocol as pure data (invariant 6: the server never
 * compels — there is no privileged frame, and anything unknown or malformed is
 * dropped, never guessed).
 *
 * This module is the ENVELOPE layer only. It decides whether bytes off the
 * socket are one of the closed set of frames below, with every field the type
 * the rest of the daemon assumes. It deliberately does NOT interpret the grant
 * a `grant_*` frame carries: the grant is kept opaque (`Record<string,
 * unknown>`) so `verifyGrant` — the strict, signature-checking layer — is the
 * one place a grant is parsed and refused. Extra fields on the ENVELOPE are
 * stripped (a `isAdmin: true` riding on a frame changes nothing, because
 * authorization comes only from the grant); extra fields INSIDE the grant
 * survive to the strict layer so it can refuse them.
 *
 * `decodeFrame` is total: it never throws, and it checks size in BYTES before
 * parsing so an oversized frame costs nothing. Deny reasons are a closed
 * union: `oversized` → `malformed` (structure) → `unknown_type` → `bad_base64`
 * (a structurally valid frame whose only defect is a `*B64`/`sig` field).
 */
import { z } from 'zod';

/** Strict base64 (standard alphabet, correct padding); the empty string is allowed. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BAD_BASE64 = 'bad_base64';

const b64 = z.string().refine((value) => BASE64_RE.test(value), { message: BAD_BASE64 });
const nonEmpty = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();
const posInt = z.number().int().positive();
/** The grant travels opaque; `verifyGrant` is the strict parser. */
const opaqueGrant = z.record(z.string(), z.unknown());

const capabilitiesSchema = z.object({
  shell: z.boolean(),
  pty: z.boolean(),
  fs: z.boolean(),
  checkpoint: z.boolean(),
});

// ---- machine → server -----------------------------------------------------

const hello = z.object({ type: z.literal('hello'), envId: nonEmpty, capabilities: capabilitiesSchema, policyDigest: z.string(), sig: b64 });
const execResult = z.object({ type: z.literal('exec_result'), grantId: nonEmpty, exitCode: z.number().int(), stdoutB64: b64, stderrB64: b64, truncated: z.boolean(), sig: b64 });
const fsReadResult = z.object({ type: z.literal('fs_read_result'), grantId: nonEmpty, found: z.boolean(), contentB64: b64.optional(), sig: b64 });
const fsWriteResult = z.object({ type: z.literal('fs_write_result'), grantId: nonEmpty, ok: z.boolean(), error: z.string().optional(), sig: b64 });
const grantDenied = z.object({ type: z.literal('grant_denied'), grantId: nonEmpty, reason: nonEmpty, sig: b64 });
const ptyOpened = z.object({ type: z.literal('pty_opened'), grantId: nonEmpty, sessionId: nonEmpty });
const ptyData = z.object({ type: z.literal('pty_data'), sessionId: nonEmpty, seq: nonNegInt, dataB64: b64 });
const ptyExit = z.object({ type: z.literal('pty_exit'), sessionId: nonEmpty, code: z.number().int() });
const pong = z.object({ type: z.literal('pong'), ts: nonNegInt });

// ---- server → machine -----------------------------------------------------

const grantExec = z.object({
  type: z.literal('grant_exec'),
  grant: opaqueGrant,
  sig: b64,
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().optional(),
  maxBytes: z.number().optional(),
});
const grantFsRead = z.object({ type: z.literal('grant_fs_read'), grant: opaqueGrant, sig: b64, paths: z.array(z.string()) });
const grantFsWrite = z.object({
  type: z.literal('grant_fs_write'),
  grant: opaqueGrant,
  sig: b64,
  files: z.array(z.object({ path: z.string(), contentB64: b64, mode: nonNegInt.optional() })),
});
const grantPtyOpen = z.object({
  type: z.literal('grant_pty_open'),
  grant: opaqueGrant,
  sig: b64,
  cols: posInt,
  rows: posInt,
  cwd: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});
const ptyInput = z.object({ type: z.literal('pty_input'), sessionId: nonEmpty, seq: nonNegInt, dataB64: b64 });
const ptyResize = z.object({ type: z.literal('pty_resize'), sessionId: nonEmpty, cols: posInt, rows: posInt });
const ptyKill = z.object({ type: z.literal('pty_kill'), sessionId: nonEmpty, signal: z.string().optional() });
const revoke = z.object({ type: z.literal('revoke'), sig: b64, issuedAt: nonNegInt, reason: z.string().optional() });
const ping = z.object({ type: z.literal('ping'), ts: nonNegInt });

const frameSchema = z.discriminatedUnion('type', [
  hello, execResult, fsReadResult, fsWriteResult, grantDenied, ptyOpened, ptyData, ptyExit, pong,
  grantExec, grantFsRead, grantFsWrite, grantPtyOpen, ptyInput, ptyResize, ptyKill, revoke, ping,
]);

export type Frame = z.infer<typeof frameSchema>;
export type FrameType = Frame['type'];

/** The closed set. A `type` outside it is `unknown_type`, full stop. */
export const FRAME_TYPES: ReadonlySet<FrameType> = new Set<FrameType>([
  'hello', 'exec_result', 'fs_read_result', 'fs_write_result', 'grant_denied', 'pty_opened', 'pty_data', 'pty_exit', 'pong',
  'grant_exec', 'grant_fs_read', 'grant_fs_write', 'grant_pty_open', 'pty_input', 'pty_resize', 'pty_kill', 'revoke', 'ping',
]);

export type DecodeFrameReason = 'oversized' | 'malformed' | 'unknown_type' | 'bad_base64';
export type DecodeFrameVerdict = { readonly ok: true; readonly frame: Frame } | { readonly ok: false; readonly reason: DecodeFrameReason };

export interface FrameLimits {
  /** Maximum wire size in BYTES; checked before parsing. */
  readonly maxFrameBytes: number;
}

function reject(reason: DecodeFrameReason): DecodeFrameVerdict {
  return { ok: false, reason };
}

/** Serialize a frame for the wire: one line of JSON, no embedded newlines. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Decode bytes off the wire (a string) or an already-parsed value into a
 * frame. Total: never throws.
 * @returns the typed frame with envelope extras stripped, or a closed-union reason.
 */
export function decodeFrame(raw: unknown, limits: FrameLimits): DecodeFrameVerdict {
  let value: unknown;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > limits.maxFrameBytes) return reject('oversized');
    try {
      value = JSON.parse(raw);
    } catch {
      return reject('malformed');
    }
  } else {
    // An already-parsed object must face the SAME size limit it would have
    // faced on the wire, or the limit is bypassable by any transport that
    // hands us objects (Codex P2 on PR #2529). Serializing to measure is the
    // equivalent bounded check; anything unserializable is malformed.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      return reject('malformed');
    }
    if (serialized === undefined) return reject('malformed');
    if (Buffer.byteLength(serialized, 'utf8') > limits.maxFrameBytes) return reject('oversized');
    value = raw;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject('malformed');
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return reject('malformed');
  if (!FRAME_TYPES.has(type as FrameType)) return reject('unknown_type');

  const parsed = frameSchema.safeParse(value);
  if (parsed.success) return { ok: true, frame: parsed.data };
  // A frame whose ONLY defects are base64 fields is reported as bad_base64;
  // any structural defect wins as malformed.
  const onlyBase64 = parsed.error.issues.length > 0 && parsed.error.issues.every((issue) => issue.message === BAD_BASE64);
  return reject(onlyBase64 ? 'bad_base64' : 'malformed');
}
