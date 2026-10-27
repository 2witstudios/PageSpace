/**
 * Capture-and-reinject for the two bridge negatives that need a real frame
 * (Local Environments epic, M1 · t10):
 *
 *   R1 replay  — re-send a captured `grant_exec` byte-for-byte  → `grant_denied replayed`
 *   R2 tamper  — alter `grant.argsHash` in that frame           → `grant_denied args_mismatch`
 *   R3 tamper  — alter `grant.grantId` in that frame            → `grant_denied bad_signature`
 *
 * Neither can be faked. A replay is only a replay against the SAME daemon
 * process holding the SAME nonce store, and a tampered grant is only
 * interesting if the rest of it is a genuine server signature. So this is a
 * transparent reverse proxy the daemon dials instead of the app:
 *
 *   pagespace env connect --host http://127.0.0.1:8788
 *          │                                   │
 *          │  ws /api/env-bridge/ws            │  ws → the real app
 *          └──────────► [ this proxy ] ────────┘
 *                          records every frame with the REAL codec
 *                          (packages/lib/src/env-bridge/frame-codec.ts),
 *                          then injects R1 / R2 into the DAEMON socket only.
 *
 * `env enroll` and `env token` are ordinary HTTP and are forwarded too, so the
 * same run captures the challenge nonce + signature that `identity-negatives.ts`
 * needs for N04 (replaying a spent challenge response). Use the SAME
 * `--host http://127.0.0.1:<port>` for enroll, token and connect: the CLI keys
 * its credential store by host, so mixing hosts loses the machine credential.
 *
 * WHAT EACH INJECTION PINS
 *   R1 → `verifyGrant` in packages/lib/src/env-bridge/grant.ts:261 (`nonces.has`
 *        ⇒ `replayed`), reached through packages/cli/src/env-bridge/dispatcher.ts.
 *   R2 → the FRAME BINDING in the same function (grant.ts:238-241, Codex P1 /
 *        PR #2527): the daemon recomputes `hash(canonicalizeArgs(request.args))`
 *        from the frame and compares it to the signed `argsHash` BEFORE it
 *        verifies the signature. So an edited `argsHash` is refused
 *        `args_mismatch`, not `bad_signature` — the task page names the latter
 *        and the code has said the former since #2527. See the dry-run audit on
 *        the task page (drift D-a). `args_mismatch` is the STRONGER refusal:
 *        it holds even against a validly signed grant for other work.
 *   R3 → the signature check itself (grant.ts:250-256). `grantId` is inside
 *        `encodeGrant`'s bytes but is not re-derived from the frame, so editing
 *        it reaches the Ed25519 verification and fails there. This is the row
 *        that actually proves the server key is checked; without it, R2 alone
 *        would pass even on a daemon that never verified a signature.
 *
 * TWO CONSTRAINTS, both of which make a wrong answer instead of a wrong verdict:
 *   - The daemon denies any grant whose `iat` predates its own start
 *     (`grantPredatesDaemon`, Codex C6). Inject into the daemon that received
 *     the frame — never after a restart, or R1 answers `predates_daemon`.
 *   - A grant expires 60 s after issue (`GRANT_MAX_TTL_MS`). Injection happens
 *     automatically the moment the daemon answers the original, and the elapsed
 *     ms is printed; if R1 ever answers `expired`, the capture was too slow and
 *     the run is void. Drive R1/R2 with an op that is PRE-APPROVED in the
 *     policy `ops` so no human prompt sits inside that window.
 *
 * Usage:
 *   PAGESPACE_GATE_UPSTREAM=http://127.0.0.1:3000 PAGESPACE_GATE_PROXY_PORT=8788 \
 *   bun scripts/env-bridge-exit-gate/bridge-proxy.ts
 * then, in another terminal, drive one `exec` from the agent pane. The proxy
 * prints GATE R1 / GATE R2 and exits non-zero if either did not hold.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';
import { decodeFrame, encodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { acceptUpgrade, openClient, type MinSocket } from './ws-min';
import { expect, optional, required, summarize } from './report';

const upstream = new URL(required('PAGESPACE_GATE_UPSTREAM'));
const port = Number(optional('PAGESPACE_GATE_PROXY_PORT') ?? '8788');
const transcript = optional('PAGESPACE_GATE_TRANSCRIPT') ?? 'env-bridge-gate-frames.jsonl';

type Direction = 'server->machine' | 'machine->server';

function log(entry: Record<string, unknown>): void {
  appendFileSync(transcript, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** Plain HTTP passthrough, so enroll/token go to the real app through the same host string. */
function proxyHttp(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    // The challenge response N04 needs is in this body; recording it here is
    // the only place it exists outside the daemon's memory.
    if (req.url?.startsWith('/api/env-bridge/token') && req.method === 'POST') {
      log({ kind: 'http', url: req.url, body: body.toString('utf8') });
    }
    const forwarded = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: upstream.host },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    forwarded.on('error', () => {
      res.writeHead(502).end('upstream unreachable');
    });
    forwarded.end(body);
  });
}

interface Capture {
  /** The exact bytes that arrived from the server. */
  readonly raw: string;
  readonly frame: Frame;
  readonly at: number;
}

async function main(): Promise<void> {
  let lastGrant: Capture | null = null;
  /** While true, machine frames are answers to an INJECTION and must not reach the app. */
  let intercepting: ((frame: Frame) => void) | null = null;
  let injected = 0;

  const server = createServer(proxyHttp);

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!req.url?.startsWith('/api/env-bridge/ws') || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const daemonSocket = acceptUpgrade(socket, key, head);
    const target = new URL(req.url, upstream);
    target.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';

    void openClient(target.toString(), { Authorization: req.headers.authorization ?? '' })
      .then((appSocket) => wire(daemonSocket, appSocket))
      .catch((error: unknown) => {
        log({ kind: 'upstream_upgrade_failed', error: error instanceof Error ? error.message : String(error) });
        daemonSocket.close(1011, 'upstream upgrade failed');
      });
  });

  /** Relay both directions, recording every frame and injecting once the first exec round trip closes. */
  function wire(daemonSocket: MinSocket, appSocket: MinSocket): void {
    /** Decode with the real codec so the transcript records what the daemon will actually see. */
    const observe = (direction: Direction, data: string): Frame | null => {
      const verdict = decodeFrame(data, { maxFrameBytes: 1_048_576 });
      log({ kind: 'frame', direction, ok: verdict.ok, ...(verdict.ok ? { frame: verdict.frame } : { reason: verdict.reason }) });
      return verdict.ok ? verdict.frame : null;
    };

    appSocket.on('message', (text: string) => {
      const frame = observe('server->machine', text);
      if (frame?.type === 'grant_exec') lastGrant = { raw: text, frame, at: Date.now() };
      daemonSocket.send(text);
    });

    daemonSocket.on('message', (text: string) => {
      const frame = observe('machine->server', text);
      const waiting = intercepting;
      if (waiting !== null && frame !== null) {
        // An answer to something the app never sent: swallow it, or the
        // server's correlator would see a second reply for a grantId it has
        // already resolved.
        intercepting = null;
        waiting(frame);
        return;
      }
      appSocket.send(text);
      // The original round trip is complete; inject NOW, while the grant is
      // still inside its 60 s window and this daemon still holds its nonce.
      if (lastGrant !== null && injected === 0 && (frame?.type === 'exec_result' || frame?.type === 'grant_denied')) {
        injected = 1;
        void runInjections(daemonSocket, lastGrant, (fn) => {
          intercepting = fn;
        }).then(() => {
          process.exitCode = summarize('bridge-proxy injections');
          process.stdout.write('Injections done. Ctrl-C to stop the proxy.\n');
        });
      }
    });

    appSocket.on('close', (code: number, reason: string) => daemonSocket.close(code === 1005 || code === 1006 ? 1000 : code, reason));
    daemonSocket.on('close', () => appSocket.close(1000, ''));
    appSocket.on('error', () => daemonSocket.close(1011, 'upstream error'));
    daemonSocket.on('error', () => appSocket.close(1011, 'daemon error'));
  }

  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`bridge proxy 127.0.0.1:${port} -> ${upstream.origin}; frames -> ${transcript}\n`);
    process.stdout.write('Now run:  pagespace env connect <enrollmentId> --host http://127.0.0.1:' + String(port) + '\n');
  });
}

/** Send one frame to the daemon and resolve with its answer (or a timeout marker). */
function ask(socket: MinSocket, payload: string, arm: (fn: (frame: Frame) => void) => void): Promise<Frame | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    arm((frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
    socket.send(payload);
  });
}

const denyReason = (frame: Frame | null): string => (frame === null ? 'no answer within 15s' : frame.type === 'grant_denied' ? frame.reason : `${frame.type} (the daemon ACTED on it)`);

async function runInjections(daemonSocket: MinSocket, capture: Capture, arm: (fn: (frame: Frame) => void) => void): Promise<void> {
  const ageMs = Date.now() - capture.at;
  process.stdout.write(`INJECT grant captured ${String(ageMs)} ms ago (grant TTL is 60000 ms)\n`);

  // R1 — the identical bytes. The nonce is spent, so `verifyGrant` refuses
  // before any policy runs and nothing can execute.
  const replayed = await ask(daemonSocket, capture.raw, arm);
  expect('R1', 'replayed', denyReason(replayed), 'a captured grant_exec re-injected into the same daemon');

  // R2 — `argsHash` edited. The daemon re-derives the hash from the frame's own
  // args and compares BEFORE verifying the signature, so this is refused as a
  // frame-binding failure. See the header: the task page says `bad_signature`;
  // the code has said `args_mismatch` since #2527, and R3 below is what covers
  // the signature.
  const withBadArgsHash = mutateGrantField(capture.raw, 'argsHash');
  if (withBadArgsHash === null) {
    expect('R2', 'args_mismatch', 'the tampered frame did not decode', 'tampering must keep the envelope valid');
  } else {
    const tampered = await ask(daemonSocket, withBadArgsHash, arm);
    expect('R2', 'args_mismatch', denyReason(tampered), 'a captured grant_exec with argsHash altered');
  }

  // R3 — `grantId` edited: signed, but nothing re-derives it, so the Ed25519
  // check is what refuses this one.
  const withBadGrantId = mutateGrantField(capture.raw, 'grantId');
  if (withBadGrantId === null) {
    expect('R3', 'bad_signature', 'the tampered frame did not decode', 'tampering must keep the envelope valid');
  } else {
    const tampered = await ask(daemonSocket, withBadGrantId, arm);
    expect('R3', 'bad_signature', denyReason(tampered), 'a captured grant_exec with grantId altered');
  }
}

/**
 * Change ONE character of one signed grant field, keeping its length and
 * alphabet so the strict grant parser still accepts the shape (a malformed
 * value would be refused `malformed` and would prove nothing), and re-encode
 * through the real codec so nothing else about the frame differs.
 * @returns the wire string, or `null` if the result no longer decodes.
 */
function mutateGrantField(raw: string, field: 'argsHash' | 'grantId'): string | null {
  const parsed: unknown = JSON.parse(raw);
  const asFrame = parsed as { grant: Record<string, unknown> };
  const original = String(asFrame.grant[field] ?? '');
  const last = original.slice(-1);
  asFrame.grant[field] = original.length > 0 ? `${original.slice(0, -1)}${last === 'a' ? 'b' : 'a'}` : 'a'.repeat(64);
  const verdict = decodeFrame(JSON.stringify(parsed), { maxFrameBytes: 1_048_576 });
  return verdict.ok ? encodeFrame(verdict.frame) : null;
}

void main();
