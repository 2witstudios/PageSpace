/**
 * The bytes each side signs on the bridge, defined ONCE so the daemon (which
 * produces them) and the socket route (which verifies them) agree by
 * construction rather than by convention:
 *
 * - **hello** (machine → server, invariant 2): the first frame on every
 *   socket, signed by the machine key pinned at enrollment. Covers
 *   `{envId, capabilities, policyDigest}` — so a captured hello cannot be
 *   replayed for another env, and neither the advertised capabilities nor the
 *   policy digest can be altered in flight.
 * - **result** (machine → server, invariant 7): every `exec_result`,
 *   `fs_read_result`, `fs_write_result` and `grant_denied` is signed over
 *   `{grantId, resultHash}` where `resultHash` covers EVERY payload field of
 *   the frame (`resultHashForFrame`). A result cannot be moved onto another
 *   grant, and no field of it can be edited between the machine and the agent.
 * - **revoke** (server → machine, invariant 8): signed over
 *   `{envId, enrollmentId, keyId, issuedAt}` — a revoke for one enrollment
 *   cannot revoke another, and it must be signed by the key that enrollment
 *   pinned (`keyId`), so a rotated-out key cannot be used to revoke.
 *
 * Every encoding is domain-separated (a fixed leading `domain` string) and
 * built from the TYPED value in a fixed key order, so insertion order can never
 * change the signed message and a signature over one message type can never
 * verify as another.
 *
 * **Out of scope by design ([D-2] on the epic page):** `pty_data`, `pty_exit`
 * and `pong` are not covered here. Whether PTY frames get a per-session HMAC
 * derived at `pty_open` (recommended), full per-frame signatures, or a stated
 * exception is an open founder decision; the verifier for exec/fs results
 * above does not change under any of those outcomes.
 *
 * Pure: the Ed25519 `verify` and the `hash` primitives are injected.
 */
import type { Frame } from './frame-codec';
import type { HelloFrame } from './bridge-session';
import { canonicalizeArgs, constantTimeEqual, decodeBase64, type Ed25519Verify, type HashBytes } from './grant';

export const HELLO_SIGNING_DOMAIN = 'pagespace-env-bridge/hello/v1';
export const RESULT_SIGNING_DOMAIN = 'pagespace-env-bridge/result/v1';
export const REVOKE_SIGNING_DOMAIN = 'pagespace-env-bridge/revoke/v1';
/** A revoke of ONE durable approval (GA wave 2): its own domain, so an approval revoke can never be replayed as an enrollment revoke by dropping the id, nor the reverse. */
export const REVOKE_APPROVAL_SIGNING_DOMAIN = 'pagespace-env-bridge/revoke-approval/v1';

export type { HelloFrame };
export type RevokeFrame = Extract<Frame, { type: 'revoke' }>;
export type MachineResultFrame = Extract<Frame, { type: 'exec_result' | 'fs_read_result' | 'fs_write_result' | 'grant_denied' }>;
export type MachineResultFrameType = MachineResultFrame['type'];

/** The machine frames that answer a grant and therefore MUST be signed (invariant 7). */
export const MACHINE_RESULT_FRAME_TYPES: ReadonlySet<MachineResultFrameType> = new Set<MachineResultFrameType>(['exec_result', 'fs_read_result', 'fs_write_result', 'grant_denied']);

export function isMachineResultFrame(frame: Frame): frame is MachineResultFrame {
  return (MACHINE_RESULT_FRAME_TYPES as ReadonlySet<string>).has(frame.type);
}

export type MachineSignatureDenyReason = 'wrong_env' | 'bad_signature' | 'malformed';
export type MachineSignatureVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: MachineSignatureDenyReason };

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

// ---- hello -----------------------------------------------------------------

/** Canonical bytes the machine signs for its hello; rebuilt field by field from the typed value. */
export function encodeHelloForSigning(hello: Pick<HelloFrame, 'envId' | 'capabilities' | 'policyDigest'>): Uint8Array {
  return encode({
    domain: HELLO_SIGNING_DOMAIN,
    envId: hello.envId,
    capabilities: {
      shell: hello.capabilities.shell,
      pty: hello.capabilities.pty,
      fs: hello.capabilities.fs,
      checkpoint: hello.capabilities.checkpoint,
    },
    policyDigest: hello.policyDigest,
  });
}

export interface VerifyHelloInput {
  readonly hello: HelloFrame;
  /** The env the socket was authenticated for (URL + token); a hello for any other env is refused before crypto. */
  readonly expectedEnvId: string;
  /** The machine public key pinned at enrollment (SPKI DER). */
  readonly machinePublicKey: Uint8Array;
  readonly verify: Ed25519Verify;
}

/** Deny order: wrong_env → malformed (signature not base64) → bad_signature. */
export function verifyHello(input: VerifyHelloInput): MachineSignatureVerdict {
  if (input.hello.envId !== input.expectedEnvId) return { ok: false, reason: 'wrong_env' };
  const signature = decodeBase64(input.hello.sig);
  if (signature === null) return { ok: false, reason: 'malformed' };
  return safeVerify(input.verify, encodeHelloForSigning(input.hello), signature, input.machinePublicKey);
}

// ---- results ---------------------------------------------------------------

/**
 * The fixed field set `resultHash` covers, per result type. Every field, every
 * time: an optional the frame omitted is `null`, never a missing key, so
 * "absent" hashes identically on both sides and distinctly from "empty".
 */
export function resultPayloadForFrame(frame: MachineResultFrame): Record<string, unknown> {
  switch (frame.type) {
    case 'exec_result':
      return { type: frame.type, grantId: frame.grantId, exitCode: frame.exitCode, stdoutB64: frame.stdoutB64, stderrB64: frame.stderrB64, truncated: frame.truncated };
    case 'fs_read_result':
      return { type: frame.type, grantId: frame.grantId, found: frame.found, contentB64: frame.contentB64 ?? null };
    case 'fs_write_result':
      return { type: frame.type, grantId: frame.grantId, ok: frame.ok, error: frame.error ?? null };
    case 'grant_denied':
      // `pending` (a frozen request awaiting a chat click, GA wave 2) is
      // signed too: the card renders what the MACHINE said it froze.
      return { type: frame.type, grantId: frame.grantId, reason: frame.reason, pending: frame.pending ?? null };
  }
}

/** `hash(canonicalizeArgs(resultPayloadForFrame(frame)))` — what the signature's `resultHash` must equal. */
export function resultHashForFrame(frame: MachineResultFrame, hash: HashBytes): string {
  return hash(canonicalizeArgs(resultPayloadForFrame(frame)));
}

/** Canonical bytes the machine signs for a result. */
export function encodeResultForSigning(result: { grantId: string; resultHash: string }): Uint8Array {
  return encode({ domain: RESULT_SIGNING_DOMAIN, grantId: result.grantId, resultHash: result.resultHash });
}

export interface VerifyMachineResultInput {
  readonly frame: MachineResultFrame;
  /** The machine public key pinned at enrollment (SPKI DER). */
  readonly machinePublicKey: Uint8Array;
  readonly verify: Ed25519Verify;
  readonly hash: HashBytes;
}

export type MachineResultVerdict = { readonly ok: true; readonly resultHash: string } | { readonly ok: false; readonly reason: MachineSignatureDenyReason };

/**
 * Recompute the result hash from the frame's own fields and verify the
 * machine's signature over `{grantId, resultHash}`. A result that fails here
 * is never delivered (invariant 7). Deny order: malformed → bad_signature.
 */
export function verifyMachineResult(input: VerifyMachineResultInput): MachineResultVerdict {
  const signature = decodeBase64(input.frame.sig);
  if (signature === null) return { ok: false, reason: 'malformed' };
  let resultHash: string;
  try {
    resultHash = resultHashForFrame(input.frame, input.hash);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const verdict = safeVerify(input.verify, encodeResultForSigning({ grantId: input.frame.grantId, resultHash }), signature, input.machinePublicKey);
  return verdict.ok ? { ok: true, resultHash } : verdict;
}

// ---- revoke ----------------------------------------------------------------

export interface RevokeBinding {
  readonly envId: string;
  readonly enrollmentId: string;
  /** The server key id this enrollment pinned; the revoke must be signed by THAT key. */
  readonly keyId: string;
  /** ms since epoch; carried in the frame as `issuedAt`. */
  readonly issuedAt: number;
}

/** Canonical bytes the server signs for a revoke of the ENROLLMENT (unchanged by GA wave 2: an approval revoke uses its own domain and function). */
export function encodeRevokeForSigning(binding: RevokeBinding): Uint8Array {
  return encode({ domain: REVOKE_SIGNING_DOMAIN, envId: binding.envId, enrollmentId: binding.enrollmentId, keyId: binding.keyId, issuedAt: binding.issuedAt });
}

export interface ApprovalRevokeBinding extends RevokeBinding {
  /** The durable approval to delete — the challenge id the click was answered under. */
  readonly approvalId: string;
}

/** Canonical bytes the server signs to revoke ONE approval on the machine. The server may only ever REVOKE an approval this way; nothing on the wire can add one. */
export function encodeApprovalRevokeForSigning(binding: ApprovalRevokeBinding): Uint8Array {
  return encode({ domain: REVOKE_APPROVAL_SIGNING_DOMAIN, envId: binding.envId, enrollmentId: binding.enrollmentId, keyId: binding.keyId, issuedAt: binding.issuedAt, approvalId: binding.approvalId });
}

export interface VerifyRevokeInput extends RevokeBinding {
  readonly frame: RevokeFrame;
  /** The server public key the daemon pinned at enrollment (SPKI DER). */
  readonly serverPublicKey: Uint8Array;
  readonly verify: Ed25519Verify;
}

/**
 * The daemon's check before it honours a revoke (t08). `issuedAt` is taken
 * from the binding the daemon supplies, and must equal the frame's. A frame
 * carrying `approvalId` is verified under the approval-revoke domain over
 * THAT id; one without it under the enrollment-revoke domain — so a captured
 * approval revoke with the id stripped is `bad_signature`, never a key
 * deletion, and an enrollment revoke with an id added is `bad_signature`
 * too.
 */
export function verifyRevoke(input: VerifyRevokeInput): MachineSignatureVerdict {
  if (input.frame.issuedAt !== input.issuedAt) return { ok: false, reason: 'bad_signature' };
  const signature = decodeBase64(input.frame.sig);
  if (signature === null) return { ok: false, reason: 'malformed' };
  const binding = { envId: input.envId, enrollmentId: input.enrollmentId, keyId: input.keyId, issuedAt: input.issuedAt };
  const bytes = input.frame.approvalId !== undefined ? encodeApprovalRevokeForSigning({ ...binding, approvalId: input.frame.approvalId }) : encodeRevokeForSigning(binding);
  return safeVerify(input.verify, bytes, signature, input.serverPublicKey);
}

// ---- shared ----------------------------------------------------------------

function safeVerify(verify: Ed25519Verify, message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): MachineSignatureVerdict {
  let valid = false;
  try {
    valid = verify(message, signature, publicKey);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** Compare two digests without leaking how much matched. Re-exported for adapters that compare hashes they were handed. */
export const digestsEqual = constantTimeEqual;
