import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openPtyShell } from '../sprites-shell';
import type { SpriteInstanceLike, SpriteCommandLike, SpriteSessionInfo } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

type FakeCommand = SpriteCommandLike & { _stdout: EventEmitter; _stderr: EventEmitter; _emitter: EventEmitter };
function buildFakeCommand(): FakeCommand {
  const _stdout = new EventEmitter();
  const _stderr = new EventEmitter();
  const _emitter = new EventEmitter();
  const cmd: FakeCommand = {
    _stdout, _stderr, _emitter,
    stdout: { on: (e, l) => { _stdout.on(e, l); return _stdout; } },
    stderr: { on: (e, l) => { _stderr.on(e, l); return _stderr; } },
    stdin: { write: vi.fn() },
    resize: vi.fn(),
    kill: vi.fn(),
    on: (e: string, l: (...a: unknown[]) => void) => { _emitter.on(e, l); return _emitter; },
  } as unknown as FakeCommand;
  return cmd;
}

// deterministic PRNG
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const BANNER = 'Welcome to PageSpace\r\nsandbox:~$ ';

function isSubsequence(needle: Buffer, hay: Buffer): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

describe('fuzz', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  for (let seed = 1; seed <= 300; seed += 1) {
    it(`seed-${String(seed).padStart(4,'0')}`, async () => {
      const rand = rng(seed);
      const ringSize = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024][Math.floor(rand() * 4)];

      // Server model: one session at a time, its full stdout stream.
      let stream = Buffer.alloc(0); // stream of the CURRENT session
      const allStreams: Buffer[] = []; // completed sessions' streams (in order)
      let sessionAlive = true;
      let liveIds: SpriteSessionInfo[] = [];
      let live: FakeCommand;
      let lineNo = 0;

      const rendered: string[] = [];
      let stderrCount = 0;
      const stderrMark = ''; // stderr uses only this byte

      const created: FakeCommand[] = [];
      const sprite = {
        name: 'fake',
        createSession: vi.fn(() => { const c = buildFakeCommand(); created.push(c); return c; }),
        attachSession: vi.fn(() => { const c = buildFakeCommand(); created.push(c); return c; }),
        listSessions: vi.fn(async () => liveIds),
      } as unknown as SpriteInstanceLike;

      const shell = openPtyShell({
        sprite, cols: 80, rows: 24,
        onOutput: (d) => rendered.push(d),
        onExit: vi.fn(),
      });
      live = created[0];
      live._emitter.emit('message', { type: 'session_info', session_id: 'sess-1', command: 'bash', tty: true });
      liveIds = [{ id: 'sess-1', command: 'bash', isActive: true, tty: true }];
      live._emitter.emit('spawn');

      // produce output on the live socket, chunked randomly, appending to `stream`
      const produce = (text: string, cmd: FakeCommand = live, record = true) => {
        const b = Buffer.from(text, 'utf8');
        if (record) stream = Buffer.concat([stream, b]);
        let off = 0;
        while (off < b.length) {
          const n = 1 + Math.floor(rand() * Math.max(1, Math.floor(b.length / 3) + 1));
          const piece = b.subarray(off, off + n);
          if (rand() < 0.5) cmd._stdout.emit('data', piece);
          else cmd._stdout.emit('data', piece.toString('utf8'));
          off += n;
        }
      };
      const lines = (n: number) => Array.from({ length: n }, () => `line ${lineNo++} ${'.'.repeat(Math.floor(rand() * 60))}\r\n`).join('');

      produce(BANNER);
      await vi.advanceTimersByTimeAsync(1200);

      for (let step = 0; step < 12; step += 1) {
        const r = rand();
        if (r < 0.3) {
          produce(lines(1 + Math.floor(rand() * 300)));
          await vi.advanceTimersByTimeAsync(rand() < 0.5 ? 20 : 1500);
        } else if (r < 0.4) {
          live._stderr.emit('data', Buffer.from(stderrMark, 'utf8'));
          stderrCount += 1;
          await vi.advanceTimersByTimeAsync(1500);
        } else {
          // watchdog drop -> reconnect
          const willDie = rand() < 0.25;
          const pendingDrain = rand() < 0.4 ? lines(1) : '';
          if (pendingDrain) stream = Buffer.concat([stream, Buffer.from(pendingDrain, 'utf8')]);
          const dead = live;
          dead._emitter.emit('error', new Error('keepalive'));
          const drainEarly = rand() < 0.5;
          if (pendingDrain && drainEarly) {
            dead._stdout.emit('data', Buffer.from(pendingDrain, 'utf8'));
          }
          if (willDie) { liveIds = []; sessionAlive = false; }
          await vi.advanceTimersByTimeAsync(300);
          const next = created[created.length - 1];
          let drained = drainEarly;
          if (pendingDrain && !drainEarly && rand() < 0.4) {
            dead._stdout.emit('data', Buffer.from(pendingDrain, 'utf8'));
            drained = true;
          }
          if (!sessionAlive) {
            // a fresh session's socket is a DIFFERENT socket: ordering against the
            // dead one's drain is inherently racy, so drain first.
            if (pendingDrain && !drained) { dead._stdout.emit('data', Buffer.from(pendingDrain, 'utf8')); drained = true; }
            // fresh session created: old stream is done
            allStreams.push(stream);
            stream = Buffer.alloc(0);
            sessionAlive = true;
            liveIds = [{ id: `sess-${step + 2}`, command: 'bash', isActive: true, tty: true }];
            next._emitter.emit('message', { type: 'session_info', session_id: `sess-${step + 2}`, command: 'bash', tty: true });
            next._emitter.emit('spawn');
            live = next;
            produce(BANNER);
          } else {
            live = next;
            next._emitter.emit('spawn');
            // replay: the ring
            const ring = stream.subarray(Math.max(0, stream.length - ringSize));
            console.log('ATTACH step', step, 'stream', stream.length, 'ring', ring.length, 'drainEarly', drainEarly, 'drain', pendingDrain.length);
            let off = 0;
            let pieces = 0;
            while (off < ring.length) {
              const n = 1 + Math.floor(rand() * 8192);
              live._stdout.emit('data', ring.subarray(off, off + n));
              off += n;
              pieces += 1;
              // The nastiest interleave: the dead socket drains WHILE the successor
              // is already holding an unresolved replay.
              if (pieces === 1 && pendingDrain && !drainEarly && rand() < 0.6) {
                dead._stdout.emit('data', Buffer.from(pendingDrain, 'utf8'));
                drained = true;
              }
              // stderr arriving WHILE stdout is being held by the replay window
              if (pieces === 1 && rand() < 0.5) { live._stderr.emit('data', Buffer.from(stderrMark, 'utf8')); stderrCount += 1; }
              if (pieces === 1 && rand() < 0.2) { dead._stderr.emit('data', Buffer.from(stderrMark, 'utf8')); stderrCount += 1; }
            }
          }
          if (pendingDrain && !drained) {
            dead._stdout.emit('data', Buffer.from(pendingDrain, 'utf8'));
          }
          await vi.advanceTimersByTimeAsync(1500);
        }
      }
      await vi.advanceTimersByTimeAsync(5000);
      allStreams.push(stream);

      const out = rendered.join('');
      const outNoErr = out.split(stderrMark).join('');

      // (a) no loss: byte-level subsequence
      const trueStream = Buffer.concat(allStreams);
      if (!isSubsequence(trueStream, Buffer.from(outNoErr, 'utf8'))) {
        const hay = Buffer.from(outNoErr, 'utf8');
        let ii = 0;
        for (let j = 0; j < hay.length && ii < trueStream.length; j += 1) if (hay[j] === trueStream[ii]) ii += 1;
        console.log('RINGSIZE', ringSize, 'stalled at stream byte', ii, 'of', trueStream.length);
        console.log('CONTEXT >>>', JSON.stringify(trueStream.subarray(Math.max(0, ii - 120), ii + 60).toString('utf8')));
      }
      expect(isSubsequence(trueStream, Buffer.from(outNoErr, 'utf8'))).toBe(true);

      // (a2) STRONGER no-loss: every produced line appears, in order, among the
      // rendered lines (lines are unique by construction).
      const wantLines = trueStream.toString('utf8').split('\r\n').filter((l) => l.startsWith('line '));
      const gotLines = outNoErr.split('\r\n');
      let i = 0;
      const missing: string[] = [];
      for (const w of wantLines) {
        const at = gotLines.indexOf(w, i);
        if (at === -1) missing.push(w);
        else i = at + 1;
      }
      expect(missing).toEqual([]);

      // (c) stderr is never silently dropped
      expect(out.split(stderrMark).length - 1).toBe(stderrCount);

      // (b) dedupe works: the banner appears once per CREATED session (never per reconnect)
      const banners = out.split(BANNER).length - 1;
      if (banners > allStreams.length) console.log('BANNERFAIL ring', ringSize, 'banners', banners, 'sessions', allStreams.length);
      expect(banners).toBeLessThanOrEqual(allStreams.length);

      shell.kill();
    });
  }
});
