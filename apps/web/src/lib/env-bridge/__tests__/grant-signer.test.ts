/**
 * The signer and the daemon's gate must agree by construction (Codex C7):
 * every grant signed here is verified with the PURE `verifyGrant` under the
 * request `grantRequestForFrame(frame)` — the same projection both call.
 * Tampering any projected field after signing ⇒ `args_mismatch`. The key is
 * the one the enrollment pinned (Codex C10); an unloaded key id signs nothing.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';
import { verifyGrant, createMemoryNonceStore, canonicalizeArgs, GRANT_MAX_TTL_MS } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import type { UnsignedGrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { signGrantFrame } from '../grant-signer';
import { ed25519Verify, envBridgeHash } from '../crypto';

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
    return { publicKey: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)) };
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};
const pkcs8 = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const ringVerdict = parseServerSigningKeyring({ single: undefined, multi: `${pkcs8()},${pkcs8()}` }, primitives);
if (!ringVerdict.ok) throw new Error('ring');
const ring = ringVerdict.keyring;
const [currentId, previousId] = ring.keyIds as [string, string];

const NOW = 1_760_000_000_000;
const principal = { userId: 'user-1', sessionId: 'sess-1', conversationId: 'conv-1' };
let counter = 0;
const ids = { grantId: () => `g-${++counter}`, nonce: () => `n-${counter}` };

const frames: Record<GrantFrame['type'], UnsignedGrantFrame> = {
  grant_exec: { type: 'grant_exec', cmd: 'bun', args: ['test'], cwd: '/repo', env: { CI: '1' }, timeoutMs: 120_000, maxBytes: 1_000_000 },
  grant_fs_read: { type: 'grant_fs_read', paths: ['/repo/a.ts', '/repo/b.ts'] },
  grant_fs_write: { type: 'grant_fs_write', files: [{ path: '/repo/a.ts', contentB64: 'aGVsbG8=', mode: 420 }] },
  grant_pty_open: { type: 'grant_pty_open', cols: 80, rows: 24, cwd: '/repo', command: 'zsh', args: ['-l'] },
};

function sign(frame: UnsignedGrantFrame, serverKeyId: string | null = currentId, over: Partial<Parameters<typeof signGrantFrame>[0]> = {}) {
  return signGrantFrame({ frame, envId: 'env-1', principal, serverKeyId, keyring: ring, now: NOW, ids, ...over });
}

/** The daemon's gate, exactly as t08 will call it: the request comes from the frame as received. */
function gate(frame: GrantFrame, publicKey: Uint8Array = ring.get(currentId)!.publicKey, expectedEnvId = 'env-1') {
  return verifyGrant({
    grant: frame.grant,
    signature: frame.sig,
    serverPublicKey: publicKey,
    now: NOW + 1_000,
    nonces: createMemoryNonceStore(),
    expectedEnvId,
    request: grantRequestForFrame(frame),
    verify: ed25519Verify,
    hash: envBridgeHash,
  });
}

describe('signGrantFrame ↔ verifyGrant — agreement by construction (C7)', () => {
  it.each(Object.keys(frames) as GrantFrame['type'][])('given a %s, the signed frame should verify under the daemon gate with the projection of the frame itself', (type) => {
    const signed = sign(frames[type]);
    if (!signed.ok) throw new Error(signed.reason);
    const verdict = gate(signed.frame);
    expect(verdict.ok).toBe(true);
    expect(signed.grant.op).toBe(grantRequestForFrame(signed.frame).op);
    // C7: the hash is of the PROJECTION of the sent frame, nothing else.
    expect(signed.grant.argsHash).toBe(envBridgeHash(canonicalizeArgs(grantRequestForFrame(signed.frame).args)));
    expect(signed.keyId).toBe(currentId);
    expect(signed.grant).toMatchObject({ envId: 'env-1', principal, iat: NOW, exp: NOW + GRANT_MAX_TTL_MS });
  });

  const tampers: Array<[string, (f: GrantFrame) => GrantFrame]> = [
    ['exec.cmd', (f) => ({ ...(f as Extract<GrantFrame, { type: 'grant_exec' }>), cmd: 'rm' })],
    ['exec.args', (f) => ({ ...(f as Extract<GrantFrame, { type: 'grant_exec' }>), args: ['test', '--evil'] })],
    ['exec.cwd', (f) => ({ ...(f as Extract<GrantFrame, { type: 'grant_exec' }>), cwd: '/' })],
    ['exec.env (LD_PRELOAD added)', (f) => ({ ...(f as Extract<GrantFrame, { type: 'grant_exec' }>), env: { CI: '1', LD_PRELOAD: '/x.so' } })],
    ['exec.timeoutMs', (f) => ({ ...(f as Extract<GrantFrame, { type: 'grant_exec' }>), timeoutMs: 1 })],
    ['exec.maxBytes', (f) => ({ ...(f as Extract<GrantFrame, { type: 'grant_exec' }>), maxBytes: 1 })],
    ['exec.cwd removed', (f) => {
      const { cwd: _cwd, ...rest } = f as Extract<GrantFrame, { type: 'grant_exec' }>;
      return rest as GrantFrame;
    }],
  ];
  it.each(tampers)('given %s changed after signing, the gate should deny args_mismatch', (_label, tamper) => {
    const signed = sign(frames.grant_exec);
    if (!signed.ok) throw new Error(signed.reason);
    expect(gate(tamper(signed.frame))).toEqual({ ok: false, reason: 'args_mismatch' });
  });

  it('given fs_read paths, fs_write content/mode/path, or pty cols/command changed after signing, the gate should deny args_mismatch', () => {
    const read = sign(frames.grant_fs_read);
    const write = sign(frames.grant_fs_write);
    const pty = sign(frames.grant_pty_open);
    if (!read.ok || !write.ok || !pty.ok) throw new Error('sign');
    const r = read.frame as Extract<GrantFrame, { type: 'grant_fs_read' }>;
    const w = write.frame as Extract<GrantFrame, { type: 'grant_fs_write' }>;
    const p = pty.frame as Extract<GrantFrame, { type: 'grant_pty_open' }>;
    expect(gate({ ...r, paths: ['/etc/passwd'] })).toEqual({ ok: false, reason: 'args_mismatch' });
    expect(gate({ ...w, files: [{ ...w.files[0]!, contentB64: 'ZXZpbA==' }] })).toEqual({ ok: false, reason: 'args_mismatch' });
    expect(gate({ ...w, files: [{ ...w.files[0]!, mode: 493 }] })).toEqual({ ok: false, reason: 'args_mismatch' });
    expect(gate({ ...w, files: [{ ...w.files[0]!, path: '/etc/cron.d/x' }] })).toEqual({ ok: false, reason: 'args_mismatch' });
    expect(gate({ ...p, cols: 81 })).toEqual({ ok: false, reason: 'args_mismatch' });
    expect(gate({ ...p, command: 'bash' })).toEqual({ ok: false, reason: 'args_mismatch' });
  });

  it('given an exec grant moved onto an fs_read frame, the gate should deny op_mismatch', () => {
    const exec = sign(frames.grant_exec);
    if (!exec.ok) throw new Error(exec.reason);
    const moved: GrantFrame = { type: 'grant_fs_read', grant: exec.frame.grant, sig: exec.frame.sig, paths: ['/x'] };
    expect(gate(moved)).toEqual({ ok: false, reason: 'op_mismatch' });
  });

  it('given a grant for env-1 presented to env-2\'s daemon, the gate should deny wrong_env', () => {
    const signed = sign(frames.grant_exec);
    if (!signed.ok) throw new Error(signed.reason);
    expect(gate(signed.frame, ring.get(currentId)!.publicKey, 'env-2')).toEqual({ ok: false, reason: 'wrong_env' });
  });
});

describe('signGrantFrame — which key signs (C10)', () => {
  it('given an enrollment pinned to the PREVIOUS key, should sign with that key: verifies under its public key, not the current one', () => {
    const signed = sign(frames.grant_exec, previousId);
    if (!signed.ok) throw new Error(signed.reason);
    expect(signed.keyId).toBe(previousId);
    expect(gate(signed.frame, ring.get(previousId)!.publicKey).ok).toBe(true);
    expect(gate(signed.frame, ring.get(currentId)!.publicKey)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given an enrollment pinned to a key that is no longer loaded, should answer signing_key_unavailable and produce NO frame', () => {
    expect(sign(frames.grant_exec, 'gone-key')).toEqual({ ok: false, reason: 'signing_key_unavailable' });
  });

  it('given an enrollment with no pinned key (never enrolled), should answer signing_key_unavailable', () => {
    expect(sign(frames.grant_exec, null)).toEqual({ ok: false, reason: 'signing_key_unavailable' });
  });
});

describe('signGrantFrame — window and identity', () => {
  it('should default the window to GRANT_MAX_TTL_MS and refuse a longer one before signing', () => {
    const ok = sign(frames.grant_fs_read);
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.grant.exp - ok.grant.iat).toBe(GRANT_MAX_TTL_MS);
    expect(sign(frames.grant_fs_read, currentId, { ttlMs: GRANT_MAX_TTL_MS + 1 })).toEqual({ ok: false, reason: 'ttl_too_long' });
    expect(sign(frames.grant_fs_read, currentId, { ttlMs: 0 })).toEqual({ ok: false, reason: 'ttl_too_long' });
  });

  it('should mint a fresh grantId and nonce per call and carry the wire grant as a plain record with exactly the gate\'s fields', () => {
    const a = sign(frames.grant_fs_read);
    const b = sign(frames.grant_fs_read);
    if (!a.ok || !b.ok) throw new Error('sign');
    expect(a.grant.grantId).not.toBe(b.grant.grantId);
    expect(a.grant.nonce).not.toBe(b.grant.nonce);
    expect(Object.keys(a.frame.grant).sort()).toEqual(['argsHash', 'envId', 'exp', 'grantId', 'iat', 'nonce', 'op', 'principal']);
  });
});
