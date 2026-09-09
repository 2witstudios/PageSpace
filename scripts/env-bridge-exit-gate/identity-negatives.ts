/**
 * The identity negatives of the M1 exit gate (Local Environments epic, t10) —
 * everything provable with HTTP, the real CLI binary and a real Ed25519 key,
 * with no daemon and no agent session.
 *
 * These are t10's own identity rows PLUS the ones carried over from t06, whose
 * real-client check was never run (it was deferred for a build slot and folded
 * into this gate). Nothing here is a synthetic probe of a pure function: every
 * row goes over the wire to a running app, and the CLI rows shell out to the
 * BUILT binary.
 *
 * Each check names the file whose behaviour it pins:
 *
 *   N01 code re-presented          → 409 `used`         apps/web/src/app/api/env-bridge/enroll/route.ts (STATUS_FOR_REASON)
 *   N02 wrong code                 → 401 `mismatch`     same (needs an UNCONSUMED enrollment:
 *                                                        the used/enrolled guards run first)
 *   N03 expired code               → 410 `expired`      same (needs an aged enrollment; see README)
 *   N04 signed nonce replayed      → 401 `used`         apps/web/src/app/api/env-bridge/token/route.ts POST → redeemLocalEnvChallenge
 *   N05 signature from another key → 401 `bad_signature` packages/lib/src/env-bridge/challenge.ts verifyChallengeResponse
 *   N06 bridge token at /api/auth/me → 401              the token is a `type:'mcp'` session with only `env:bridge`
 *   N07 bridge token at mcp-ws     → close 1008         apps/web/src/app/api/mcp-ws/route.ts (scope check)
 *   N08 `logout --key env:<id>`    → not logged in      packages/cli/src/commands/logout.ts + credential resolver
 *   N09 `keys use env:<id>`        → refused            packages/cli/src/commands/keys/
 *   N10 flag off, POST /envs local → 501                apps/web/src/app/api/drives/[driveId]/envs/route.ts:109
 *   N11 flag off, /api/env-bridge/*→ 404                enroll/route.ts:55, token/route.ts:72 and :96
 *
 * N10 and N11 need the app RESTARTED with `LOCAL_ENVS_ENABLED` unset, so they
 * run in their own pass: `PAGESPACE_GATE_FLAG=off bun … identity-negatives.ts`.
 *
 * Usage (flag ON pass):
 *   PAGESPACE_GATE_HOST=… PAGESPACE_GATE_CLI=… \
 *   PAGESPACE_GATE_ENROLLMENT_ID=… PAGESPACE_GATE_CODE=… PAGESPACE_GATE_TOKEN=… \
 *   bun scripts/env-bridge-exit-gate/identity-negatives.ts
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { expect, failed, optional, required, skip, summarize } from './report.ts';

const host = required('PAGESPACE_GATE_HOST');
const cliBin = required('PAGESPACE_GATE_CLI');
/** Where `dist/bin.js` lives ON THE MACHINE, when the CLI rows run there (`PAGESPACE_GATE_CLI_EXEC`). */
const machineCliBin = optional('PAGESPACE_GATE_MACHINE_CLI') ?? cliBin;
const flagOff = optional('PAGESPACE_GATE_FLAG') === 'off';

interface Answer {
  readonly code: number;
  readonly json: Record<string, unknown> | null;
}

async function call(path: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(`${host}${path}`, { redirect: 'manual', ...init });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code: response.status, json };
}

const postJson = (path: string, body: unknown): Promise<Answer> =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** `<status> <reason>` — the pair the task page names, so a right status with a wrong reason still fails. */
function outcome(answer: Answer): string {
  const reason = answer.json?.reason;
  return `${answer.code} ${typeof reason === 'string' ? reason : '(no reason)'}`;
}

/**
 * Run the built CLI and return its combined output plus exit code; a non-zero
 * exit is DATA here, not a throw.
 *
 * `PAGESPACE_GATE_CLI_EXEC` runs it ON THE MACHINE instead of on this host. It
 * is the whole command up to and including the node invocation — e.g.
 * `docker exec gate-machine node` when the enrolled machine is a container, or
 * `ssh someone@laptop node` when it is not this computer at all — and
 * `PAGESPACE_GATE_MACHINE_CLI` is where `dist/bin.js` lives over there.
 * N08/N09 are about
 * the MACHINE CREDENTIAL being kept out of the ordinary auth chain, and that
 * credential lives in the machine's own store: run them anywhere else and both
 * inspect an empty profile and pass because nothing is there — the same
 * vacuous-pass class Codex found in this harness at #2555. Set it whenever the
 * daemon does not run on the operator's own machine.
 */
function cli(args: readonly string[]): { code: number; out: string } {
  const prefix = optional('PAGESPACE_GATE_CLI_EXEC');
  const [command, ...lead] = prefix === null ? [process.execPath] : prefix.split(/\s+/);
  const argv = prefix === null ? [cliBin, ...args] : [...lead, machineCliBin, ...args];
  try {
    const out = execFileSync(command as string, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function flagOffPass(): Promise<number> {
  const driveId = required('PAGESPACE_GATE_DRIVE_ID');
  const cookie = required('PAGESPACE_GATE_COOKIE');
  // N10 — a drive owner asking for a local env on a deployment that has none.
  // 501, not 400: the request is well-formed, the deployment cannot serve it.
  //
  // "Well-formed" is doing real work in that sentence, and this row got it
  // wrong twice (found by running it, 2026-09-09):
  //
  //  - it is a WRITE, so it needs `X-CSRF-Token` and a matching `Origin`.
  //    Without them the route answers 403 at the door and the flag is never
  //    consulted — the same shape as the missing `--host` Codex found at
  //    #2555: a refusal that looks like the one you wanted and proves nothing.
  //  - since GA wave 1 a local env cannot be created without a `serverPolicy`
  //    (the owner must say what PageSpace may ask of the machine), and that
  //    validation runs BEFORE the feature gate, so a body without one answers
  //    400 "A server policy … is required" — again never reaching the flag.
  //
  // Both make the row FAIL rather than pass vacuously, which is the harness
  // working; the fix is to send the request a real client would send.
  const csrf = await call('/api/auth/csrf', { headers: { cookie } });
  const csrfToken = typeof csrf.json?.csrfToken === 'string' ? csrf.json.csrfToken : '';
  const created = await call(`/api/drives/${driveId}/envs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrfToken, origin: host },
    body: JSON.stringify({ name: `gate-flag-off-${Date.now()}`, substrate: 'local', label: 'gate-flag-off', serverPolicy: { ops: ['fs_read'], checkpoint: false } }),
  });
  expect('N10', 501, created.code, 'POST /envs {substrate:"local"} with the flag off');

  // N11 — the bridge routes do not exist at all. 404 on all three entry points;
  // a 400 from any of them means the flag is still on somewhere.
  const enroll = await postJson('/api/env-bridge/enroll', { enrollmentId: 'x', code: 'x', machinePublicKey: 'x' });
  expect('N11a', 404, enroll.code, 'POST /api/env-bridge/enroll with the flag off');
  const challenge = await call('/api/env-bridge/token?enrollmentId=x');
  expect('N11b', 404, challenge.code, 'GET /api/env-bridge/token with the flag off');
  const redeem = await postJson('/api/env-bridge/token', { enrollmentId: 'x', nonce: 'x', signature: 'x' });
  expect('N11c', 404, redeem.code, 'POST /api/env-bridge/token with the flag off');
  return summarize('identity-negatives (flag off)');
}

async function main(): Promise<number> {
  if (flagOff) return flagOffPass();

  const enrollmentId = required('PAGESPACE_GATE_ENROLLMENT_ID');
  const usedCode = required('PAGESPACE_GATE_CODE'); // the code already spent by `pagespace env enroll`
  const bridgeToken = required('PAGESPACE_GATE_TOKEN'); // an `mcp_…` from `pagespace env token`

  // A throwaway key: enough to prove the SHAPE of a refusal without touching
  // the enrolled key, which never leaves the credential store.
  const stranger = generateKeyPairSync('ed25519');
  const strangerPublic = stranger.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  // N01 — the code was spent by the real enrollment. Re-presenting it with a
  // DIFFERENT public key is the interesting case: a second machine trying to
  // take over an enrolled env.
  const reused = await postJson('/api/env-bridge/enroll', { enrollmentId, code: usedCode, machinePublicKey: strangerPublic });
  expect('N01', '409 used', outcome(reused), 're-presenting a spent enrollment code');

  // N02 — a wrong code of the same shape. `mismatch`, never `not_found`: the
  // route must not distinguish a bad code from a bad enrollment id.
  //
  // This MUST use an enrollment nothing has consumed. `enrollLocalDriveEnv`
  // checks `enrolledAt`/`enrollmentCodeUsedAt` BEFORE it compares the code
  // (drive-envs.ts:310), so against the enrollment N01 just spent every answer
  // is `409 used` and the code-comparison branch is never reached — the gate
  // would look green while proving nothing. A `mismatch` consumes nothing, so
  // this env stays available afterwards.
  const freshEnrollmentId = optional('PAGESPACE_GATE_FRESH_ENROLLMENT_ID');
  if (freshEnrollmentId !== null) {
    const wrong = await postJson('/api/env-bridge/enroll', { enrollmentId: freshEnrollmentId, code: '0'.repeat(usedCode.length), machinePublicKey: strangerPublic });
    expect('N02', '401 mismatch', outcome(wrong), 'a wrong code for an UNCONSUMED enrollment');
  } else {
    skip('N02', '401 mismatch', 'set PAGESPACE_GATE_FRESH_ENROLLMENT_ID to an enrolled-but-unused env — see README "N02"');
  }

  // N03 — an EXPIRED code, which needs a second env created >10 minutes before
  // this runs (or its `enrollmentCodeExpiresAt` moved back in SQL). Supplied
  // separately so the main enrollment is not held hostage to a ten-minute wait.
  const expiredId = optional('PAGESPACE_GATE_EXPIRED_ENROLLMENT_ID');
  const expiredCode = optional('PAGESPACE_GATE_EXPIRED_CODE');
  if (expiredId !== null && expiredCode !== null) {
    const expired = await postJson('/api/env-bridge/enroll', { enrollmentId: expiredId, code: expiredCode, machinePublicKey: strangerPublic });
    expect('N03', '410 expired', outcome(expired), 'an enrollment code past its ten-minute window');
  } else {
    skip('N03', '410 expired', 'set PAGESPACE_GATE_EXPIRED_ENROLLMENT_ID / _CODE — see README "N03"');
  }

  // N04 — replay, and it must come BEFORE N05 (see there). `pagespace env token`
  // has already spent a nonce; re-POSTing the same (nonce, signature) pair must
  // be refused as `used` while that nonce is still the stored one. The operator
  // captures that pair by running `env token` through the proxy (see
  // bridge-proxy.ts) or from the daemon's own audit; without it this is a SKIP
  // rather than a fabricated pass.
  const spentNonce = optional('PAGESPACE_GATE_SPENT_NONCE');
  const spentSignature = optional('PAGESPACE_GATE_SPENT_SIGNATURE');
  if (spentNonce !== null && spentSignature !== null) {
    const replayed = await postJson('/api/env-bridge/token', { enrollmentId, nonce: spentNonce, signature: spentSignature });
    expect('N04', '401 used', outcome(replayed), 'replaying a challenge response that already minted a token');
  } else {
    skip('N04', '401 used', 'set PAGESPACE_GATE_SPENT_NONCE / _SIGNATURE — see README "N04"');
  }

  // N05 — a challenge answered by a key the server never pinned. Runs LAST of
  // the challenge rows: `issueLocalEnvChallenge` REPLACES a consumed challenge
  // and clears `challengeUsedAt`, and `verifyChallengeResponse` compares the
  // nonce before it looks at `usedAt` — so issuing this challenge first would
  // turn N04's replay into `401 nonce_mismatch` instead of `401 used`. The
  // bad-signature POST below leaves this nonce pending and unconsumed, which is
  // why nothing after it asks for another challenge.
  const challengeForStranger = await call(`/api/env-bridge/token?enrollmentId=${encodeURIComponent(enrollmentId)}`);
  const strangerNonce = challengeForStranger.json?.nonce;
  const strangerExp = challengeForStranger.json?.expiresAt;
  if (typeof strangerNonce === 'string' && typeof strangerExp === 'string') {
    // Byte-for-byte what `encodeChallenge` produces
    // (packages/lib/src/env-bridge/challenge.ts:57) — key order included.
    const bytes = Buffer.from(JSON.stringify({ nonce: strangerNonce, enrollmentId, exp: new Date(strangerExp).getTime() }));
    // `generateKeyPairSync('ed25519')` with no encoding already returns
    // KeyObjects, and `createPrivateKey` REFUSES a PrivateKeyObject
    // (ERR_INVALID_ARG_TYPE) — so wrapping it threw before the row could run
    // and N05 never tested anything. Sign with the key object directly.
    const signature = nodeSign(null, bytes, stranger.privateKey).toString('base64');
    const forged = await postJson('/api/env-bridge/token', { enrollmentId, nonce: strangerNonce, signature });
    expect('N05', '401 bad_signature', outcome(forged), 'a valid signature made by a key this env never pinned');
  } else {
    failed('N05', '401 bad_signature', new Error(`challenge refused: ${outcome(challengeForStranger)}`), 'could not obtain a nonce to forge against');
  }

  // N06 — the bridge token is not a web session. `expectedType:'user'` at the
  // door refuses it whatever its scope says.
  const me = await call('/api/auth/me', { headers: { authorization: `Bearer ${bridgeToken}` } });
  expect('N06', 401, me.code, 'the env:bridge token presented to ordinary web auth');

  // N07 — and it is not an MCP token either: `env:bridge` is deliberately
  // outside `mcp:*`, so mcp-ws closes 1008 rather than serving tools.
  try {
    const { openClient } = await import('./ws-min.ts');
    const wsUrl = `${host.replace(/^http/, 'ws')}/api/mcp-ws`;
    const closed = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout: never closed'), 10_000);
      void openClient(wsUrl, { Authorization: `Bearer ${bridgeToken}` })
        .then((socket) => {
          socket.on('close', (code: number) => {
            clearTimeout(timer);
            resolve(String(code));
          });
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          // A refused UPGRADE is a different (also safe) refusal than a 1008
          // close, and saying which one happened is the point of this row.
          resolve(`upgrade refused: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
    expect('N07', '1008', closed, 'the env:bridge token presented to mcp-ws');
  } catch (error) {
    failed('N07', '1008', error, 'could not open a socket to mcp-ws');
  }

  // N08 / N09 — the machine credential is normalized out of the auth chain at
  // the door, so neither command can ever reach it.
  // `--host` is not optional here. Credentials are stored PER HOST, and the
  // runbook enrolls through the capture proxy, so without it both commands
  // inspect an empty profile on the default host and pass merely because
  // nothing is there — proving nothing about machine credentials being kept out
  // of the auth chain.
  const credentialHost = optional('PAGESPACE_GATE_CREDENTIAL_HOST') ?? host;
  const logout = cli(['logout', `--key=env:${enrollmentId}`, `--host=${credentialHost}`]);
  expect('N08', true, /not logged in/i.test(logout.out), `logout --key=env:<id> --host=${credentialHost} said: ${logout.out.trim().split('\n')[0] ?? '(silent)'}`);
  const use = cli(['keys', 'use', `env:${enrollmentId}`, `--host=${credentialHost}`]);
  expect('N09', true, use.code !== 0, `keys use env:<id> --host=${credentialHost} exited ${use.code}: ${use.out.trim().split('\n')[0] ?? '(silent)'}`);

  return summarize('identity-negatives (flag on)');
}

main().then((code) => process.exit(code));
