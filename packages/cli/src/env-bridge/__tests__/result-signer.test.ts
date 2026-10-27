import { describe, expect, it } from 'vitest';
import { verifyHello, verifyMachineResult, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { decodeBase64 } from '@pagespace/lib/env-bridge/grant';
import { signHello, signResultFrame, type UnsignedMachineResultFrame } from '../result-signer.js';
import { generateMachineKeypair, signWithMachineKey } from '../keypair.js';
import { ed25519Verify, envBridgeHash } from '../crypto.js';

const pair = generateMachineKeypair();
const machinePublicKey = decodeBase64(pair.publicKey)!;
const deps = { privateKey: pair.privateKey, sign: signWithMachineKey, hash: envBridgeHash };
const verifierDeps = { machinePublicKey, verify: ed25519Verify, hash: envBridgeHash };

describe('result-signer (invariant 7) — round-trips through the REAL lib verifier the server uses', () => {
  it.each<UnsignedMachineResultFrame>([
    { type: 'exec_result', grantId: 'g1', exitCode: 0, stdoutB64: 'aGk=', stderrB64: '', truncated: false },
    { type: 'fs_read_result', grantId: 'g2', found: true, contentB64: 'aGk=' },
    { type: 'fs_read_result', grantId: 'g3', found: false },
    { type: 'fs_write_result', grantId: 'g4', ok: false, error: 'EACCES' },
    { type: 'grant_denied', grantId: 'g5', reason: 'no_policy' },
  ])('given an unsigned $type, should produce a frame verifyMachineResult accepts', (unsigned) => {
    const frame = signResultFrame(unsigned, deps);
    expect(frame.sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verifyMachineResult({ frame, ...verifierDeps })).toMatchObject({ ok: true });
  });

  it('given any payload field edited after signing, should fail verification (the signature covers every field via resultHash)', () => {
    const frame = signResultFrame({ type: 'exec_result', grantId: 'g1', exitCode: 0, stdoutB64: 'aGk=', stderrB64: '', truncated: false }, deps) as Extract<MachineResultFrame, { type: 'exec_result' }>;
    const tampered: MachineResultFrame = { ...frame, exitCode: 1 };
    expect(verifyMachineResult({ frame: tampered, ...verifierDeps })).toEqual({ ok: false, reason: 'bad_signature' });
    const moved: MachineResultFrame = { ...frame, grantId: 'g9' };
    expect(verifyMachineResult({ frame: moved, ...verifierDeps })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given a result signed by a different machine key, should fail verification under the pinned key', () => {
    const other = generateMachineKeypair();
    const frame = signResultFrame({ type: 'grant_denied', grantId: 'g1', reason: 'x' }, { ...deps, privateKey: other.privateKey });
    expect(verifyMachineResult({ frame, ...verifierDeps })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('signHello (invariant 2) — round-trips through the REAL lib verifyHello the socket route uses', () => {
  const unsigned = { type: 'hello' as const, envId: 'env_1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, policyDigest: 'abc', daemonEpoch: 'ep1' };

  it('given an unsigned hello, should produce one verifyHello accepts for that env', () => {
    const hello = signHello(unsigned, deps);
    expect(verifyHello({ hello, expectedEnvId: 'env_1', machinePublicKey, verify: ed25519Verify })).toEqual({ ok: true });
  });

  it('given the capabilities or digest edited after signing, should fail verification', () => {
    const hello = signHello(unsigned, deps);
    expect(verifyHello({ hello: { ...hello, capabilities: { ...hello.capabilities, pty: true } }, expectedEnvId: 'env_1', machinePublicKey, verify: ed25519Verify })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyHello({ hello: { ...hello, policyDigest: '' }, expectedEnvId: 'env_1', machinePublicKey, verify: ed25519Verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
