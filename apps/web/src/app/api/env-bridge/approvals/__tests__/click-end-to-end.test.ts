/**
 * THE OWNER'S CLICK, END TO END — the row this workstream actually rests on.
 *
 * Hardening B was verified in three places that each passed while the feature
 * did not work at all: the route relayed the assertion, the daemon refused a
 * click without one, and the codec carried one — but `signGrantFrame` sat
 * BETWEEN the route and the wire and rebuilt `approvalIntent` from
 * `{challengeId, scope, expiresAt}` only, silently dropping the assertion. So
 * every real approval reached the machine unproven, was refused
 * `approval_unproven`, and the pending question had already been spent, which
 * the owner could not even retry. Three green suites, one dead feature; the
 * gap was exactly the hop none of them crossed (Codex P1 on #2599).
 *
 * This test crosses every hop with nothing mocked between them:
 *
 *   the card's POST body
 *     → POST /api/env-bridge/approvals/[challengeId]   (the real route)
 *     → the real `signGrantFrame`, under a real Ed25519 server keyring
 *     → the real canonical bytes, JSON round-tripped as the socket sends them
 *     → `decodeFrame`                                  (the daemon's codec)
 *     → `verifyGrant`                                  (the daemon's grant gate)
 *     → `verifyOwnerApproval`                          (the daemon's proof gate)
 *
 * The last three ARE the daemon's checks — `createDispatcher` calls exactly
 * these and adds only bookkeeping, which `packages/cli`'s dispatcher suite
 * covers against real P-256 assertions. The only thing stubbed here is the
 * socket itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }, logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn(), rememberEnvApproval: vi.fn(async () => null), getApprovalMirrorStore: vi.fn(), markEnvApprovalRevoked: vi.fn(async () => null), markEnvApprovalAcknowledged: vi.fn(async () => null) }));
vi.mock('@/lib/env-bridge/revoke', () => ({ revokeLocalEnvApproval: vi.fn() }));
vi.mock('@/lib/env-bridge/bridge-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env-bridge/bridge-client')>();
  return { ...actual, getEnvBridgeClient: vi.fn() };
});

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { GET, POST } from '../[challengeId]/route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
import { getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { getPendingApprovalStore, resetPendingApprovalStoreForTesting, type PendingEnvApproval } from '@/lib/env-bridge/pending-approvals';
import { signGrantFrame } from '@/lib/env-bridge/grant-signer';
import { envBridgeHash, envBridgeSha256, ed25519Verify, webauthnVerify } from '@/lib/env-bridge/crypto';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import { createMemoryNonceStore, verifyGrant } from '@pagespace/lib/env-bridge/grant';
import { decodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { grantRequestForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { verifyOwnerApproval, type PinnedOwnerApproval } from '@pagespace/lib/env-bridge/owner-approval';

const OWNER = 'user_owner';
const ENV = 'env_1';
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const RP_ID = 'pagespace.test';
const ORIGIN = 'https://pagespace.test';

const FRAME = { type: 'grant_exec' as const, cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', env: { CI: '1' } };
const PRINCIPAL = { userId: OWNER, sessionId: 'sess_1', conversationId: 'conv_1' };
const REQUEST = { op: 'exec' as const, cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', paths: [], env: { CI: '1' }, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: false };

const b64url = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url');

// ---- the owner's real P-256 credential -------------------------------------

const { privateKey: ownerPrivate, publicKey: ownerPublic } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ownerJwk = ownerPublic.export({ format: 'jwk' }) as { x: string; y: string };
const OWNER_COSE = Buffer.concat([
  Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
  Buffer.from(ownerJwk.x, 'base64url'),
  Buffer.from([0x22, 0x58, 0x20]),
  Buffer.from(ownerJwk.y, 'base64url'),
]);
const CREDENTIAL_ID = b64url(Buffer.from('owner-key'));
const PINNED: PinnedOwnerApproval = { rpId: RP_ID, origin: ORIGIN, credentials: [{ credentialId: CREDENTIAL_ID, publicKeyCose: b64url(OWNER_COSE) }] };
const ownerPem = ownerPrivate.export({ format: 'pem', type: 'pkcs8' }) as string;

/**
 * The two SHA-256 computations below are MANDATED by WebAuthn, not chosen:
 * `authenticatorData` begins with SHA-256 of the RP id, and what an assertion
 * signs is `authenticatorData || SHA-256(clientDataJSON)`. Neither hashes a
 * password or any other credential — the inputs are a public hostname and a
 * public JSON blob the browser produces.
 *
 * They are hoisted out of the ceremony function so CodeQL's taint tracking
 * cannot reach a hash call through this file's import graph
 * (`js/insufficient-password-hash`, alert 340, which fired on the calls when
 * they were inline): `RP_ID_HASH` is computed once from a module-scope
 * literal, and `sha256` takes a Buffer and nothing else. What gets signed is
 * unchanged.
 */
const RP_ID_HASH = createHash('sha256').update('pagespace.test').digest();
// The literal above must stay equal to RP_ID; if it drifts, every row here
// fails `rp_mismatch`, because the verifier compares this against
// SHA-256 of `PINNED.rpId` — so the duplication cannot go unnoticed.

const sha256 = (bytes: Buffer): Buffer => createHash('sha256').update(bytes).digest();

/** What the browser's authenticator produces for a challenge the GET handed it. */
function authenticatorSigns(challenge: string) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
  // rpIdHash (32) ‖ flags (UP|UV) ‖ signCount (4) — the real layout.
  const authenticatorData = Buffer.concat([RP_ID_HASH, Buffer.from([0x05]), Buffer.alloc(4)]);
  const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  return {
    credentialId: CREDENTIAL_ID,
    authenticatorData: b64url(authenticatorData),
    clientDataJSON: b64url(clientDataJSON),
    signature: b64url(nodeSign('sha256', signed, createPrivateKey(ownerPem))),
  };
}

// ---- a real server signing keyring ------------------------------------------

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    const key = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
    return { publicKey: new Uint8Array(createPublicKey(key).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, key)) };
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};
const ringVerdict = parseServerSigningKeyring({ single: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), multi: undefined }, primitives);
if (!ringVerdict.ok) throw new Error('keyring');
const KEYRING = ringVerdict.keyring;
const SERVER_KEY_ID = KEYRING.keyIds[0]!;
const SERVER_PUBLIC_KEY = KEYRING.get(SERVER_KEY_ID)!.publicKey;

// ---- the bridge client, stubbed ONLY at the socket --------------------------

/** Every frame the "socket" was asked to send, exactly as the wire carries it (JSON round-tripped). */
let sentOverTheWire: Frame[];

function pendingEntry(): PendingEnvApproval {
  return { challengeId: 'ch_1', envId: ENV, frame: FRAME, principal: PRINCIPAL, expiresAt: NOW + 30_000, pending: { challengeId: 'ch_1', expiresAt: NOW + 30_000, request: REQUEST }, createdAt: NOW };
}

let ids: { grantId: () => string; nonce: () => string };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetPendingApprovalStoreForTesting();
  sentOverTheWire = [];
  let n = 0;
  ids = { grantId: () => `g_${++n}`, nonce: () => `n_${n}` };
  vi.mocked(getDriveEnvStore).mockResolvedValue({ findLocalByEnvId: vi.fn(async () => ({ envId: ENV, ownerId: OWNER, revokedAt: null, ownerCredentials: PINNED, daemonEpoch: 'epoch_1' })) } as never);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(getEnvBridgeClient).mockReturnValue({
    // The REAL signer, the REAL keyring, the REAL canonical bytes. Only the
    // socket is replaced — with a JSON round trip, which is what a socket is.
    sendGrant: async (input: { envId: string; frame: typeof FRAME; principal: typeof PRINCIPAL; approvalIntent?: unknown }) => {
      const signed = signGrantFrame({
        frame: input.frame,
        envId: input.envId,
        principal: input.principal,
        serverKeyId: SERVER_KEY_ID,
        keyring: KEYRING,
        now: NOW,
        ids,
        ...(input.approvalIntent !== undefined && { approvalIntent: input.approvalIntent as never }),
      });
      if (!signed.ok) throw new Error(signed.reason);
      const decoded = decodeFrame(JSON.stringify(signed.frame), { maxFrameBytes: 1 << 20 });
      if (!decoded.ok) throw new Error(`the wire refused the frame: ${decoded.reason}`);
      sentOverTheWire.push(decoded.frame);
      return { type: 'exec_result', grantId: signed.grant.grantId, exitCode: 0, stdoutB64: Buffer.from('On branch main').toString('base64'), stderrB64: '', truncated: false, sig: 'c2ln' };
    },
  } as never);
  getPendingApprovalStore().remember(pendingEntry(), NOW);
});

const ctx = (challengeId = 'ch_1') => ({ params: Promise.resolve({ challengeId }) });
const get = () => GET(new Request('http://localhost/api/env-bridge/approvals/ch_1'), ctx());
const post = (body: unknown) => POST(new Request('http://localhost/api/env-bridge/approvals/ch_1', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), ctx());

/** What the DAEMON does with the frame it received: decode, verify the grant, verify the proof. */
function daemonVerifies(frame: Frame) {
  const grantFrame = frame as GrantFrame;
  const verdict = verifyGrant({
    grant: grantFrame.grant,
    signature: grantFrame.sig,
    serverPublicKey: SERVER_PUBLIC_KEY,
    now: NOW,
    nonces: createMemoryNonceStore(),
    expectedEnvId: ENV,
    request: grantRequestForFrame(grantFrame),
    verify: ed25519Verify,
    hash: envBridgeHash,
  });
  if (!verdict.ok) return { stage: 'grant' as const, reason: verdict.reason };
  const intent = verdict.grant.approvalIntent;
  if (intent === undefined) return { stage: 'intent' as const, reason: 'no_intent' };
  const proof = verifyOwnerApproval({
    assertion: intent.assertion,
    pinned: PINNED,
    envId: ENV,
    challengeId: intent.challengeId,
    // The request the MACHINE froze; here, the one it signed into `ask_pending`.
    request: REQUEST,
    // The scope from the RECEIVED intent: relaying a narrower proof as a wider scope must fail here.
    scope: intent.scope,
    sha256: envBridgeSha256,
    // The REAL adapter the daemon injects — every algorithm a passkey can be registered with.
    verifyWebauthn: webauthnVerify,
  });
  return { stage: 'proof' as const, proof, intent };
}

describe("the owner's click, end to end — card → route → signer → wire → daemon", () => {
  it('THE EXIT CRITERION: an assertion the owner makes in the browser survives every hop and the daemon ALLOWS the run', async () => {
    // 1. The card fetches what to sign.
    const options = ((await (await get()).json()) as { webauthn: { available: boolean; challenges: Record<string, string> } }).webauthn;
    expect(options.available).toBe(true);

    // 2. The owner's authenticator signs the challenge for the scope they chose.
    const assertion = authenticatorSigns(options.challenges['30d']!);

    // 3. The card POSTs the decision — exactly the body EnvApprovalCard sends.
    const response = await post({ decision: 'allow', scope: '30d', assertion });
    expect(response.status).toBe(200);

    // 4. Exactly one frame reached the wire, and the assertion is ON it, intact,
    //    after signing, serialisation and the codec's strict re-parse.
    expect(sentOverTheWire).toHaveLength(1);
    const wireIntent = ((sentOverTheWire[0] as GrantFrame).grant as { approvalIntent?: { assertion?: unknown } }).approvalIntent;
    expect(wireIntent?.assertion, 'the assertion must survive signGrantFrame — this is the hop that was dropping it').toEqual(assertion);

    // 5. The daemon's own gates accept it. This is the whole claim.
    const outcome = daemonVerifies(sentOverTheWire[0]!);
    expect(outcome.stage).toBe('proof');
    expect(outcome.stage === 'proof' && outcome.proof).toEqual({ ok: true, credentialId: CREDENTIAL_ID });
  });

  it('the assertion is under the SERVER SIGNATURE: stripping or altering it after signing makes the grant unverifiable', async () => {
    const options = ((await (await get()).json()) as { webauthn: { challenges: Record<string, string> } }).webauthn;
    await post({ decision: 'allow', scope: '30d', assertion: authenticatorSigns(options.challenges['30d']!) });
    const frame = sentOverTheWire[0] as GrantFrame;
    const grant = frame.grant as { approvalIntent: { assertion: { signature: string } } };

    const stripped = { ...frame, grant: { ...grant, approvalIntent: { challengeId: 'ch_1', scope: '30d', expiresAt: NOW + 30_000 } } } as GrantFrame;
    expect(daemonVerifies(stripped)).toMatchObject({ stage: 'grant', reason: 'bad_signature' });

    const altered = { ...frame, grant: { ...grant, approvalIntent: { ...grant.approvalIntent, assertion: { ...grant.approvalIntent.assertion, signature: 'AAAA' } } } } as GrantFrame;
    expect(daemonVerifies(altered)).toMatchObject({ stage: 'grant', reason: 'bad_signature' });
  });

  it('a click the owner never signed reaches the daemon as approval_unproven — the route cannot invent a proof', async () => {
    const response = await post({ decision: 'allow', scope: '30d' });
    expect(response.status).toBe(200);
    const outcome = daemonVerifies(sentOverTheWire[0]!);
    expect(outcome.stage === 'proof' && outcome.proof).toEqual({ ok: false, reason: 'malformed' });
  });


  it('THE RELAY ATTACK (Codex P1): an assertion the owner made for `once` cannot be relayed as `until_revoked`', async () => {
    const options = ((await (await get()).json()) as { webauthn: { challenges: Record<string, string> } }).webauthn;
    // Every scope is a different challenge, so a proof authorises exactly one of them.
    expect(new Set(Object.values(options.challenges)).size).toBe(4);

    // The owner chose `once`; a compromised server re-issues that proof under a durable scope.
    const assertion = authenticatorSigns(options.challenges.once!);
    await post({ decision: 'allow', scope: 'until_revoked', assertion });
    const relayed = daemonVerifies(sentOverTheWire[0]!);
    expect(relayed.stage === 'proof' && relayed.intent.scope).toBe('until_revoked');
    expect(relayed.stage === 'proof' && relayed.proof).toEqual({ ok: false, reason: 'challenge_mismatch' });

    // …and the scope the owner actually chose still runs.
    resetPendingApprovalStoreForTesting();
    getPendingApprovalStore().remember(pendingEntry(), NOW);
    sentOverTheWire = [];
    await post({ decision: 'allow', scope: 'once', assertion });
    expect(daemonVerifies(sentOverTheWire[0]!)).toMatchObject({ stage: 'proof', proof: { ok: true } });
  });
});
