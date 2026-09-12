import { describe, it, expect } from 'vitest';
import { decodeFrame, encodeFrame, FRAME_TYPES, isMachineToServerFrame, FS_READ_ENVELOPE_OVERHEAD_BYTES, fsReadContentCeiling, execOutputCeiling, MAX_FS_WRITE_FILES, type Frame } from '../frame-codec';

const LIMITS = { maxFrameBytes: 64 * 1024 };
const B64 = Buffer.from('hello').toString('base64');
const GRANT = { grantId: 'g1', envId: 'e1', principal: { userId: 'u', sessionId: 's', conversationId: 'c' }, op: 'exec', argsHash: 'h', iat: 1, exp: 2, nonce: 'n' };

/** One valid instance of every frame variant — the closed set, exhaustively. */
const SAMPLES: Record<Frame['type'], Frame> = {
  // machine → server
  hello: { type: 'hello', envId: 'e1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, policyDigest: 'abc', daemonEpoch: 'ep1', sig: B64 },
  exec_result: { type: 'exec_result', grantId: 'g1', exitCode: 0, stdoutB64: B64, stderrB64: '', truncated: false, sig: B64 },
  fs_read_result: { type: 'fs_read_result', grantId: 'g1', found: true, contentB64: B64, sig: B64 },
  fs_write_result: { type: 'fs_write_result', grantId: 'g1', ok: true, sig: B64 },
  grant_denied: { type: 'grant_denied', grantId: 'g1', reason: 'principal_not_allowed', sig: B64 },
  approval_revoke_result: { type: 'approval_revoke_result', approvalId: 'ch_1', removed: 2, sig: B64 },
  pause_result: { type: 'pause_result', envId: 'e1', pausedAt: 5, killed: 1, sig: B64 },
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
  pause: { type: 'pause', sig: B64, issuedAt: 1, pausedAt: 5 },
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
    case 'hello': return { type, envId: randomStr(r), capabilities: { shell: r() > 0.5, pty: r() > 0.5, fs: r() > 0.5, checkpoint: false }, policyDigest: randomStr(r), daemonEpoch: randomStr(r), sig: randomB64(r) || B64 };
    case 'exec_result': return { type, grantId: randomStr(r), exitCode: randomInt(r, 256), stdoutB64: randomB64(r), stderrB64: randomB64(r), truncated: r() > 0.5, sig: B64 };
    case 'fs_read_result': return r() > 0.5 ? { type, grantId: randomStr(r), found: true, contentB64: randomB64(r), sig: B64 } : { type, grantId: randomStr(r), found: false, sig: B64 };
    case 'fs_write_result': return r() > 0.5 ? { type, grantId: randomStr(r), ok: true, sig: B64 } : { type, grantId: randomStr(r), ok: false, error: randomStr(r), sig: B64 };
    case 'grant_denied': return { type, grantId: randomStr(r), reason: randomStr(r), sig: B64 };
    case 'approval_revoke_result': return { type, approvalId: randomStr(r), removed: randomInt(r, 8), sig: B64 };
    case 'pause_result': return { type, envId: randomStr(r), pausedAt: randomInt(r), killed: randomInt(r, 8), sig: B64 };
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
    case 'pause': return { type, sig: B64, issuedAt: randomInt(r), pausedAt: randomInt(r) };
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

  it('given an already-parsed object that would exceed maxFrameBytes on the wire, should reject oversized (the limit must not be bypassable by pre-parsing) — Codex P2', () => {
    const big = { type: 'pty_data', sessionId: 'p1', seq: 0, dataB64: 'A'.repeat(200_000) };
    expect(decodeFrame(big, LIMITS)).toEqual({ ok: false, reason: 'oversized' });
  });

  it('given an already-parsed object that cannot be serialized (circular), should reject malformed and never throw', () => {
    const circular: Record<string, unknown> = { type: 'ping', ts: 1 };
    circular.self = circular;
    expect(() => decodeFrame(circular, LIMITS)).not.toThrow();
    expect(decodeFrame(circular, LIMITS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given an already-parsed object (not a wire string), should decode it the same way', () => {
    expect(decodeFrame(SAMPLES.ping, LIMITS)).toEqual({ ok: true, frame: SAMPLES.ping });
    expect(decodeFrame({ type: 'nope' }, LIMITS)).toEqual({ ok: false, reason: 'unknown_type' });
  });
});

describe('fsReadContentCeiling — the largest RAW file an fs_read_result can carry inside maxFrameBytes', () => {
  it('a result at exactly the ceiling, with a long grantId and a real-size signature, still fits the frame limit; one byte more would not', () => {
    const limits = { maxFrameBytes: 64 * 1024 };
    const ceiling = fsReadContentCeiling(limits);
    expect(ceiling).toBeGreaterThan(0);
    expect(FS_READ_ENVELOPE_OVERHEAD_BYTES).toBeGreaterThanOrEqual(256);
    const frame = (raw: number): Frame => ({ type: 'fs_read_result', grantId: `grant_${'x'.repeat(64)}`, found: true, contentB64: Buffer.alloc(raw, 1).toString('base64'), sig: Buffer.alloc(64, 2).toString('base64') });
    expect(decodeFrame(encodeFrame(frame(ceiling)), limits)).toMatchObject({ ok: true });
    expect(Buffer.byteLength(encodeFrame(frame(ceiling)))).toBeLessThanOrEqual(limits.maxFrameBytes);
    expect(Buffer.byteLength(encodeFrame(frame(ceiling + FS_READ_ENVELOPE_OVERHEAD_BYTES)))).toBeGreaterThan(limits.maxFrameBytes);
  });

  it('scales with the limit and never goes negative', () => {
    expect(fsReadContentCeiling({ maxFrameBytes: 1024 * 1024 })).toBeGreaterThan(fsReadContentCeiling({ maxFrameBytes: 64 * 1024 }));
    expect(fsReadContentCeiling({ maxFrameBytes: 10 })).toBe(0);
  });
});

describe('execOutputCeiling — the largest raw stdout+stderr an exec_result can carry inside maxFrameBytes', () => {
  it('a result whose two streams total exactly the ceiling still decodes under the limit; one envelope more does not', () => {
    const limits = { maxFrameBytes: 64 * 1024 };
    const ceiling = execOutputCeiling(limits);
    expect(ceiling).toBeGreaterThan(0);
    const frame = (rawTotal: number): Frame => ({ type: 'exec_result', grantId: `grant_${'x'.repeat(64)}`, exitCode: 0, stdoutB64: Buffer.alloc(Math.ceil(rawTotal / 2), 1).toString('base64'), stderrB64: Buffer.alloc(Math.floor(rawTotal / 2), 2).toString('base64'), truncated: true, sig: Buffer.alloc(64, 3).toString('base64') });
    expect(decodeFrame(encodeFrame(frame(ceiling)), limits)).toMatchObject({ ok: true });
    expect(Buffer.byteLength(encodeFrame(frame(ceiling + FS_READ_ENVELOPE_OVERHEAD_BYTES)))).toBeGreaterThan(limits.maxFrameBytes);
    expect(execOutputCeiling({ maxFrameBytes: 10 })).toBe(0);
  });
});

describe('GA wave 2 — grant_denied may carry a PENDING frozen request', () => {
  const pending = { challengeId: 'ch_1', expiresAt: 5, request: { op: 'exec', cmd: 'git', args: ['status'], cwd: '/p', paths: [], env: { CI: '1' }, timeoutMs: 1000, maxBytes: 1024, clamped: false } };
  const limits = { maxFrameBytes: 65536 };

  it('should decode a grant_denied with a well-formed pending request, and one without', () => {
    expect(decodeFrame({ type: 'grant_denied', grantId: 'g1', reason: 'ask_pending:ch_1', pending, sig: B64 }, limits)).toMatchObject({ ok: true, frame: { pending } });
    expect(decodeFrame({ type: 'grant_denied', grantId: 'g1', reason: 'x', sig: B64 }, limits)).toMatchObject({ ok: true });
  });

  it.each([
    ['an extra field inside pending', { ...pending, isAdmin: true }],
    ['an extra field inside the request', { ...pending, request: { ...pending.request, shell: true } }],
    ['a missing cwd', { ...pending, request: { ...pending.request, cwd: undefined } }],
    ['a non-positive timeout', { ...pending, request: { ...pending.request, timeoutMs: 0 } }],
    ['an op outside the union', { ...pending, request: { ...pending.request, op: 'root' } }],
    ['an empty challengeId', { ...pending, challengeId: '' }],
  ])('given %s, should reject the whole frame as malformed', (_label, bad) => {
    expect(decodeFrame({ type: 'grant_denied', grantId: 'g1', reason: 'ask_pending:ch_1', pending: bad, sig: B64 }, limits)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('GA wave 2 — approval_revoke_result is a machine→server frame', () => {
  it('decodes with approvalId + removed + sig, and rejects a missing count or an extra field', () => {
    const limits = { maxFrameBytes: 65536 };
    expect(decodeFrame({ type: 'approval_revoke_result', approvalId: 'ch_1', removed: 2, sig: B64 }, limits)).toMatchObject({ ok: true, frame: { type: 'approval_revoke_result', approvalId: 'ch_1', removed: 2 } });
    expect(decodeFrame({ type: 'approval_revoke_result', approvalId: 'ch_1', sig: B64 }, limits)).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeFrame({ type: 'approval_revoke_result', approvalId: '', removed: 1, sig: B64 }, limits)).toEqual({ ok: false, reason: 'malformed' });
    expect(isMachineToServerFrame({ type: 'approval_revoke_result', approvalId: 'ch_1', removed: 0, sig: '' })).toBe(true);
  });
});

describe('GA wave 3 — STOP on the wire: `pause` (server→machine) and `pause_result` (machine→server)', () => {
  const limits = { maxFrameBytes: 65536 };
  it('pause decodes with sig + issuedAt + pausedAt and nothing else; it carries NO approval id and no grant', () => {
    expect(decodeFrame({ type: 'pause', sig: B64, issuedAt: 1, pausedAt: 5 }, limits)).toMatchObject({ ok: true, frame: { type: 'pause', issuedAt: 1, pausedAt: 5 } });
    expect(decodeFrame({ type: 'pause', sig: B64, issuedAt: 1 }, limits)).toEqual({ ok: false, reason: 'malformed' });
    const decoded = decodeFrame({ type: 'pause', sig: B64, issuedAt: 1, pausedAt: 5, approvalId: 'ch_1', grant: {} }, limits);
    expect(decoded.ok && !('approvalId' in decoded.frame) && !('grant' in decoded.frame)).toBe(true);
    expect(isMachineToServerFrame({ type: 'pause', sig: '', issuedAt: 1, pausedAt: 5 })).toBe(false);
  });
  it('pause_result decodes with envId + pausedAt + killed + sig; a missing count or env is malformed', () => {
    expect(decodeFrame({ type: 'pause_result', envId: 'e1', pausedAt: 5, killed: 2, sig: B64 }, limits)).toMatchObject({ ok: true, frame: { type: 'pause_result', envId: 'e1', pausedAt: 5, killed: 2 } });
    expect(decodeFrame({ type: 'pause_result', envId: 'e1', pausedAt: 5, sig: B64 }, limits)).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeFrame({ type: 'pause_result', pausedAt: 5, killed: 0, sig: B64 }, limits)).toEqual({ ok: false, reason: 'malformed' });
    expect(isMachineToServerFrame({ type: 'pause_result', envId: 'e1', pausedAt: 5, killed: 0, sig: '' })).toBe(true);
  });
});

describe('grant_fs_write: what no owner should have to adjudicate is refused at the envelope (hardening A4)', () => {
  const LARGE = { maxFrameBytes: 4 * 1024 * 1024 };
  const write = (files: Array<Record<string, unknown>>) => decodeFrame(JSON.stringify({ type: 'grant_fs_write', grant: GRANT, sig: B64, files }), LARGE);
  const file = (mode?: number) => ({ path: '/home/u/proj/a', contentB64: B64, ...(mode !== undefined && { mode }) });

  it.each([0o644, 0o600, 0o755, 0o777, 0])('given the legal mode %s, should decode unchanged — 0o755 is legal HERE and is escalated later by the classifier, not refused by the codec', (mode) => {
    const decoded = write([file(mode)]);
    expect(decoded.ok, `mode ${mode.toString(8)} must decode`).toBe(true);
    if (!decoded.ok) return;
    expect((decoded.frame as { files: Array<{ mode?: number }> }).files[0]?.mode).toBe(mode);
  });

  it.each<[string, number]>([
    ['setuid', 0o4755],
    ['setgid', 0o2755],
    ['sticky', 0o1755],
    ['setuid+setgid+sticky', 0o7644],
  ])('given a mode with %s set, should REFUSE at decode — these are never escalated to a click', (_label, mode) => {
    expect(write([file(mode)])).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([0o1000, 0o10000, 1_000_000])('given the out-of-range mode %s, should refuse', (mode) => {
    expect(write([file(mode)]).ok).toBe(false);
  });

  it('given a negative or non-integer mode, should refuse (unchanged from the non-negative integer rule)', () => {
    expect(write([file(-1)]).ok).toBe(false);
    expect(write([file(0.5)]).ok).toBe(false);
  });

  it(`given exactly ${MAX_FS_WRITE_FILES} files, should decode; given one more, should FAIL — not truncate, not partially write`, () => {
    const at = Array.from({ length: MAX_FS_WRITE_FILES }, () => file());
    expect(write(at).ok).toBe(true);
    const over = [...at, file()];
    expect(write(over)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('exports the cap so the daemon, the docs and this test cannot drift', () => {
    expect(MAX_FS_WRITE_FILES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_FS_WRITE_FILES)).toBe(true);
  });
});

describe('the frozen request on the wire carries what a WRITE card must say (hardening A7)', () => {
  const base = { type: 'grant_denied' as const, grantId: 'g1', sig: B64 };
  const request = { op: 'fs_write' as const, cwd: '/home/u/proj', paths: ['/home/u/proj/.git/hooks/pre-commit'], env: {}, timeoutMs: 1, maxBytes: 1, clamped: false };
  const decode = (pending: unknown) => decodeFrame(JSON.stringify({ ...base, reason: 'ask_pending:ch_1', pending }), LIMITS);

  it('given a pending write with its modes and the machine\'s own classification, should decode all of it', () => {
    const decoded = decode({
      challengeId: 'ch_1',
      expiresAt: 5,
      request: { ...request, writeModes: [0o755] },
      files: [{ path: '/home/u/proj/.git/hooks/pre-commit', mode: 0o755, bytes: 42, reason: 'vcs_metadata' }],
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.frame.type !== 'grant_denied') throw new Error('expected a grant_denied');
    expect(decoded.frame.pending?.request.writeModes).toEqual([0o755]);
    expect(decoded.frame.pending?.files).toEqual([{ path: '/home/u/proj/.git/hooks/pre-commit', mode: 0o755, bytes: 42, reason: 'vcs_metadata' }]);
  });

  it('given an exec pending (no modes, no files), should still decode — both are optional', () => {
    expect(decode({ challengeId: 'ch_1', expiresAt: 5, request }).ok).toBe(true);
  });

  it('given a file whose reason is not one of the classifier\'s, should REFUSE — the card must never render a word the machine did not mint', () => {
    expect(decode({ challengeId: 'ch_1', expiresAt: 5, request, files: [{ path: '/x', mode: null, bytes: 1, reason: 'looks_fine_to_me' }] }).ok).toBe(false);
  });

  it('given an unmodelled field beside them, should refuse (every level of the pending payload is strict)', () => {
    expect(decode({ challengeId: 'ch_1', expiresAt: 5, request, note: 'trust me' }).ok).toBe(false);
    expect(decode({ challengeId: 'ch_1', expiresAt: 5, request: { ...request, note: 'trust me' } }).ok).toBe(false);
    // Including inside a per-file finding: the card renders these, so nothing
    // may ride along beside the four fields it knows.
    expect(decode({ challengeId: 'ch_1', expiresAt: 5, request, files: [{ path: '/x', mode: null, bytes: 1, reason: null, note: 'trust me' }] }).ok).toBe(false);
  });

  it('given an ordinary file in a mixed write, should carry a null reason rather than being dropped — the card shows every path', () => {
    const decoded = decode({
      challengeId: 'ch_1',
      expiresAt: 5,
      request: { ...request, paths: ['/home/u/proj/src/a.ts', '/home/u/proj/Makefile'], writeModes: [null, null] },
      files: [
        { path: '/home/u/proj/src/a.ts', mode: null, bytes: 3, reason: null },
        { path: '/home/u/proj/Makefile', mode: null, bytes: 9, reason: 'build_or_task' },
      ],
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.frame.type !== 'grant_denied') throw new Error('expected a grant_denied');
    expect(decoded.frame.pending?.files?.map((file) => file.reason)).toEqual([null, 'build_or_task']);
  });
});
