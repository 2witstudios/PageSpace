import { describe, it, expect } from 'vitest';
import { decodeFrame, encodeFrame, FRAME_TYPES, type Frame } from '../frame-codec';

const LIMITS = { maxFrameBytes: 64 * 1024 };
const B64 = Buffer.from('hello').toString('base64');
const GRANT = { grantId: 'g1', envId: 'e1', principal: { userId: 'u', sessionId: 's', conversationId: 'c' }, op: 'exec', argsHash: 'h', iat: 1, exp: 2, nonce: 'n' };

/** One valid instance of every frame variant — the closed set, exhaustively. */
const SAMPLES: Record<Frame['type'], Frame> = {
  // machine → server
  hello: { type: 'hello', envId: 'e1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, policyDigest: 'abc', sig: B64 },
  exec_result: { type: 'exec_result', grantId: 'g1', exitCode: 0, stdoutB64: B64, stderrB64: '', truncated: false, sig: B64 },
  fs_read_result: { type: 'fs_read_result', grantId: 'g1', found: true, contentB64: B64, sig: B64 },
  fs_write_result: { type: 'fs_write_result', grantId: 'g1', ok: true, sig: B64 },
  grant_denied: { type: 'grant_denied', grantId: 'g1', reason: 'principal_not_allowed', sig: B64 },
  pty_opened: { type: 'pty_opened', grantId: 'g1', sessionId: 'p1' },
  pty_data: { type: 'pty_data', sessionId: 'p1', seq: 0, dataB64: B64 },
  pty_exit: { type: 'pty_exit', sessionId: 'p1', code: 0 },
  pong: { type: 'pong', ts: 1 },
  // server → machine
  grant_exec: { type: 'grant_exec', grant: GRANT, sig: B64, cmd: 'ls', args: ['-la'], cwd: '/home/u/proj', env: { LANG: 'C' }, timeoutMs: 1000, maxBytes: 1024 },
  grant_fs_read: { type: 'grant_fs_read', grant: GRANT, sig: B64, paths: ['/home/u/proj/a'] },
  grant_fs_write: { type: 'grant_fs_write', grant: GRANT, sig: B64, files: [{ path: '/home/u/proj/a', contentB64: B64, mode: 420 }] },
  grant_pty_open: { type: 'grant_pty_open', grant: GRANT, sig: B64, cols: 80, rows: 24, cwd: '/home/u/proj' },
  pty_input: { type: 'pty_input', sessionId: 'p1', seq: 1, dataB64: B64 },
  pty_resize: { type: 'pty_resize', sessionId: 'p1', cols: 100, rows: 30 },
  pty_kill: { type: 'pty_kill', sessionId: 'p1' },
  revoke: { type: 'revoke', sig: B64, issuedAt: 1, reason: 'owner_disconnect' },
  ping: { type: 'ping', ts: 1 },
};

/** Tiny seeded PRNG so the property test is reproducible without a dependency. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function randomB64(r: () => number): string {
  const n = Math.floor(r() * 12);
  return Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256))).toString('base64');
}
function randomStr(r: () => number): string {
  const n = 1 + Math.floor(r() * 10);
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(r() * 26))).join('');
}
function randomInt(r: () => number, max = 100_000): number {
  return Math.floor(r() * max);
}
/** Generate a random valid instance of a given variant. */
function generate(type: Frame['type'], r: () => number): Frame {
  const g = { ...GRANT, grantId: randomStr(r), nonce: randomStr(r), iat: randomInt(r), exp: randomInt(r) };
  switch (type) {
    case 'hello': return { type, envId: randomStr(r), capabilities: { shell: r() > 0.5, pty: r() > 0.5, fs: r() > 0.5, checkpoint: false }, policyDigest: randomStr(r), sig: randomB64(r) || B64 };
    case 'exec_result': return { type, grantId: randomStr(r), exitCode: randomInt(r, 256), stdoutB64: randomB64(r), stderrB64: randomB64(r), truncated: r() > 0.5, sig: B64 };
    case 'fs_read_result': return r() > 0.5 ? { type, grantId: randomStr(r), found: true, contentB64: randomB64(r), sig: B64 } : { type, grantId: randomStr(r), found: false, sig: B64 };
    case 'fs_write_result': return r() > 0.5 ? { type, grantId: randomStr(r), ok: true, sig: B64 } : { type, grantId: randomStr(r), ok: false, error: randomStr(r), sig: B64 };
    case 'grant_denied': return { type, grantId: randomStr(r), reason: randomStr(r), sig: B64 };
    case 'pty_opened': return { type, grantId: randomStr(r), sessionId: randomStr(r) };
    case 'pty_data': return { type, sessionId: randomStr(r), seq: randomInt(r), dataB64: randomB64(r) };
    case 'pty_exit': return { type, sessionId: randomStr(r), code: randomInt(r, 256) };
    case 'pong': return { type, ts: randomInt(r) };
    case 'grant_exec': return { type, grant: g, sig: B64, cmd: randomStr(r), args: Array.from({ length: randomInt(r, 4) }, () => randomStr(r)), cwd: `/${randomStr(r)}`, env: { [randomStr(r).toUpperCase()]: randomStr(r) }, timeoutMs: randomInt(r), maxBytes: randomInt(r) };
    case 'grant_fs_read': return { type, grant: g, sig: B64, paths: [`/${randomStr(r)}`] };
    case 'grant_fs_write': return { type, grant: g, sig: B64, files: [{ path: `/${randomStr(r)}`, contentB64: randomB64(r), mode: 420 }] };
    case 'grant_pty_open': return { type, grant: g, sig: B64, cols: 1 + randomInt(r, 300), rows: 1 + randomInt(r, 100), cwd: `/${randomStr(r)}` };
    case 'pty_input': return { type, sessionId: randomStr(r), seq: randomInt(r), dataB64: randomB64(r) };
    case 'pty_resize': return { type, sessionId: randomStr(r), cols: 1 + randomInt(r, 300), rows: 1 + randomInt(r, 100) };
    case 'pty_kill': return { type, sessionId: randomStr(r) };
    case 'revoke': return { type, sig: B64, issuedAt: randomInt(r), reason: randomStr(r) };
    case 'ping': return { type, ts: randomInt(r) };
  }
}

describe('frame-codec — the wire protocol as pure data (invariant 6: unknown or malformed frames are dropped, never guessed)', () => {
  it('FRAME_TYPES is the closed set and SAMPLES covers every member', () => {
    expect([...FRAME_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(Object.keys(SAMPLES) as Frame['type'][])('given a valid %s frame, encodeFrame → decodeFrame should round-trip deep-equal', (type) => {
    const frame = SAMPLES[type];
    expect(decodeFrame(encodeFrame(frame), LIMITS)).toEqual({ ok: true, frame });
  });

  it('property: ≥200 random valid frames across every variant round-trip deep-equal, and random junk never throws', () => {
    const r = rng(0xc0ffee);
    const types = [...FRAME_TYPES];
    let cases = 0;
    for (let i = 0; i < 240; i += 1) {
      const type = types[i % types.length] as Frame['type'];
      const frame = generate(type, r);
      expect(decodeFrame(encodeFrame(frame), LIMITS), `round-trip ${type} #${i}`).toEqual({ ok: true, frame });
      cases += 1;
    }
    expect(cases).toBeGreaterThanOrEqual(200);
    for (let i = 0; i < 200; i += 1) {
      const junk = Array.from({ length: randomInt(r, 40) }, () => String.fromCharCode(randomInt(r, 127))).join('');
      expect(() => decodeFrame(junk, LIMITS)).not.toThrow();
    }
  });

  it('given a type outside the closed set, should reject unknown_type (never throw)', () => {
    expect(decodeFrame(JSON.stringify({ type: 'exec_now', cmd: 'rm' }), LIMITS)).toEqual({ ok: false, reason: 'unknown_type' });
    expect(decodeFrame(JSON.stringify({ type: 'tool_execute', id: '1' }), LIMITS)).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it.each<[string, string]>([
    ['non-JSON', '{not json'],
    ['a JSON string', JSON.stringify('grant_exec')],
    ['a JSON number', '42'],
    ['null', 'null'],
    ['an array', JSON.stringify([{ type: 'ping', ts: 1 }])],
    ['an object without type', JSON.stringify({ ts: 1 })],
    ['a non-string type', JSON.stringify({ type: 7 })],
    ['a ping with a missing field', JSON.stringify({ type: 'ping' })],
    ['a grant_exec whose grant is not an object', JSON.stringify({ ...SAMPLES.grant_exec, grant: 'g1' })],
    ['a pty_data with a negative seq', JSON.stringify({ ...SAMPLES.pty_data, seq: -1 })],
    ['a pty_data with a non-integer seq', JSON.stringify({ ...SAMPLES.pty_data, seq: 1.5 })],
    ['a grant_fs_write with a non-array files', JSON.stringify({ ...SAMPLES.grant_fs_write, files: 'x' })],
    ['a pty_resize with zero cols', JSON.stringify({ ...SAMPLES.pty_resize, cols: 0 })],
  ])('given %s, should reject malformed (never throw)', (_label, raw) => {
    expect(() => decodeFrame(raw, LIMITS)).not.toThrow();
    expect(decodeFrame(raw, LIMITS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given a frame larger than maxFrameBytes, should reject oversized BEFORE parsing (a 1-byte limit rejects even a valid ping)', () => {
    const big = JSON.stringify({ type: 'pty_data', sessionId: 'p1', seq: 0, dataB64: 'A'.repeat(200_000) });
    expect(decodeFrame(big, LIMITS)).toEqual({ ok: false, reason: 'oversized' });
    let parsed = false;
    const originalParse = JSON.parse;
    JSON.parse = ((s: string) => { parsed = true; return originalParse(s); }) as typeof JSON.parse;
    try {
      decodeFrame(encodeFrame(SAMPLES.ping), { maxFrameBytes: 1 });
    } finally {
      JSON.parse = originalParse;
    }
    expect(parsed).toBe(false);
  });

  it('should measure size in BYTES, not UTF-16 code units', () => {
    const emoji = JSON.stringify({ type: 'grant_denied', grantId: 'g1', reason: '😀😀😀😀', sig: B64 }); // 4 emoji = 16 bytes, 8 code units
    expect(decodeFrame(emoji, { maxFrameBytes: emoji.length })).toEqual({ ok: false, reason: 'oversized' });
  });

  it.each<[string, unknown]>([
    ['hello.sig', { ...SAMPLES.hello, sig: '!!!' }],
    ['exec_result.stdoutB64', { ...SAMPLES.exec_result, stdoutB64: 'not base64' }],
    ['pty_data.dataB64', { ...SAMPLES.pty_data, dataB64: 'A' }],
    ['grant_fs_write.files[0].contentB64', { ...SAMPLES.grant_fs_write, files: [{ path: '/x', contentB64: '###', mode: 420 }] }],
    ['grant_exec.sig', { ...SAMPLES.grant_exec, sig: 'abc' }],
  ])('given invalid base64 in %s, should reject bad_base64', (_label, frame) => {
    expect(decodeFrame(JSON.stringify(frame), LIMITS)).toEqual({ ok: false, reason: 'bad_base64' });
  });

  it('given a frame that is both structurally malformed AND has bad base64, should report malformed (structure first)', () => {
    expect(decodeFrame(JSON.stringify({ type: 'pty_data', seq: 'x', dataB64: '###' }), LIMITS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given a frame carrying extra privileged-looking fields, should decode with those fields STRIPPED (a grant is still required downstream)', () => {
    const raw = JSON.stringify({ ...SAMPLES.grant_exec, isAdmin: true, skipPolicy: true, bypass: 'yes' });
    const verdict = decodeFrame(raw, LIMITS);
    expect(verdict).toEqual({ ok: true, frame: SAMPLES.grant_exec });
    if (verdict.ok) {
      expect('isAdmin' in verdict.frame).toBe(false);
      expect('skipPolicy' in verdict.frame).toBe(false);
    }
  });

  it('should keep the embedded grant OPAQUE (verifyGrant does the strict parse): extra keys inside grant survive decoding so the strict layer can refuse them', () => {
    const raw = JSON.stringify({ ...SAMPLES.grant_exec, grant: { ...GRANT, isAdmin: true } });
    const verdict = decodeFrame(raw, LIMITS);
    expect(verdict.ok).toBe(true);
    if (verdict.ok && verdict.frame.type === 'grant_exec') expect((verdict.frame.grant as Record<string, unknown>).isAdmin).toBe(true);
  });

  it('encodeFrame should produce a single-line JSON string with no embedded newlines', () => {
    for (const frame of Object.values(SAMPLES)) expect(encodeFrame(frame)).not.toMatch(/\n/);
  });

  it('given an already-parsed object (not a wire string), should decode it the same way', () => {
    expect(decodeFrame(SAMPLES.ping, LIMITS)).toEqual({ ok: true, frame: SAMPLES.ping });
    expect(decodeFrame({ type: 'nope' }, LIMITS)).toEqual({ ok: false, reason: 'unknown_type' });
  });
});
