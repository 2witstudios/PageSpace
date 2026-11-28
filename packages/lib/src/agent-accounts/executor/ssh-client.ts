/**
 * `createSshClient` — the credential plane's SSH transport (slice 5). I/O only.
 *
 * Destination rules, the SSH twin of the pinned HTTPS client:
 * - the host is resolved here, with its own deadline; EVERY answer must be a
 *   public address (`isPublic`) — the plane lives on a private network, so an
 *   account can never be aimed at it — and the connection goes to the
 *   resolved address, never a second lookup;
 * - the server must present EXACTLY the host key the person confirmed
 *   (`hostKeySha256`, OpenSSH `SHA256:` form): any other key ends the
 *   handshake before the client authenticates, so a man in the middle learns
 *   nothing and receives no signature;
 * - public-key authentication only, never a password or agent forwarding;
 *   no port forwarding, no shell — one `exec`, with a total deadline and
 *   output caps; a command still running at the deadline is reported
 *   `timeout` (it may have had effects: `sent: true`).
 */
import { createHash } from 'node:crypto';
import { Client, utils } from 'ssh2';
import { sshFingerprintOf } from '../ssh/ssh-command';

export type SshLimits = { readonly connectTimeoutMs: number; readonly totalTimeoutMs: number; readonly maxOutputBytes: number };
export const DEFAULT_SSH_LIMITS: SshLimits = { connectTimeoutMs: 10_000, totalTimeoutMs: 60_000, maxOutputBytes: 256 * 1024 };

export type SshFailure = 'unresolvable' | 'address_refused' | 'host_key_mismatch' | 'auth_failed' | 'unreachable' | 'timeout';

export type SshExecOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly signal: string | null; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly truncated: boolean }
  /** `sent`: the command may have started on the server (an unknown outcome, never "nothing happened"). */
  | { readonly kind: 'failed'; readonly reason: SshFailure; readonly sent: boolean };

export type SshClient = {
  /** The host key a server presents (no authentication is attempted). */
  readonly hostKey: (input: { readonly host: string; readonly port: number }) => Promise<{ readonly ok: true; readonly fingerprint: string; readonly algorithm: string } | { readonly ok: false; readonly reason: SshFailure }>;
  readonly exec: (input: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly privateKey: string;
    readonly hostKeySha256: string;
    readonly command: string;
    readonly stdin: string;
  }) => Promise<SshExecOutcome>;
};

/** `promise`, or `fallback` once `ms` passes first. */
function withDeadline<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const sha256Base64 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64');
const fingerprintOf = (key: Buffer) => sshFingerprintOf({ publicKeyBlob: new Uint8Array(key), sha256Base64 });

/** An OpenSSH ed25519 key pair generated in the plane (the private half never leaves it). */
export function generateSshKeyPair(comment: string): { readonly privateKey: string; readonly publicKey: string } {
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

export function createSshClient({
  resolveHost,
  isPublic,
  limits = DEFAULT_SSH_LIMITS,
}: {
  readonly resolveHost: (host: string) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;
  readonly isPublic: (address: string) => boolean;
  readonly limits?: SshLimits;
}): SshClient {
  async function addressOf(host: string): Promise<{ readonly ok: true; readonly address: string } | { readonly ok: false; readonly reason: SshFailure }> {
    const answers = await resolveHost(host).catch(() => null);
    if (answers === null || answers.length === 0) return { ok: false, reason: 'unresolvable' };
    if (!answers.every((answer) => isPublic(answer.address))) return { ok: false, reason: 'address_refused' };
    return { ok: true, address: answers[0]!.address };
  }

  return {
    async hostKey({ host, port }) {
      // The whole probe — DNS included — fits one deadline.
      const startedAt = Date.now();
      const budget = limits.connectTimeoutMs + 1_000;
      const resolved = await withDeadline(addressOf(host), budget, { ok: false, reason: 'timeout' } as const);
      if (!resolved.ok) return resolved;
      const left = budget - (Date.now() - startedAt);
      if (left <= 0) return { ok: false, reason: 'timeout' };
      return new Promise((resolve) => {
        const client = new Client();
        let settled = false;
        const done = (value: Awaited<ReturnType<SshClient['hostKey']>>) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          client.end();
          resolve(value);
        };
        // A server that sends a banner and closes before key exchange emits no error: the deadline and `close` settle it.
        const deadline = setTimeout(() => done({ ok: false, reason: 'timeout' }), left);
        client.on('error', () => done({ ok: false, reason: 'unreachable' }));
        client.on('close', () => done({ ok: false, reason: 'unreachable' }));
        client.connect({
          host: resolved.address,
          port,
          username: 'pagespace-hostkey-probe',
          readyTimeout: limits.connectTimeoutMs,
          // Capture the key and stop: this probe never authenticates.
          hostVerifier: (key: Buffer) => {
            const parsed = utils.parseKey(key);
            const algorithm = parsed instanceof Error ? 'unknown' : (Array.isArray(parsed) ? parsed[0]?.type : parsed.type) ?? 'unknown';
            done({ ok: true, fingerprint: fingerprintOf(key), algorithm });
            return false;
          },
        });
      });
    },

    async exec({ host, port, username, privateKey, hostKeySha256, command, stdin }) {
      const startedAt = Date.now();
      const resolved = await withDeadline(addressOf(host), limits.totalTimeoutMs, { ok: false, reason: 'timeout' } as const);
      if (!resolved.ok) return { kind: 'failed', reason: resolved.reason, sent: false };
      const left = limits.totalTimeoutMs - (Date.now() - startedAt);
      if (left <= 0) return { kind: 'failed', reason: 'timeout', sent: false };
      return new Promise<SshExecOutcome>((resolve) => {
        const client = new Client();
        let settled = false;
        let sent = false;
        let keyMismatch = false;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = (value: SshExecOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          // A timed-out command's server may never close: tear the socket down instead of half-closing it.
          if (value.kind === 'failed' && value.reason === 'timeout') client.destroy();
          else client.end();
          resolve(value);
        };
        const deadline = setTimeout(() => done({ kind: 'failed', reason: 'timeout', sent }), left);
        const collect = (into: Buffer[]) => (chunk: Buffer) => {
          if (size >= limits.maxOutputBytes) {
            truncated = true;
            return;
          }
          const room = limits.maxOutputBytes - size;
          const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
          if (kept.byteLength < chunk.byteLength) truncated = true;
          size += kept.byteLength;
          into.push(Buffer.from(kept));
        };
        client
          .on('ready', () => {
            sent = true;
            client.exec(command, (error, stream) => {
              if (error) return done({ kind: 'failed', reason: 'unreachable', sent });
              stream.on('data', collect(stdout));
              stream.stderr.on('data', collect(stderr));
              stream.on('close', (code: number | null, signal: string | null) =>
                done({ kind: 'exited', exitCode: typeof code === 'number' ? code : null, signal: signal ?? null, stdout: new Uint8Array(Buffer.concat(stdout)), stderr: new Uint8Array(Buffer.concat(stderr)), truncated }),
              );
              stream.end(stdin);
            });
          })
          .on('close', () => done({ kind: 'failed', reason: keyMismatch ? 'host_key_mismatch' : 'unreachable', sent }))
          .on('error', (error: Error & { level?: string }) => {
            if (keyMismatch) return done({ kind: 'failed', reason: 'host_key_mismatch', sent: false });
            done({ kind: 'failed', reason: error.level === 'client-authentication' ? 'auth_failed' : 'unreachable', sent });
          });
        client.connect({
          host: resolved.address,
          port,
          username,
          privateKey,
          readyTimeout: limits.connectTimeoutMs,
          agentForward: false,
          tryKeyboard: false,
          hostVerifier: (key: Buffer) => {
            const matches = fingerprintOf(key) === hostKeySha256;
            if (!matches) keyMismatch = true;
            return matches;
          },
        });
      });
    },
  };
}
