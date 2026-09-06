/**
 * Grant — the unit of authorization for every exec / fs / pty-open request the
 * server sends to a LOCAL environment (a user's own machine reached through the
 * zero-trust bridge; epic "Local Environments — zero-trust bridge", invariant 3).
 *
 * The trust direction is the whole point. The cloud can REQUEST work on the
 * user's hardware but must never be able to COMPEL it: a connection-level bearer
 * would let anything that can inject a frame into the socket — a compromised
 * server process, a replayed capture — execute. So every request carries its own
 * short-lived grant, signed by a server key the daemon pinned at enrollment, and
 * the daemon verifies it here BEFORE anything runs. Server-side gating is
 * necessary but never sufficient; this function is the daemon's own gate.
 *
 * A verified grant is also BOUND to the frame that carries it. Authenticity
 * alone is not enough: an attacker holding a captured, unused, correctly signed
 * grant could otherwise pair it with different work. `argsHash` exists to stop
 * exactly that, so this gate recomputes `hash(canonicalizeArgs(request.args))`
 * and compares it — and `op` — to the signed values. The binding is part of the
 * mandatory gate, never left to a later layer (Codex P1 on PR #2527).
 *
 * Pure by construction. Nothing in this module reads a clock, generates
 * randomness, touches `node:crypto`, or performs I/O: the caller injects `now`,
 * the Ed25519 `verify` primitive, the `hash` primitive, and the `NonceStore`.
 * That is what makes the adversarial matrix in `__tests__/grant.test.ts`
 * exhaustive rather than flaky, and what lets the same verifier run unchanged in
 * the CLI daemon and in tests.
 *
 * Deny order is FIXED and tested: malformed → wrong_env → op_mismatch →
 * args_mismatch → ttl_too_long → clock_skew → expired → bad_signature →
 * replayed. Cheap structural checks (including the request binding) run before
 * the signature so junk never reaches crypto, and the replay check runs LAST so
 * a grant that fails any earlier check can never burn its nonce — the nonce is
 * recorded only when the whole verdict is `ok`.
 */
import { z } from 'zod';

/** The closed set of operations a grant may authorize. Anything else is malformed. */
export const GRANT_OPS = ['exec', 'fs_read', 'fs_write', 'pty_open'] as const;
export type GrantOp = (typeof GRANT_OPS)[number];

/** Hard ceiling on `exp - iat`. A leaked grant is a bounded, not standing, capability. */
export const GRANT_MAX_TTL_MS = 60_000;
/** How far into the future `iat` may sit before the two clocks are judged out of step. */
export const GRANT_MAX_CLOCK_SKEW_MS = 30_000;

export interface GrantPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly conversationId: string;
}

export interface Grant {
  readonly grantId: string;
  /** The env this grant is for. A grant for another machine never runs here. */
  readonly envId: string;
  readonly principal: GrantPrincipal;
  readonly op: GrantOp;
  /** `hash(canonicalizeArgs(args))` of the request this grant was issued for. */
  readonly argsHash: string;
  /** Issued-at, ms since epoch. */
  readonly iat: number;
  /** Expiry, ms since epoch. `exp - iat` must not exceed GRANT_MAX_TTL_MS. */
  readonly exp: number;
  readonly nonce: string;
}

export type GrantDenyReason =
  | 'malformed'
  | 'wrong_env'
  | 'op_mismatch'
  | 'args_mismatch'
  | 'ttl_too_long'
  | 'clock_skew'
  | 'expired'
  | 'bad_signature'
  | 'replayed';

export type GrantVerdict = { readonly ok: true; readonly grant: Grant } | { readonly ok: false; readonly reason: GrantDenyReason };

/**
 * Replay protection. Lives on the daemon — a single process — so the
 * "in-memory nonces don't hold across replicas" caveat from the Zero Trust
 * Assessment does not apply here. `add` receives the grant's `exp` so an
 * implementation can evict entries once they could no longer verify anyway.
 */
export interface NonceStore {
  has(nonce: string): boolean;
  add(nonce: string, exp: number): void;
}

/** Ed25519 verification primitive, injected so this module stays free of `node:crypto`. */
export type Ed25519Verify = (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;

/** Cryptographic hash primitive (bytes → hex/base64 digest), injected for the same reason. */
export type HashBytes = (bytes: Uint8Array) => string;

/** The frame that carries the grant: what the caller is actually asking to run. */
export interface GrantRequest {
  readonly op: GrantOp;
  /** The request's arguments exactly as received; hashed via `canonicalizeArgs`. */
  readonly args: unknown;
}

export interface VerifyGrantInput {
  /** Untrusted: whatever arrived on the wire. */
  readonly grant: unknown;
  /** Base64 Ed25519 signature over `encodeGrant(grant)`. */
  readonly signature: string;
  /** The server public key pinned at enrollment (SPKI DER). */
  readonly serverPublicKey: Uint8Array;
  /** Injected clock, ms since epoch. */
  readonly now: number;
  readonly nonces: NonceStore;
  /** The env this daemon serves. */
  readonly expectedEnvId: string;
  /** The request the grant must be bound to. */
  readonly request: GrantRequest;
  readonly verify: Ed25519Verify;
  readonly hash: HashBytes;
}

const principalSchema = z
  .object({
    userId: z.string().min(1),
    sessionId: z.string().min(1),
    conversationId: z.string().min(1),
  })
  .strict();

// `.strict()` everywhere: an extra field is not "ignored", it is a malformed
// grant. A privileged-looking `isAdmin: true` riding along must fail closed.
const grantSchema = z
  .object({
    grantId: z.string().min(1),
    envId: z.string().min(1),
    principal: principalSchema,
    op: z.enum(GRANT_OPS),
    argsHash: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    nonce: z.string().min(1),
  })
  .strict();

/**
 * Canonical bytes for signing: a fixed key order with no whitespace, rebuilt
 * from the typed grant rather than serialized from whatever object the caller
 * held, so insertion order can never change the signed message.
 */
export function encodeGrant(grant: Grant): Uint8Array {
  const canonical = {
    grantId: grant.grantId,
    envId: grant.envId,
    principal: {
      userId: grant.principal.userId,
      sessionId: grant.principal.sessionId,
      conversationId: grant.principal.conversationId,
    },
    op: grant.op,
    argsHash: grant.argsHash,
    iat: grant.iat,
    exp: grant.exp,
    nonce: grant.nonce,
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

/**
 * Deterministic serialization of request arguments, so the server (when it
 * issues a grant) and the daemon (when it verifies one) hash identical bytes
 * regardless of key insertion order or transport. Object keys are sorted
 * recursively; arrays stay positional (arguments are ordered); `undefined`
 * values are dropped exactly as JSON drops them on the wire; types stay
 * distinct (`1` ≠ `'1'`, `null` ≠ absent).
 */
export function canonicalizeArgs(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  // string | number | boolean | bigint | symbol | function — JSON semantics for
  // the first three; the rest cannot arrive on the wire and serialize to null.
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict base64 → bytes; `null` for anything that is not well-formed base64. Shared by the other gates in this folder. */
export function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Length-then-XOR comparison that does not short-circuit on the first differing
 * character. Digests are not secrets, but the gate should not leak how much of
 * a hash matched either. Shared by the other gates in this folder.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function deny(reason: GrantDenyReason): GrantVerdict {
  return { ok: false, reason };
}

export function verifyGrant(input: VerifyGrantInput): GrantVerdict {
  const parsed = grantSchema.safeParse(input.grant);
  if (!parsed.success) return deny('malformed');
  const grant: Grant = parsed.data;

  if (grant.envId !== input.expectedEnvId) return deny('wrong_env');

  // Bind the grant to the frame carrying it BEFORE the signature: a signed grant
  // for other work is still the wrong grant, and this check is cheap.
  if (grant.op !== input.request.op) return deny('op_mismatch');
  let requestHash: string;
  try {
    requestHash = input.hash(canonicalizeArgs(input.request.args));
  } catch {
    return deny('args_mismatch');
  }
  if (!constantTimeEqual(requestHash, grant.argsHash)) return deny('args_mismatch');

  if (grant.exp - grant.iat > GRANT_MAX_TTL_MS) return deny('ttl_too_long');
  if (grant.iat > input.now + GRANT_MAX_CLOCK_SKEW_MS) return deny('clock_skew');
  if (grant.exp < input.now) return deny('expired');

  const signature = decodeBase64(input.signature);
  if (signature === null) return deny('bad_signature');
  let valid = false;
  try {
    valid = input.verify(encodeGrant(grant), signature, input.serverPublicKey);
  } catch {
    valid = false;
  }
  if (!valid) return deny('bad_signature');

  // Replay is checked last and the nonce recorded only now: a grant that failed
  // any check above has proven nothing and must not be able to burn a nonce.
  if (input.nonces.has(grant.nonce)) return deny('replayed');
  input.nonces.add(grant.nonce, grant.exp);
  return { ok: true, grant };
}

/**
 * The reference in-memory store. Suitable for the daemon (one process) and for
 * tests. Entries are kept until `evictExpired(now)` is called; a daemon should
 * call it periodically so the set cannot grow without bound.
 */
export function createMemoryNonceStore(): NonceStore & { evictExpired(now: number): void } {
  const seen = new Map<string, number>();
  return {
    has: (nonce) => seen.has(nonce),
    add: (nonce, exp) => {
      seen.set(nonce, exp);
    },
    evictExpired: (now) => {
      for (const [nonce, exp] of seen) {
        if (exp < now) seen.delete(nonce);
      }
    },
  };
}
