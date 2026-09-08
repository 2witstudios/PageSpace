/**
 * The probe is the only thing licensed to say a port is NOT listening, so its
 * failure modes matter more than its happy path: an empty array where a
 * failure belongs would read as "8080 is free" and start a relay blind.
 *
 * The fixtures below are REAL `ss -ltnp` output captured from live sprites
 * during the investigation that produced this module — including the Next.js
 * line the `ports/watch` channel never reported.
 */
import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { parseListeningPorts, probeListeningPorts, PORT_PROBE_TIMEOUT_MS } from '../port-probe';
import type { RunCommandArgs, SandboxRunResult } from '../../sandbox-client/types';

// Captured verbatim from the sandbox running `next dev` — the case that
// started all of this. Note the header's mangled spacing and the pid buried
// in a `users:((...))` blob.
const NEXT_OUTPUT = `State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
LISTEN 0      511                *:3000            *:*    users:(("next-server (v1",pid=2311,fd=24))
`;

// Captured from a scratch sprite running two python servers, no pid column.
const PLAIN_OUTPUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
LISTEN 0      5            0.0.0.0:7222      0.0.0.0:*
LISTEN 0      5            0.0.0.0:7111      0.0.0.0:*
`;

const ok = (over: Partial<SandboxRunResult> = {}): SandboxRunResult => ({ exitCode: 0, stdout: '', stderr: '', ...over });

describe('parseListeningPorts', () => {
  it('reads the port and pid out of real ss output', () => {
    assert({
      given: 'the captured next dev line',
      should: 'yield port 3000 with its pid',
      actual: parseListeningPorts(NEXT_OUTPUT),
      expected: [{ port: 3000, pid: 2311 }],
    });
  });

  it('reads a pid-less line, and sorts', () => {
    assert({
      given: 'two listeners with no process column',
      should: 'yield both ports in order, without inventing pids',
      actual: parseListeningPorts(PLAIN_OUTPUT),
      expected: [{ port: 7111 }, { port: 7222 }],
    });
  });

  it('takes the port after the LAST colon, so IPv6 does not fool it', () => {
    // `[::]:3000` and `*:3000` are the two shapes a dual-stack bind takes, and
    // splitting on the first colon would read `[` or an empty string.
    const v6 = 'LISTEN 0      511               [::]:5173           [::]:*    users:(("node",pid=99,fd=20))';
    assert({
      given: 'an IPv6 local address carrying its own colons',
      should: 'still read 5173',
      actual: parseListeningPorts(v6),
      expected: [{ port: 5173, pid: 99 }],
    });
  });

  it('drops anything that is not a listening socket rather than guessing', () => {
    const noise = 'State Recv-Q Send-Q Local Address:Port\nESTAB 0 0 10.0.0.1:44001 10.0.0.2:443\ngarbage\nLISTEN 0 5 0.0.0.0:70000 0.0.0.0:*\n';
    assert({
      given: 'a header, an established connection, junk, and an out-of-range port',
      should: 'yield nothing — none of those is a listening port',
      actual: parseListeningPorts(noise),
      expected: [],
    });
  });

  it('collapses a dual-stack bind, preferring the entry that knows the pid', () => {
    const dual = 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\nLISTEN 0 511 [::]:3000 [::]:* users:(("next-server",pid=7,fd=1))\n';
    assert({
      given: 'the same port bound on IPv4 and IPv6',
      should: 'report it once, carrying the pid',
      actual: parseListeningPorts(dual),
      expected: [{ port: 3000, pid: 7 }],
    });
  });
});

describe('probeListeningPorts', () => {
  it('bounds the command, because it runs inside the holder advisory lock', async () => {
    let seen: RunCommandArgs | null = null;
    await probeListeningPorts(async (args) => { seen = args; return ok({ stdout: NEXT_OUTPUT }); });
    const args = seen as unknown as RunCommandArgs;
    assert({
      given: 'a probe run',
      should: 'go through sh -c with a wall-clock cap and an output cap',
      actual: [args.cmd, args.timeoutMs === PORT_PROBE_TIMEOUT_MS, typeof args.maxBytes === 'number'],
      expected: ['sh', true, true],
    });
  });

  it('an EMPTY sandbox is an honest answer, not a failure', async () => {
    assert({
      given: 'ss exiting 0 with no listening rows',
      should: 'be ok with no ports — nothing is bound, and we can say so',
      actual: await probeListeningPorts(async () => ok({ stdout: 'State Recv-Q Send-Q Local Address:Port\n' })),
      expected: { ok: true, ports: [] },
    });
  });

  it('a FAILED command is never spellable as "nothing is listening"', async () => {
    // This is the whole reason the result is not an array. `[]` here would
    // reach the core as "8080 is free" and start a relay blind.
    assert({
      given: 'no ss or netstat in the image (non-zero exit, no output)',
      should: 'be a named failure, not an empty list',
      actual: await probeListeningPorts(async () => ok({ exitCode: 127, stderr: 'sh: ss: not found' })),
      expected: { ok: false, reason: 'unavailable' },
    });
  });

  it('separates "we ran out of time" from "we could not look"', async () => {
    assert({
      given: 'the driver killing the command at the cap',
      should: 'say timed-out',
      actual: await probeListeningPorts(async () => { throw new Error('Command timed out after 5000ms'); }),
      expected: { ok: false, reason: 'timed-out' },
    });
    assert({
      given: 'the control plane refusing the exec',
      should: 'say unavailable',
      actual: await probeListeningPorts(async () => { throw new Error('sprite not found'); }),
      expected: { ok: false, reason: 'unavailable' },
    });
  });
});
