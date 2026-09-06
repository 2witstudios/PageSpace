/**
 * The dev-preview RELAY contract — pure spec, no IO.
 *
 * WHY A RELAY EXISTS
 * ------------------
 * The sprite URL proxies to **port 8080 inside the VM, always**. A service's
 * `httpPort` is stored and does nothing; there is no one-http-port 409 and no
 * start-on-request. Live-verified twice, the second time with raw `fetch()`
 * against the documented endpoints and five-minute polling windows on a
 * sprite reporting the same runtime version the docs are written for
 * (docs/spikes/2026-08-dev-preview-sprite-services-spike.md §3, §8, §9).
 * So a dev server on 5173 is invisible to the URL until something on 8080
 * forwards to it. The relay is that something: a tiny runtime-managed
 * service (`SandboxHandle.services.create`) bound to 8080 that pipes bytes to
 * the detected dev-server port. Users keep their default ports; detection
 * keeps working on any port.
 *
 * MIGRATION SEAM — delete cleanly if the platform ships real httpPort routing
 * ---------------------------------------------------------------------------
 * If Sprites ever ships the documented behavior (a service's `httpPort`
 * becoming the URL's routing target), the relay is dead weight: the planner
 * would create the user's dev server itself as the service with `httpPort`,
 * `dev_preview_services.relayServiceName` would go NULL for every row, and
 * this module would be deleted. Everything that knows about the relay is
 * behind {@link PREVIEW_RELAY_SERVICE_NAME} and {@link buildPreviewRelaySpec};
 * the decision core plans it, the effects layer runs it, and nothing else
 * names it. Re-verify §3/§8 before pulling that lever — the docs already
 * claim the routing works, and it does not.
 *
 * WHAT RUNS
 * ---------
 * Two runtimes, chosen by the effects layer AFTER probing the sprite:
 *
 *  - `'node'` — a ~25-line `net` stream pipe passed as `node -e`. **Verified
 *    available**: `node` is present under `/.sprite/bin` (spike §1). This is
 *    the default because it is the one we have seen.
 *  - `'socat'` — `socat TCP-LISTEN:8080,fork,reuseaddr TCP:localhost:<port>`.
 *    **Assumed, not verified**: the spike inventoried `python3`, `node`, `bun`
 *    and the absence of `busybox`/`nc`; it did not look for `socat`. Use it
 *    only after `command -v socat` succeeds inside the sprite.
 *
 * Both bind `0.0.0.0:8080`. The spike's working 8080 listener was
 * `python3 -m http.server 8080` (all interfaces), so an all-interfaces bind
 * is the shape the proxy has been seen to reach; a loopback-only bind on
 * 8080 is NOT verified to be reachable and is deliberately not offered.
 *
 * The node relay connects to the target on `127.0.0.1` and falls back to
 * `::1` on a pre-connect error, because `vite` binds `localhost` (which on a
 * modern Node resolves to `::1` first) while `next dev` binds `0.0.0.0` —
 * both must work. That fallback is the whole reason the script is 25 lines
 * rather than 10.
 */

import type { CreateSandboxServiceArgs } from '../sandbox-host';

/** The port the sprite URL proxies to. The ONE slot a sprite has (spike §3). */
export const SPRITE_HTTP_PORT = 8080;

/**
 * The relay's service name — the one identity every layer agrees on. Stored
 * on the row (`dev_preview_services.relayServiceName`) so a row outlives a
 * rename of this constant; compared against `SandboxServiceInfo.name` on
 * every live read.
 */
export const PREVIEW_RELAY_SERVICE_NAME = 'pagespace-preview-relay';

export type PreviewRelayRuntime = 'node' | 'socat';

/**
 * The node relay. `node -e <script> <listenPort> <targetPort>` — with `-e`,
 * `process.argv` is `[node, listenPort, targetPort]` (there is no script
 * path), hence `argv[1]`/`argv[2]`. Listen port is an argument rather than
 * a constant so the contract can be exercised end-to-end on ephemeral ports
 * in a test (`__tests__/preview-relay.test.ts`) — the script below is the
 * exact text that runs in the sprite, not a look-alike.
 *
 * Behavior: one server socket, one upstream connection per client, bytes
 * piped both ways, both sides torn down when either errors or closes. On a
 * refused/unreachable upstream the client connection is closed (the browser
 * sees a dropped connection, the proxy task turns that into a 502), not held
 * open. A failed BIND exits non-zero so the service lands in `failed` with
 * the reason in its log — that is what tells the planner 8080 was taken.
 *
 * CommonJS (`require`) ON PURPOSE. This is not one of our sources; it is a
 * string handed to whatever `node` the sprite image ships (present, version
 * unpinned — spike §1). `node -e` + `require` runs on every Node there is;
 * `--input-type=module` would narrow that floor for no gain in 25 lines of
 * `net` calls. The repo's ESM guideline governs our TypeScript, not this.
 */
export const PREVIEW_RELAY_NODE_SCRIPT = `
const net = require('net');
const listenPort = Number(process.argv[1]);
const targetPort = Number(process.argv[2]);
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) { console.error('usage: <listenPort> <targetPort>'); process.exit(2); }
const server = net.createServer((client) => {
  const attempt = (host, fallback) => {
    const upstream = net.connect({ port: targetPort, host });
    let connected = false;
    upstream.once('connect', () => { connected = true; client.pipe(upstream); upstream.pipe(client); });
    upstream.on('error', () => { if (!connected && fallback) return attempt(fallback, undefined); client.destroy(); });
    upstream.on('close', () => { if (connected) client.destroy(); });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  };
  attempt('127.0.0.1', '::1');
});
server.on('error', (error) => { console.error('relay: ' + error.message); process.exit(1); });
server.listen(listenPort, '0.0.0.0', () => console.log('relay: ' + listenPort + ' -> ' + targetPort));
`.trim();

/**
 * A planned relay: exactly what `SandboxHandle.services.create` takes
 * (`name`/`command`/`args` — structurally a {@link CreateSandboxServiceArgs}),
 * plus the facts the row and the UI need. `httpPort` is deliberately NOT set:
 * it does not route (spike §3), and declaring it would tell a future reader
 * the platform is doing something it is not.
 */
export interface PreviewRelaySpec extends CreateSandboxServiceArgs {
  name: typeof PREVIEW_RELAY_SERVICE_NAME;
  command: string;
  args: string[];
  runtime: PreviewRelayRuntime;
  listenPort: typeof SPRITE_HTTP_PORT;
  targetPort: number;
}

/** A usable TCP port that is not the slot itself. */
export function isRelayableTargetPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535 && port !== SPRITE_HTTP_PORT;
}

/**
 * Pure: the relay service to start for `targetPort`. Throws on a port that is
 * not relayable — a relay from 8080 to 8080 is a loop, and the caller is
 * expected to have asked {@link isRelayableTargetPort} (the planner does).
 */
export function buildPreviewRelaySpec({
  targetPort,
  runtime = 'node',
}: {
  targetPort: number;
  runtime?: PreviewRelayRuntime;
}): PreviewRelaySpec {
  if (!isRelayableTargetPort(targetPort)) {
    throw new RangeError(`preview relay target must be a TCP port other than ${SPRITE_HTTP_PORT}, got ${targetPort}`);
  }
  const base = { name: PREVIEW_RELAY_SERVICE_NAME, runtime, listenPort: SPRITE_HTTP_PORT, targetPort } as const;
  if (runtime === 'socat') {
    return {
      ...base,
      command: 'socat',
      args: [`TCP-LISTEN:${SPRITE_HTTP_PORT},fork,reuseaddr,bind=0.0.0.0`, `TCP:localhost:${targetPort}`],
    };
  }
  return {
    ...base,
    command: 'node',
    args: ['-e', PREVIEW_RELAY_NODE_SCRIPT, String(SPRITE_HTTP_PORT), String(targetPort)],
  };
}

/**
 * Pure: does a live service record match `spec` exactly — same command AND
 * args? Used to tell "restart the relay we already defined" (`services.start`)
 * from "the defined relay points somewhere else" (remove + create). The
 * services API's create is an idempotent PUT that answers a repeat of an
 * IDENTICAL request with a no-op (spike §8); what it does with a DIFFERENT
 * command under the same name is unverified, so the planner never relies on
 * it and always removes first.
 */
export function relayServiceMatches(
  service: { command: string; args: readonly string[] },
  spec: Pick<PreviewRelaySpec, 'command' | 'args'>,
): boolean {
  return service.command === spec.command && service.args.length === spec.args.length
    && service.args.every((arg, index) => arg === spec.args[index]);
}
