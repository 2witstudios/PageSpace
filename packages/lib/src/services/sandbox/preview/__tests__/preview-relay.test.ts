/**
 * The relay CONTRACT, exercised for real: the exact `node -e` script the
 * planner ships is spawned on ephemeral ports and bytes are pushed through
 * it. Everything else in `preview/` is pure; this is the one place the
 * plumbing itself is proven rather than described.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { assert } from '../../__tests__/riteway';
import {
  PREVIEW_RELAY_NODE_SCRIPT,
  PREVIEW_RELAY_SERVICE_NAME,
  SPRITE_HTTP_PORT,
  buildPreviewRelaySpec,
  isRelayableTargetPort,
  relayServiceMatches,
} from '../preview-relay';

const cleanups: Array<() => Promise<void> | void> = [];

/** Whether this host has an IPv6 loopback to bind — decided up front so an absent proof reads as SKIPPED, never as green. */
const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function listenHttp(host: string, body: string): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((_req, res) => res.end(body));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as AddressInfo).port };
}

/**
 * GET `/` through node's own http client. NOT global `fetch`: the lib test
 * setup replaces `fetch` with a mock (it returns undefined), so a fetch here
 * would test the mock, not the relay. Resolves the body, or the failure
 * kind — `'dropped'` (connection reset/closed before a response) or
 * `'hung'` (no response within `timeoutMs`).
 */
function httpGet(port: number, timeoutMs = 5000): Promise<{ kind: 'body'; body: string } | { kind: 'dropped' } | { kind: 'hung' }> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ kind: 'body', body }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ kind: 'hung' }); });
    req.on('error', () => resolve({ kind: 'dropped' }));
    req.end();
  });
}

interface RelayProcess {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
}

async function startRelay(listenPort: number, targetPort: number): Promise<RelayProcess> {
  const spec = buildPreviewRelaySpec({ targetPort: 1 }); // runtime shape only — args are rebuilt below on test ports
  const child = spawn(spec.command, ['-e', PREVIEW_RELAY_NODE_SCRIPT, String(listenPort), String(targetPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  cleanups.push(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } });
  // Ready when the script logs its bind, or dead when it exits first. EVENT
  // driven, never a polling timer: this package runs every test file in ONE
  // process (`singleFork`), so a timer loop left ticking here would still be
  // rescheduling itself when a later file installs fake timers — and
  // `runAllTimers` there would chase it forever ("Aborting after 10000
  // timers"). That is exactly what an earlier cut of this helper did to
  // `http-executor.test.ts` on CI.
  const ready = new Promise<void>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('relay: ')) resolve();
    });
  });
  await Promise.race([ready, exited]);
  return { child, stderr: () => stderr, exited };
}

describe('buildPreviewRelaySpec', () => {
  it('produces a create-able service bound to 8080 with no httpPort claim', () => {
    const spec = buildPreviewRelaySpec({ targetPort: 5173 });
    assert({ given: 'target 5173 (default runtime)', should: 'name the relay service', actual: spec.name, expected: PREVIEW_RELAY_SERVICE_NAME });
    assert({ given: 'target 5173', should: 'run node -e with listen 8080 and target 5173', actual: [spec.command, spec.args[0], spec.args[2], spec.args[3]], expected: ['node', '-e', '8080', '5173'] });
    assert({ given: 'target 5173', should: 'ship the exact relay script', actual: spec.args[1], expected: PREVIEW_RELAY_NODE_SCRIPT });
    assert({ given: 'any relay spec', should: 'NOT declare httpPort (it does not route — spike §3)', actual: 'httpPort' in spec, expected: false });
    assert({ given: 'any relay spec', should: 'carry the slot and target as data', actual: [spec.listenPort, spec.targetPort, spec.runtime], expected: [SPRITE_HTTP_PORT, 5173, 'node'] });
  });

  it('builds the socat form when asked', () => {
    assert({
      given: 'runtime socat',
      should: 'listen on 8080 all interfaces with fork and forward to localhost:target',
      actual: buildPreviewRelaySpec({ targetPort: 3000, runtime: 'socat' }),
      expected: {
        name: PREVIEW_RELAY_SERVICE_NAME, runtime: 'socat', listenPort: 8080, targetPort: 3000,
        command: 'socat', args: ['TCP-LISTEN:8080,fork,reuseaddr,bind=0.0.0.0', 'TCP:localhost:3000'],
      },
    });
  });

  it('refuses a target that is the slot itself or not a port', () => {
    for (const port of [8080, 0, 65536, 1.5]) {
      expect(() => buildPreviewRelaySpec({ targetPort: port }), `port ${port}`).toThrow(RangeError);
      assert({ given: `port ${port}`, should: 'not be relayable', actual: isRelayableTargetPort(port), expected: false });
    }
    assert({ given: 'port 5173', should: 'be relayable', actual: isRelayableTargetPort(5173), expected: true });
  });
});

describe('relayServiceMatches', () => {
  it('matches only an identical command and args', () => {
    const spec = buildPreviewRelaySpec({ targetPort: 5173 });
    assert({ given: 'the same command/args', should: 'match', actual: relayServiceMatches({ command: spec.command, args: [...spec.args] }, spec), expected: true });
    assert({ given: 'a different target port in args', should: 'not match', actual: relayServiceMatches({ command: spec.command, args: buildPreviewRelaySpec({ targetPort: 3000 }).args }, spec), expected: false });
    assert({ given: 'a different command', should: 'not match', actual: relayServiceMatches({ command: 'socat', args: [...spec.args] }, spec), expected: false });
    assert({ given: 'a shorter args list', should: 'not match', actual: relayServiceMatches({ command: spec.command, args: spec.args.slice(0, 3) }, spec), expected: false });
  });
});

describe('PREVIEW_RELAY_NODE_SCRIPT (end to end on ephemeral ports)', () => {
  it('relays HTTP from the listen port to an IPv4 upstream', async () => {
    const upstream = await listenHttp('127.0.0.1', 'MARKER-UPSTREAM-IPV4');
    const listenPort = await freePort();
    await startRelay(listenPort, upstream.port);
    assert({ given: 'a request to the relay', should: 'answer with the upstream body', actual: await httpGet(listenPort), expected: { kind: 'body', body: 'MARKER-UPSTREAM-IPV4' } });
  });

  it.skipIf(!hasIpv6Loopback)('falls back to ::1 when the upstream binds IPv6 loopback only (vite binds localhost)', async () => {
    const upstream = await listenHttp('::1', 'MARKER-UPSTREAM-IPV6');
    const listenPort = await freePort();
    await startRelay(listenPort, upstream.port);
    assert({ given: 'an upstream on ::1 only', should: 'still be reached through the fallback', actual: await httpGet(listenPort), expected: { kind: 'body', body: 'MARKER-UPSTREAM-IPV6' } });
  });

  it('drops the client connection when nothing listens on the target, instead of hanging', async () => {
    const targetPort = await freePort();
    const listenPort = await freePort();
    await startRelay(listenPort, targetPort);
    assert({ given: 'a dead upstream', should: 'drop the connection promptly', actual: await httpGet(listenPort), expected: { kind: 'dropped' } });
  });

  it('exits non-zero with the reason when the listen port is already taken (the busy-slot signal)', async () => {
    const occupant = await listenHttp('0.0.0.0', 'OCCUPANT');
    const relay = await startRelay(occupant.port, 1);
    assert({ given: 'the listen port held by another process', should: 'exit 1', actual: await relay.exited, expected: 1 });
    assert({ given: 'the listen port held by another process', should: 'say why on stderr', actual: relay.stderr().includes('relay: ') && relay.stderr().includes('EADDRINUSE'), expected: true });
  });

  it('refuses malformed ports with a usage error', async () => {
    const child = spawn('node', ['-e', PREVIEW_RELAY_NODE_SCRIPT, 'nope', '5173'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert({ given: 'a non-numeric listen port', should: 'exit 2', actual: code, expected: 2 });
  });
});
