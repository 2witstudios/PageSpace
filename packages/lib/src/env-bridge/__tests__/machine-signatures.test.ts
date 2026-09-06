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
  verifyHello,
  verifyMachineResult,
  verifyRevoke,
  isMachineResultFrame,
  MACHINE_RESULT_FRAME_TYPES,
  type MachineResultFrame,
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
const helloBody = { envId: 'env-1', capabilities, policyDigest: 'sha256:abc' };
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
    const a = encodeHelloForSigning({ envId: 'e', capabilities: { shell: true, pty: true, fs: false, checkpoint: false }, policyDigest: 'd' });
    const b = encodeHelloForSigning({ policyDigest: 'd', capabilities: { checkpoint: false, fs: false, pty: true, shell: true }, envId: 'e' } as typeof helloBody);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

type UnsignedResult = { [K in MachineResultFrame['type']]: Omit<Extract<MachineResultFrame, { type: K }>, 'sig'> };
const results: UnsignedResult = {
  exec_result: { type: 'exec_result', grantId: 'g1', exitCode: 0, stdoutB64: 'b3V0', stderrB64: '', truncated: false },
  fs_read_result: { type: 'fs_read_result', grantId: 'g2', found: true, contentB64: 'ZGF0YQ==' },
  fs_write_result: { type: 'fs_write_result', grantId: 'g3', ok: true },
  grant_denied: { type: 'grant_denied', grantId: 'g4', reason: 'policy_denied' },
};

function signResult(body: Omit<MachineResultFrame, 'sig'>, key = machine): MachineResultFrame {
  const frame = { ...body, sig: '' } as MachineResultFrame;
  const resultHash = resultHashForFrame(frame, hash);
  return { ...body, sig: signWith(key, encodeResultForSigning({ grantId: body.grantId, resultHash })) } as MachineResultFrame;
}

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
  ] as Array<[string, UnsignedResult[keyof UnsignedResult]]>)('given %s changed after signing, should deny bad_signature — every payload field is covered', (_label, tampered) => {
    const original = results[tampered.type];
    const signed = signResult(original);
    const frame = { ...tampered, sig: signed.sig } as MachineResultFrame;
    expect(verifyMachineResult({ frame, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the grantId swapped onto another grant after signing, should deny bad_signature (a result cannot be replayed under another grant)', () => {
    const signed = signResult(results.exec_result);
    expect(verifyMachineResult({ frame: { ...signed, grantId: 'g-other' }, machinePublicKey: spki(machine), verify, hash })).toEqual({ ok: false, reason: 'bad_signature' });
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
    expect([...MACHINE_RESULT_FRAME_TYPES].sort()).toEqual(['exec_result', 'fs_read_result', 'fs_write_result', 'grant_denied']);
    expect(isMachineResultFrame({ type: 'pty_data', sessionId: 's', seq: 0, dataB64: '' })).toBe(false);
    expect(isMachineResultFrame({ type: 'pty_exit', sessionId: 's', code: 0 })).toBe(false);
    expect(isMachineResultFrame({ type: 'pong', ts: 1 })).toBe(false);
    expect(isMachineResultFrame({ type: 'exec_result', grantId: 'g', exitCode: 0, stdoutB64: '', stderrB64: '', truncated: false, sig: '' })).toBe(true);
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
    expect(isMachineToServerFrame({ type: 'hello', envId: 'e', capabilities, policyDigest: '', sig: '' })).toBe(true);
    expect(isMachineToServerFrame({ type: 'pong', ts: 1 })).toBe(true);
    expect(isMachineToServerFrame({ type: 'revoke', sig: '', issuedAt: 1 })).toBe(false);
    expect(isMachineToServerFrame({ type: 'grant_exec', grant: {}, sig: '', cmd: 'ls' })).toBe(false);
    expect(isMachineToServerFrame({ type: 'ping', ts: 1 })).toBe(false);
  });
});
