/**
 * The bytes a machine signs (hello, results) and the bytes the server signs
 * for a revoke — defined ONCE here so the daemon (t08) and the socket route
 * (t07) agree by construction. Adversarial matrix per message: the right key
 * verifies; a rogue key, a tampered field, a wrong env, a cross-domain
 * signature and a malformed signature each fail for the stated reason.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createHash } from 'node:crypto';
import type { Ed25519Verify, HashBytes } from '../grant';
import type { Frame } from '../frame-codec';
import { FRAME_TYPES, MACHINE_TO_SERVER_FRAME_TYPES, SERVER_TO_MACHINE_FRAME_TYPES, isMachineToServerFrame } from '../frame-codec';
import {
  encodeHelloForSigning,
  encodeResultForSigning,
  encodeRevokeForSigning,
  resultHashForFrame,
  resultPayloadForFrame,
  machineResultBindingId,
  approvalRevokeBindingId,
  encodeApprovalRevokeForSigning,
  REVOKE_APPROVAL_SIGNING_DOMAIN,
  REVOKE_SIGNING_DOMAIN,
  verifyHello,
  verifyMachineResult,
  verifyRevoke,
  isMachineResultFrame,
  MACHINE_RESULT_FRAME_TYPES,
  type MachineResultFrame,
  PAUSE_SIGNING_DOMAIN,
  encodePauseForSigning,
  verifyPause,
  pauseBindingId,
  type PauseFrame,
} from '../machine-signatures';

const machine = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const server = generateKeyPairSync('ed25519');
const spki = (key: typeof machine) => new Uint8Array(key.publicKey.export({ type: 'spki', format: 'der' }));
const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signWith = (key: typeof machine, bytes: Uint8Array) => Buffer.from(nodeSign(null, bytes, key.privateKey)).toString('base64');

const capabilities = { shell: true, pty: false, fs: true, checkpoint: false };
const helloBody = { envId: 'env-1', capabilities, policyDigest: 'sha256:abc' , daemonEpoch: 'ep1' };
const signedHello = (over: Partial<typeof helloBody> = {}, key = machine): Extract<Frame, { type: 'hello' }> => {
  const body = { ...helloBody, ...over };
  return { type: 'hello', ...body, sig: signWith(key, encodeHelloForSigning(body)) };
};

describe('hello — the machine-signed first frame', () => {
  it('given a hello signed by the pinned machine key over the defined bytes, should verify', () => {
    expect(verifyHello({ hello: signedHello(), expectedEnvId: 'env-1', machinePublicKey: spki(machine), verify })).toEqual({ ok: true });
  });

  it('given a hello signed by another key, should deny bad_signature', () => {
    expect(verifyHello({ hello: signedHello({}, rogue), expectedEnvId: 'env-1', machinePublicKey: spki(machine), verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given a hello for another env — even correctly signed — should deny wrong_env BEFORE touching crypto', () => {
    let called = 0;
    const counting: Ed25519Verify = (...args) => {
      called += 1;
      return verify(...args);
    };
    expect(verifyHello({ hello: signedHello({ envId: 'env-2' }), expectedEnvId: 'env-1', machinePublicKey: spki(machine), verify: counting })).toEqual({ ok: false, reason: 'wrong_env' });
    expect(called).toBe(0);
  });

  it.each([
    ['capabilities.fs flipped', (h: ReturnType<typeof signedHello>) => ({ ...h, capabilities: { ...h.capabilities, fs: false } })],
    ['capabilities.shell flipped', (h: ReturnType<typeof signedHello>) => ({ ...h, capabilities: { ...h.capabilities, shell: false } })],
    ['policyDigest changed', (h: ReturnType<typeof signedHello>) => ({ ...h, policyDigest: 'sha256:evil' })],
  ])('given a signed hello with %s after signing, should deny bad_signature', (_label, tamper) => {
    expect(verifyHello({ hello: tamper(signedHello()), expectedEnvId: 'env-1', machinePublicKey: spki(machine), verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([['', 'empty'], ['not*base64', 'not base64'], ['YWJj', 'wrong length but valid base64']])('given sig %j (%s), should deny malformed / bad_signature without throwing', (sig) => {
    const verdict = verifyHello({ hello: { ...signedHello(), sig }, expectedEnvId: 'env-1', machinePublicKey: spki(machine), verify });
    expect(verdict.ok).toBe(false);
    expect(['malformed', 'bad_signature']).toContain((verdict as { reason: string }).reason);
  });

  it('given a signature over the RESULT bytes carrying the same strings, should not verify as a hello (domain separation)', () => {
    const crossed = { type: 'hello' as const, ...helloBody, sig: signWith(machine, encodeResultForSigning({ grantId: 'env-1', resultHash: 'sha256:abc' })) };
    expect(verifyHello({ hello: crossed, expectedEnvId: 'env-1', machinePublicKey: spki(machine), verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the same hello with fields in a different insertion order, should encode identical bytes', () => {
    const a = encodeHelloForSigning({ envId: 'e', capabilities: { shell: true, pty: true, fs: false, checkpoint: false }, policyDigest: 'd', daemonEpoch: 'ep' });
    const b = encodeHelloForSigning({ daemonEpoch: 'ep', policyDigest: 'd', capabilities: { checkpoint: false, fs: false, pty: true, shell: true }, envId: 'e' } as typeof helloBody);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

type UnsignedResult = { [K in MachineResultFrame['type']]: Omit<Extract<MachineResultFrame, { type: K }>, 'sig'> };
const results: UnsignedResult = {
  exec_result: { type: 'exec_result', grantId: 'g1', exitCode: 0, stdoutB64: 'b3V0', stderrB64: '', truncated: false },
  fs_read_result: { type: 'fs_read_result', grantId: 'g2', found: true, contentB64: 'ZGF0YQ==' },
  fs_write_result: { type: 'fs_write_result', grantId: 'g3', ok: true },
  grant_denied: { type: 'grant_denied', grantId: 'g4', reason: 'policy_denied' },
  approval_revoke_result: { type: 'approval_revoke_result', approvalId: 'ch_9', removed: 1 },
  pause_result: { type: 'pause_result', envId: 'e1', pausedAt: 1_800_000_000_000, killed: 1 },
};

function signResult(body: Omit<MachineResultFrame, 'sig'>, key = machine): MachineResultFrame {
  const frame = { ...body, sig: '' } as MachineResultFrame;
  const resultHash = resultHashForFrame(frame, hash);
  return { ...body, sig: signWith(key, encodeResultForSigning({ grantId: machineResultBindingId(frame), resultHash })) } as MachineResultFrame;
}

const PENDING = { challengeId: 'ch_1', expiresAt: 1_800_000_060_000, request: { op: 'exec' as const, cmd: 'git', args: ['status'], cwd: '/home/u/proj', paths: [], env: {}, timeoutMs: 1000, maxBytes: 1024, clamped: false } };

describe('GA wave 2 — a grant_denied carrying a PENDING frozen request is signed over that request too', () => {
  const denied = { type: 'grant_denied' as const, grantId: 'g5', reason: 'ask_pending:ch_1', pending: PENDING };

  it('should verify when signed as sent, and its payload names every field of the frozen request', () => {
    const frame = signResult(denied);
    expect(verifyMachineResult({ frame, machinePublicKey: spki(machine), verify, hash })).toMatchObject({ ok: true });
    expect(resultPayloadForFrame(frame)).toEqual({ type: 'grant_denied', grantId: 'g5', reason: 'ask_pending:ch_1', pending: PENDING });
    // Absent pending hashes as null, distinctly from any present one.
    expect(resultPayloadForFrame({ ...results.grant_denied, sig: '' } as MachineResultFrame)).toEqual({ type: 'grant_denied', grantId: 'g4', reason: 'policy_denied', pending: null });
  });

  it.each([
    ['cmd', { ...PENDING, request: { ...PENDING.request, cmd: 'rm' } }],
    ['args', { ...PENDING, request: { ...PENDING.request, args: ['push', '--force'] } }],
    ['cwd', { ...PENDING, request: { ...PENDING.request, cwd: '/etc' } }],
    ['env', { ...PENDING, request: { ...PENDING.request, env: { LD_PRELOAD: '/evil.so' } } }],
    ['challengeId', { ...PENDING, challengeId: 'ch_other' }],
    ['expiresAt', { ...PENDING, expiresAt: PENDING.expiresAt + 1 }],
    ['removed', undefined],
  ])('given pending.%s altered after signing, should deny bad_signature — the card can only show what the machine froze', (_label, pending) => {
    const signed = signResult(denied);
    const frame = { ...denied, ...(pending === undefined ? { pending: undefined } : { pending }), sig: signed.sig } as MachineResultFrame;
    expect(verifyMachineResult({ frame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('results — machine-signed over {grantId, resultHash} (invariant 7)', () => {
  it.each(Object.keys(results) as MachineResultFrame['type'][])('given a %s signed by the pinned key, should verify and return the resultHash it covers', (type) => {
    const frame = signResult(results[type]);
    const verdict = verifyMachineResult({ frame, machinePublicKey: spki(machine), verify, hash });
    expect(verdict).toEqual({ ok: true, resultHash: resultHashForFrame(frame, hash) });
  });

  it.each(Object.keys(results) as MachineResultFrame['type'][])('given a %s signed by a rogue key, should deny bad_signature', (type) => {
    expect(verifyMachineResult({ frame: signResult(results[type], rogue), machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['exec_result.exitCode', { ...results.exec_result, exitCode: 1 }],
    ['exec_result.stdoutB64', { ...results.exec_result, stdoutB64: 'ZXZpbA==' }],
    ['exec_result.stderrB64', { ...results.exec_result, stderrB64: 'ZXZpbA==' }],
    ['exec_result.truncated', { ...results.exec_result, truncated: true }],
    ['fs_read_result.found', { ...results.fs_read_result, found: false }],
    ['fs_read_result.contentB64', { ...results.fs_read_result, contentB64: 'ZXZpbA==' }],
    ['fs_write_result.ok', { ...results.fs_write_result, ok: false }],
    ['fs_write_result.error', { ...results.fs_write_result, error: 'disk full' }],
    ['grant_denied.reason', { ...results.grant_denied, reason: 'other' }],
    ['grant_denied.pending (added)', { ...results.grant_denied, pending: PENDING }],
  ] as Array<[string, UnsignedResult[keyof UnsignedResult]]>)('given %s changed after signing, should deny bad_signature — every payload field is covered', (_label, tampered) => {
    const original = results[tampered.type];
    const signed = signResult(original);
    const frame = { ...tampered, sig: signed.sig } as MachineResultFrame;
    expect(verifyMachineResult({ frame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the grantId swapped onto another grant after signing, should deny bad_signature (a result cannot be replayed under another grant)', () => {
    const signed = signResult(results.exec_result);
    expect(verifyMachineResult({ frame: { ...signed, grantId: 'g-other' } as MachineResultFrame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given fs_read_result with contentB64 absent vs empty, should hash distinctly (absent is not empty)', () => {
    const absent = resultHashForFrame({ type: 'fs_read_result', grantId: 'g', found: false, sig: '' }, hash);
    const empty = resultHashForFrame({ type: 'fs_read_result', grantId: 'g', found: false, contentB64: '', sig: '' }, hash);
    expect(absent).not.toBe(empty);
  });

  it('given a malformed sig, should deny malformed without throwing', () => {
    const frame = { ...results.exec_result, sig: '!!' } as MachineResultFrame;
    expect(verifyMachineResult({ frame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given a verify primitive that throws, should deny bad_signature rather than crash the socket handler', () => {
    const throwing: Ed25519Verify = () => {
      throw new Error('boom');
    };
    expect(verifyMachineResult({ frame: signResult(results.exec_result), machinePublicKey: spki(machine), verify: throwing, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('should name exactly the exec/fs/denied result frames — PTY frames and pong are outside this verifier by design ([D-2])', () => {
    expect([...MACHINE_RESULT_FRAME_TYPES].sort()).toEqual(['approval_revoke_result', 'exec_result', 'fs_read_result', 'fs_write_result', 'grant_denied', 'pause_result']);
    expect(isMachineResultFrame({ type: 'pty_data', sessionId: 's', seq: 0, dataB64: '' })).toBe(false);
    expect(isMachineResultFrame({ type: 'pty_exit', sessionId: 's', code: 0 })).toBe(false);
    expect(isMachineResultFrame({ type: 'pong', ts: 1 })).toBe(false);
    expect(isMachineResultFrame({ type: 'exec_result', grantId: 'g', exitCode: 0, stdoutB64: '', stderrB64: '', truncated: false, sig: '' })).toBe(true);
  });
});

describe('GA wave 2 — revoking ONE approval rides the revoke frame under its own domain', () => {
  const binding = { envId: 'env_1', enrollmentId: 'enr_1', keyId: 'srv-k1', issuedAt: 1_800_000_000_000 };
  const approvalRevoke = (key = server, approvalId = 'ch_1'): Extract<Frame, { type: 'revoke' }> => ({
    type: 'revoke',
    approvalId,
    issuedAt: binding.issuedAt,
    reason: 'owner_revoked_approval',
    sig: signWith(key, encodeApprovalRevokeForSigning({ ...binding, approvalId })),
  });
  const check = (frame: Extract<Frame, { type: 'revoke' }>) => verifyRevoke({ frame, ...binding, serverPublicKey: spki(server), verify });

  it('given an approval revoke signed by the pinned key for THIS enrollment and id, should verify', () => {
    expect(check(approvalRevoke())).toEqual({ ok: true });
  });

  it('given the approvalId STRIPPED from a signed approval revoke, should deny bad_signature — it can never become an enrollment revoke (a key deletion)', () => {
    const { approvalId: _dropped, ...stripped } = approvalRevoke();
    expect(check(stripped as Extract<Frame, { type: 'revoke' }>)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given an approvalId ADDED to a signed enrollment revoke, should deny bad_signature — the reverse is closed too', () => {
    const full: Extract<Frame, { type: 'revoke' }> = { type: 'revoke', issuedAt: binding.issuedAt, sig: signWith(server, encodeRevokeForSigning(binding)) };
    expect(check(full)).toEqual({ ok: true });
    expect(check({ ...full, approvalId: 'ch_1' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given a different approvalId, enrollment, or a rogue key, should deny bad_signature', () => {
    expect(check({ ...approvalRevoke(), approvalId: 'ch_other' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRevoke({ frame: approvalRevoke(), ...binding, enrollmentId: 'enr_other', serverPublicKey: spki(server), verify })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check(approvalRevoke(rogue))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('the two domains differ, and the enrollment revoke bytes are exactly what they were', () => {
    expect(REVOKE_APPROVAL_SIGNING_DOMAIN).not.toBe(REVOKE_SIGNING_DOMAIN);
    expect(Buffer.from(encodeRevokeForSigning(binding)).toString()).toBe(JSON.stringify({ domain: REVOKE_SIGNING_DOMAIN, ...binding }));
  });
});

describe('GA wave 2 (Codex P2 on #2583) — the approval-revoke ACK is a machine result signed over {approvalId, removed}', () => {
  const ack = { type: 'approval_revoke_result' as const, approvalId: 'ch_1', removed: 2 };
  const signAck = (body = ack, key = machine): MachineResultFrame => {
    const frame = { ...body, sig: '' } as MachineResultFrame;
    return { ...body, sig: signWith(key, encodeResultForSigning({ grantId: machineResultBindingId(frame), resultHash: resultHashForFrame(frame, hash) })) } as MachineResultFrame;
  };

  it('should verify under the pinned machine key, bound to the namespaced approval id (never a grant id)', () => {
    expect(verifyMachineResult({ frame: signAck(), machinePublicKey: spki(machine), verify, hash })).toMatchObject({ ok: true });
    expect(machineResultBindingId({ ...ack, sig: '' } as MachineResultFrame)).toBe('approval-revoke:ch_1');
    expect(approvalRevokeBindingId('ch_1')).toBe('approval-revoke:ch_1');
  });

  it.each([
    ['approvalId', { ...ack, approvalId: 'ch_2' }],
    ['removed', { ...ack, removed: 0 }],
  ])('given %s edited after signing, should deny bad_signature — the server may only claim what the machine signed', (_label, tampered) => {
    const signed = signAck();
    expect(verifyMachineResult({ frame: { ...tampered, sig: signed.sig } as MachineResultFrame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given an ack signed by a rogue key, should deny bad_signature', () => {
    expect(verifyMachineResult({ frame: signAck(ack, rogue), machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('revoke — server-signed over {envId, enrollmentId, keyId, issuedAt}', () => {
  const binding = { envId: 'env-1', enrollmentId: 'enr-1', keyId: 'k1', issuedAt: 1_700_000_000_000 };
  const revokeFrame = (key = server, over: Partial<typeof binding> = {}): Extract<Frame, { type: 'revoke' }> => ({
    type: 'revoke',
    issuedAt: binding.issuedAt,
    reason: 'owner_revoked',
    sig: signWith(key, encodeRevokeForSigning({ ...binding, ...over })),
  });

  it('given a revoke signed by the pinned server key for THIS enrollment, should verify', () => {
    expect(verifyRevoke({ frame: revokeFrame(), ...binding, serverPublicKey: spki(server), verify })).toEqual({ ok: true });
  });

  it.each([
    ['envId', { envId: 'env-2' }],
    ['enrollmentId', { enrollmentId: 'enr-2' }],
    ['keyId', { keyId: 'k2' }],
    ['issuedAt', { issuedAt: 1 }],
  ] as Array<[string, Partial<typeof binding>]>)('given a revoke signed for a different %s, should deny bad_signature — the frame binds all four', (_label, over) => {
    expect(verifyRevoke({ frame: revokeFrame(server, over), ...binding, serverPublicKey: spki(server), verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given a revoke signed by a rogue key, should deny bad_signature', () => {
    expect(verifyRevoke({ frame: revokeFrame(rogue), ...binding, serverPublicKey: spki(server), verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the reason changed, should still verify — reason is advisory and unsigned', () => {
    expect(verifyRevoke({ frame: { ...revokeFrame(), reason: 'other' }, ...binding, serverPublicKey: spki(server), verify })).toEqual({ ok: true });
  });
});

describe('frame direction — the closed set split by who may send what', () => {
  it('should partition FRAME_TYPES exactly: every type in one direction, none in both', () => {
    const union = new Set([...MACHINE_TO_SERVER_FRAME_TYPES, ...SERVER_TO_MACHINE_FRAME_TYPES]);
    expect([...union].sort()).toEqual([...FRAME_TYPES].sort());
    for (const type of MACHINE_TO_SERVER_FRAME_TYPES) expect(SERVER_TO_MACHINE_FRAME_TYPES.has(type)).toBe(false);
  });

  it('should classify a grant/revoke/ping as server→machine and results/hello/pong as machine→server', () => {
    expect(isMachineToServerFrame({ type: 'hello', envId: 'e', capabilities, policyDigest: '', daemonEpoch: 'ep', sig: '' })).toBe(true);
    expect(isMachineToServerFrame({ type: 'pong', ts: 1 })).toBe(true);
    expect(isMachineToServerFrame({ type: 'revoke', sig: '', issuedAt: 1 })).toBe(false);
    expect(isMachineToServerFrame({ type: 'grant_exec', grant: {}, sig: '', cmd: 'ls' })).toBe(false);
    expect(isMachineToServerFrame({ type: 'ping', ts: 1 })).toBe(false);
  });
});

describe('GA wave 3 — STOP: the pause frame is server-signed under its OWN domain, and its ack is a machine result bound to pause:<envId>:<pausedAt>', () => {
  const binding = { envId: 'env_1', enrollmentId: 'enr_1', keyId: 'srv-k1', issuedAt: 1_800_000_000_000 };
  const pausedAt = 1_800_000_000_500;
  const pauseFrame = (over: Partial<PauseFrame> = {}, key = server): PauseFrame => ({ type: 'pause', issuedAt: binding.issuedAt, pausedAt, sig: signWith(key, encodePauseForSigning({ ...binding, pausedAt })), ...over });
  const verifyInput = (frame: PauseFrame) => ({ frame, ...binding, serverPublicKey: spki(server), verify });

  it('should verify a pause signed by the pinned server key over {envId, enrollmentId, keyId, issuedAt, pausedAt}', () => {
    expect(verifyPause(verifyInput(pauseFrame()))).toEqual({ ok: true });
    expect(PAUSE_SIGNING_DOMAIN).not.toBe(REVOKE_SIGNING_DOMAIN);
    expect(PAUSE_SIGNING_DOMAIN).not.toBe(REVOKE_APPROVAL_SIGNING_DOMAIN);
  });

  it.each([
    ['pausedAt edited', (f: PauseFrame) => ({ ...f, pausedAt: pausedAt + 1 })],
    ['issuedAt edited', (f: PauseFrame) => ({ ...f, issuedAt: binding.issuedAt + 1 })],
    ['rogue key', () => pauseFrame({}, rogue)],
  ])('given %s, should deny bad_signature', (_label, mutate) => {
    expect(verifyPause(verifyInput(mutate(pauseFrame())))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a pause signature can never verify as a revoke (of the enrollment or of an approval), nor a revoke signature as a pause — domain separation', () => {
    const pauseSig = pauseFrame().sig;
    const asRevoke = { type: 'revoke' as const, issuedAt: binding.issuedAt, sig: pauseSig };
    expect(verifyRevoke({ frame: asRevoke, ...binding, serverPublicKey: spki(server), verify })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRevoke({ frame: { ...asRevoke, approvalId: 'ch_1' }, ...binding, serverPublicKey: spki(server), verify })).toEqual({ ok: false, reason: 'bad_signature' });
    const revokeSig = signWith(server, encodeRevokeForSigning(binding));
    expect(verifyPause(verifyInput({ type: 'pause', issuedAt: binding.issuedAt, pausedAt, sig: revokeSig }))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('the ack is signed over {envId, pausedAt, killed}, bound to pause:<envId>:<pausedAt>; editing any field or signing with a rogue key denies', () => {
    const ack = { type: 'pause_result' as const, envId: 'env_1', pausedAt, killed: 2 };
    const signAck = (body = ack, key = machine): MachineResultFrame => {
      const frame = { ...body, sig: '' } as MachineResultFrame;
      return { ...body, sig: signWith(key, encodeResultForSigning({ grantId: machineResultBindingId(frame), resultHash: resultHashForFrame(frame, hash) })) } as MachineResultFrame;
    };
    expect(machineResultBindingId({ ...ack, sig: '' } as MachineResultFrame)).toBe('pause:env_1:1800000000500');
    expect(pauseBindingId('env_1', pausedAt)).toBe('pause:env_1:1800000000500');
    expect(verifyMachineResult({ frame: signAck(), machinePublicKey: spki(machine), verify, hash })).toMatchObject({ ok: true });
    const signed = signAck();
    for (const tampered of [{ ...ack, killed: 0 }, { ...ack, pausedAt: pausedAt + 1 }, { ...ack, envId: 'env_2' }]) {
      expect(verifyMachineResult({ frame: { ...tampered, sig: signed.sig } as MachineResultFrame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
    }
    expect(verifyMachineResult({ frame: signAck(ack, rogue), machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('GA wave 3 (Codex P2 #7) — the daemon epoch is under the hello signature', () => {
  it('editing daemonEpoch after signing denies bad_signature; a hello without one is not a hello', () => {
    const signed = signedHello();
    expect(verifyHello({ hello: { ...signed, daemonEpoch: 'ep2' }, expectedEnvId: signed.envId, machinePublicKey: spki(machine), verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
