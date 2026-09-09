/**
 * The owner's click, proven to the MACHINE (hardening B).
 *
 * WHAT THIS CLOSES. Until now the daemon checked two things about the
 * `approvalIntent` on a re-issued grant: the Ed25519 signature under the
 * server key pinned at enrolment, and that the re-issued request byte-matched
 * the one it froze (`dispatcher.ts`, `decide-execution.ts`). Neither is a
 * proof that a HUMAN clicked — the owner-only check lived entirely in the web
 * route, which the daemon cannot observe. So anyone holding the signing key
 * AND the position of the server the daemon dials could drive the whole loop
 * alone: send a grant, read the `ask_pending:<id>` reply (which hands back the
 * challenge id and the frozen request), sign a second grant carrying
 * `approvalIntent { challengeId }`, and the byte-match passed by
 * construction. Only in chat-ask mode — the headless path GA was built for.
 *
 * The fix is that the owner's authenticator signs, and the MACHINE verifies:
 * a WebAuthn assertion over a challenge DERIVED from the exact request this
 * machine froze, under credentials pinned at enrolment when the owner was
 * provably at the keyboard. The server relays it and can neither forge it nor
 * move it.
 *
 * THE DERIVATION (leaf B2). The challenge is not random:
 *
 *   challenge = SHA256({ domain, envId, challengeId, requestHash })
 *   requestHash = SHA256(canonicalizeArgs(frozen request))
 *
 * so an assertion cannot be moved to another request (the request hash), to
 * another pending question (the challenge id), to another machine (the env
 * id) or to another message type (the domain). Both sides derive it
 * independently from what they each hold — the server from the frozen request
 * the machine SIGNED into the `grant_denied`, the daemon from the request it
 * actually froze — and it is the daemon's derivation that decides.
 *
 * THE VERIFIER (leaf B4). ES256 assertions are P-256 with ASN.1 DER
 * signatures, which `node:crypto` verifies natively, so nothing new is
 * depended on: COSE EC2 → JWK here (pure, total), `createPublicKey` and
 * `verify` in the adapters. Checks run in a FIXED order
 * (`OWNER_APPROVAL_DENY_ORDER`) exactly like `challenge.ts` and `grant.ts`,
 * and every one of them is total: a malformed COSE key, a truncated
 * assertion, hostile bytes, or an injected primitive that throws is a
 * REFUSAL, never an exception and never a pass.
 *
 * Pure by construction: SHA-256 and the ES256 verification primitive are
 * injected, there is no clock, and nothing here performs I/O.
 */
import { approvalAssertionSchema, canonicalizeArgs, constantTimeEqual, decodeBase64Url, encodeBase64Url, type ApprovalAssertion } from './grant';
import { OWNER_APPROVAL_SIGNING_DOMAIN } from './machine-signatures';
import type { PendingApproval } from './frame-codec';
import type { NormalizedRequest } from './decide-execution';

/** SHA-256 as BYTES (not the hex `HashBytes` the grant/result hashes use): a WebAuthn challenge is compared as base64url of the digest. Injected. */
export type Sha256Bytes = (bytes: Uint8Array) => Uint8Array;

/** A P-256 public key in the JWK shape `crypto.createPublicKey({ format: 'jwk' })` accepts. */
export interface EcJwkPublic {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  /** base64url, 32 bytes. */
  readonly x: string;
  /** base64url, 32 bytes. */
  readonly y: string;
}

/** ECDSA-P256-SHA256 verification over an ASN.1 DER signature, injected so this module stays free of `node:crypto`. Must never throw; a throwing one is treated as a refusal anyway. */
export type Es256Verify = (message: Uint8Array, signature: Uint8Array, publicKey: EcJwkPublic) => boolean;

/** The frozen request as the wire carries it — the same object the card renders and the machine signed into `grant_denied`. */
export type OwnerApprovalRequest = PendingApproval['request'];

/**
 * The daemon's `NormalizedRequest` projected to the wire shape. Defined ONCE,
 * here, because it is now load-bearing twice over: it is what the
 * `ask_pending` frame carries AND what the challenge derivation hashes, so
 * the two can never drift apart. Fresh copies of the arrays and the env map,
 * so freezing the normalised request does not freeze the wire one.
 */
export function pendingRequestForWire(request: NormalizedRequest): OwnerApprovalRequest {
  return {
    op: request.op,
    ...(request.cmd !== undefined && { cmd: request.cmd }),
    ...(request.args !== undefined && { args: [...request.args] }),
    cwd: request.cwd,
    paths: [...request.paths],
    env: { ...request.env },
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
    clamped: request.clamped,
  };
}

/**
 * `base64url(SHA256(canonicalizeArgs(request)))` over the WHOLE wire request
 * rather than a hand-listed projection: `canonicalizeArgs` sorts keys
 * recursively and drops `undefined` exactly as JSON does on the wire, so a
 * field the frozen request gains later (A1's `writeModes`, say) is covered
 * without an edit here — and an approval for one request can never be
 * replayed for a request that differs by a byte.
 */
export function ownerApprovalRequestHash(request: OwnerApprovalRequest, sha256: Sha256Bytes): string {
  return encodeBase64Url(sha256(canonicalizeArgs(request)));
}

export interface OwnerApprovalBinding {
  /** The environment the request is frozen on: an assertion never travels between machines. */
  readonly envId: string;
  /** The pending question the click answers. */
  readonly challengeId: string;
  /** The request the MACHINE froze (the daemon's own copy is what decides). */
  readonly request: OwnerApprovalRequest;
}

/** The WebAuthn challenge for one pending approval, as base64url — what `clientDataJSON.challenge` must equal. */
export function deriveOwnerApprovalChallenge(binding: OwnerApprovalBinding, sha256: Sha256Bytes): string {
  return encodeBase64Url(
    sha256(
      canonicalizeArgs({
        domain: OWNER_APPROVAL_SIGNING_DOMAIN,
        envId: binding.envId,
        challengeId: binding.challengeId,
        requestHash: ownerApprovalRequestHash(binding.request, sha256),
      }),
    ),
  );
}

// ---- what the machine pinned at enrolment ---------------------------------

/** One of the owner's passkeys, as pinned at enrolment: the credential id and its COSE public key, both base64url (the encoding `passkeys.publicKey` already uses). */
export interface PinnedOwnerCredential {
  readonly credentialId: string;
  readonly publicKeyCose: string;
}

/**
 * TRUST ON FIRST USE, the same shape the server public key already uses. The
 * relying-party id and origin are pinned alongside the credentials so an
 * assertion produced against any other site — including one a compromised
 * server points the browser at — fails on this machine. Written once, at
 * enrolment; no frame and no server response may add to it (leaf B5).
 */
export interface PinnedOwnerApproval {
  readonly rpId: string;
  readonly origin: string;
  readonly credentials: readonly PinnedOwnerCredential[];
}

// ---- the assertion the click carries ---------------------------------------

/**
 * The assertion's shape is the GRANT's wire format (`grant.ts`), parsed here
 * from the same schema rather than a second copy of it — a verifier and a
 * codec that disagree about what a field may hold is exactly the drift this
 * folder avoids everywhere else.
 */
const assertionSchema = approvalAssertionSchema;

export type OwnerApprovalAssertion = ApprovalAssertion;

export type OwnerApprovalDenyReason =
  /** Nothing was pinned at enrolment (or the pinning is unusable): this machine cannot prove a human, so it refuses rather than accept the server's word (leaf B5). */
  | 'no_pinned_credential'
  | 'malformed'
  | 'wrong_type'
  | 'challenge_mismatch'
  | 'origin_mismatch'
  | 'rp_mismatch'
  | 'user_not_present'
  | 'unknown_credential'
  /** The credential id matched a pinned entry whose stored COSE key cannot be read — re-enrol; never a pass. */
  | 'bad_credential'
  | 'bad_signature';

/** The FIXED order the checks run in, pinned by a test the way `challenge.ts` and `grant.ts` pin theirs. */
export const OWNER_APPROVAL_DENY_ORDER: readonly OwnerApprovalDenyReason[] = [
  'no_pinned_credential',
  'malformed',
  'wrong_type',
  'challenge_mismatch',
  'origin_mismatch',
  'rp_mismatch',
  'user_not_present',
  'unknown_credential',
  'bad_credential',
  'bad_signature',
];

export type OwnerApprovalVerdict = { readonly ok: true; readonly credentialId: string } | { readonly ok: false; readonly reason: OwnerApprovalDenyReason };

export interface VerifyOwnerApprovalInput {
  /** Untrusted: whatever arrived inside the grant's `approvalIntent`. */
  readonly assertion: unknown;
  /** What this machine pinned at enrolment. */
  readonly pinned: PinnedOwnerApproval;
  /** The env THIS daemon serves. */
  readonly envId: string;
  /** The pending question the click claims to answer. */
  readonly challengeId: string;
  /** The request THIS machine froze under that id — never one the server supplied. */
  readonly request: OwnerApprovalRequest;
  readonly sha256: Sha256Bytes;
  readonly verifyEs256: Es256Verify;
}

/** WebAuthn authenticator data: 32-byte rpIdHash, 1 flags byte, 4-byte counter. */
const AUTHENTICATOR_DATA_MIN_BYTES = 37;
const RP_ID_HASH_BYTES = 32;
const FLAG_USER_PRESENT = 0x01;

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
}

/** Total: `null` for anything that is not a JSON object carrying the three string fields the ceremony defines. */
function parseClientData(bytes: Uint8Array): ClientData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { type, challenge, origin } = parsed as Record<string, unknown>;
  if (typeof type !== 'string' || typeof challenge !== 'string' || typeof origin !== 'string') return null;
  return { type, challenge, origin };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function deny(reason: OwnerApprovalDenyReason): OwnerApprovalVerdict {
  return { ok: false, reason };
}

/**
 * The daemon's own gate on the owner's click. Deny order is fixed and tested:
 * no_pinned_credential → malformed → wrong_type → challenge_mismatch →
 * origin_mismatch → rp_mismatch → user_not_present → unknown_credential →
 * bad_credential → bad_signature. Cheap structural checks run before crypto,
 * exactly as `verifyGrant` does, and the signature is checked LAST so junk
 * never reaches the verification primitive.
 */
export function verifyOwnerApproval(input: VerifyOwnerApprovalInput): OwnerApprovalVerdict {
  // Nothing pinned ⇒ this machine cannot tell a human from the server. Refuse.
  if (input.pinned.credentials.length === 0 || input.pinned.rpId.length === 0 || input.pinned.origin.length === 0) return deny('no_pinned_credential');

  const parsed = assertionSchema.safeParse(input.assertion);
  if (!parsed.success) return deny('malformed');
  const authenticatorData = decodeBase64Url(parsed.data.authenticatorData);
  const clientDataJSON = decodeBase64Url(parsed.data.clientDataJSON);
  const signature = decodeBase64Url(parsed.data.signature);
  if (authenticatorData === null || clientDataJSON === null || signature === null) return deny('malformed');
  if (authenticatorData.length < AUTHENTICATOR_DATA_MIN_BYTES) return deny('malformed');
  const clientData = parseClientData(clientDataJSON);
  if (clientData === null) return deny('malformed');

  // The expected challenge is derived from the request THIS machine holds; a
  // primitive that throws makes the expectation unknowable, which is a refusal.
  let expectedChallenge: string;
  let rpIdHash: Uint8Array;
  let clientDataHash: Uint8Array;
  try {
    expectedChallenge = deriveOwnerApprovalChallenge({ envId: input.envId, challengeId: input.challengeId, request: input.request }, input.sha256);
    rpIdHash = input.sha256(new TextEncoder().encode(input.pinned.rpId));
    clientDataHash = input.sha256(clientDataJSON);
  } catch {
    return deny('malformed');
  }

  if (clientData.type !== 'webauthn.get') return deny('wrong_type');
  // THE PROPERTY: an assertion for any other request, question or environment
  // derives a different challenge and stops here.
  if (!constantTimeEqual(clientData.challenge, expectedChallenge)) return deny('challenge_mismatch');
  if (clientData.origin !== input.pinned.origin) return deny('origin_mismatch');
  if (!bytesEqual(authenticatorData.subarray(0, RP_ID_HASH_BYTES), rpIdHash)) return deny('rp_mismatch');
  if ((authenticatorData[RP_ID_HASH_BYTES]! & FLAG_USER_PRESENT) === 0) return deny('user_not_present');

  const credential = input.pinned.credentials.find((entry) => constantTimeEqual(entry.credentialId, parsed.data.credentialId));
  if (credential === undefined) return deny('unknown_credential');
  const coseBytes = decodeBase64Url(credential.publicKeyCose);
  const jwk = coseBytes === null ? null : coseEc2ToJwk(coseBytes);
  if (jwk === null) return deny('bad_credential');

  // What WebAuthn defines as signed: authenticatorData || SHA256(clientDataJSON).
  const signedBytes = new Uint8Array(authenticatorData.length + clientDataHash.length);
  signedBytes.set(authenticatorData, 0);
  signedBytes.set(clientDataHash, authenticatorData.length);
  let valid = false;
  try {
    valid = input.verifyEs256(signedBytes, signature, jwk);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, credentialId: credential.credentialId } : deny('bad_signature');
}

// ---- COSE EC2 → JWK --------------------------------------------------------

/**
 * A COSE_Key as WebAuthn stores it is a definite-length CBOR map of integer
 * labels. Nothing in this repo parsed CBOR, and pulling a decoder in for six
 * fields would be a dependency for an attack surface — so this reads exactly
 * the subset a COSE EC2 key can legally be, and refuses everything else with
 * `null`: indefinite lengths, 64-bit arguments, non-integer labels, nested
 * structures, and any trailing byte after the map. Total by construction —
 * every read is bounds-checked, so hostile bytes cannot throw.
 *
 * MUTATION NOTE. Every guard below is mutation-checked except two, and they
 * are named here rather than claimed: the indefinite/8-byte length refusal in
 * `readHead` and the byte-string bounds check in `readValue` are provably
 * SUBSUMED by the trailing-byte check at the end of `coseEc2ToJwk` — an
 * indefinite header decodes as a zero-entry map and a clamped byte string
 * leaves the cursor past the end, so both land on `cursor.offset !==
 * cose.length` and no input exists that only they refuse. They stay as
 * defence in depth; the trailing-byte check that carries them IS killed.
 */
const COSE_LABEL_KTY = 1;
const COSE_LABEL_ALG = 3;
const COSE_LABEL_CRV = -1;
const COSE_LABEL_X = -2;
const COSE_LABEL_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;
const P256_COORDINATE_BYTES = 32;

interface CborCursor {
  readonly bytes: Uint8Array;
  offset: number;
}

type CborValue = { readonly kind: 'int'; readonly value: number } | { readonly kind: 'bytes'; readonly value: Uint8Array };

/** Major type + argument, or `null` for anything outside the supported subset (8-byte arguments and indefinite lengths included). */
function readHead(cursor: CborCursor): { major: number; arg: number } | null {
  if (cursor.offset >= cursor.bytes.length) return null;
  const initial = cursor.bytes[cursor.offset]!;
  cursor.offset += 1;
  const major = initial >> 5;
  const minor = initial & 0x1f;
  if (minor < 24) return { major, arg: minor };
  const width = minor === 24 ? 1 : minor === 25 ? 2 : minor === 26 ? 4 : 0;
  if (width === 0) return null;
  if (cursor.offset + width > cursor.bytes.length) return null;
  let arg = 0;
  for (let i = 0; i < width; i += 1) arg = arg * 256 + cursor.bytes[cursor.offset + i]!;
  cursor.offset += width;
  return { major, arg };
}

function readValue(cursor: CborCursor): CborValue | null {
  const head = readHead(cursor);
  if (head === null) return null;
  if (head.major === 0) return { kind: 'int', value: head.arg };
  if (head.major === 1) return { kind: 'int', value: -1 - head.arg };
  if (head.major === 2) {
    if (cursor.offset + head.arg > cursor.bytes.length) return null;
    const value = cursor.bytes.subarray(cursor.offset, cursor.offset + head.arg);
    cursor.offset += head.arg;
    return { kind: 'bytes', value };
  }
  return null;
}

/** A COSE EC2 ES256 P-256 public key → the JWK `createPublicKey` takes; `null` for anything else, hostile bytes included. */
export function coseEc2ToJwk(cose: Uint8Array): EcJwkPublic | null {
  const cursor: CborCursor = { bytes: cose, offset: 0 };
  const head = readHead(cursor);
  if (head === null || head.major !== 5) return null;

  let kty: number | null = null;
  let alg: number | null = null;
  let crv: number | null = null;
  let x: Uint8Array | null = null;
  let y: Uint8Array | null = null;

  for (let entry = 0; entry < head.arg; entry += 1) {
    const label = readValue(cursor);
    if (label === null || label.kind !== 'int') return null;
    const value = readValue(cursor);
    if (value === null) return null;
    switch (label.value) {
      case COSE_LABEL_KTY:
        if (value.kind !== 'int') return null;
        kty = value.value;
        break;
      case COSE_LABEL_ALG:
        if (value.kind !== 'int') return null;
        alg = value.value;
        break;
      case COSE_LABEL_CRV:
        if (value.kind !== 'int') return null;
        crv = value.value;
        break;
      case COSE_LABEL_X:
        if (value.kind !== 'bytes') return null;
        x = value.value;
        break;
      case COSE_LABEL_Y:
        if (value.kind !== 'bytes') return null;
        y = value.value;
        break;
      default:
        // An unrecognised label is skipped, not fatal — the algorithm and
        // curve are asserted below, so an extra field cannot widen anything.
        break;
    }
  }
  // Trailing bytes mean this was not a bare COSE key; refuse rather than guess.
  if (cursor.offset !== cose.length) return null;
  if (kty !== COSE_KTY_EC2 || alg !== COSE_ALG_ES256 || crv !== COSE_CRV_P256) return null;
  if (x === null || y === null || x.length !== P256_COORDINATE_BYTES || y.length !== P256_COORDINATE_BYTES) return null;
  return { kty: 'EC', crv: 'P-256', x: encodeBase64Url(x), y: encodeBase64Url(y) };
}
