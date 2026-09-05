/**
 * `pagespace env enroll <enrollmentId> <code>` and `pagespace env token <enrollmentId>`
 * — this machine's side of the local-environment bridge identity (Local
 * Environments epic, invariant 2: machine-held identity; transport tokens by
 * proof of possession, never a stored secret).
 *
 * `enroll`: generates an Ed25519 keypair HERE, presents the one-time code the
 * user was shown in PageSpace together with the PUBLIC half, and — only on
 * success — stores the private half plus the server's pinned signing key in
 * the credential store (keychain, 0600 file fallback) under the profile
 * `env:<enrollmentId>`. A refused enrollment discards the generated key. The
 * private key is never printed and never sent.
 *
 * `token`: asks the server for a nonce, signs the server's canonical challenge
 * bytes with the stored private key, and redeems the signature for a
 * short-lived `env:bridge` socket token. This is what `env connect` will do
 * on every (re)connect; standalone it is the end-to-end proof that a pinned
 * key works.
 *
 * Both are AUTH-EXEMPT (`run.ts`): a machine has no login — the code, then
 * the key, are its credentials. `--host` / PAGESPACE_API_URL choose the
 * deployment, exactly as `login` does.
 */
import { resolveConfig } from '../config/resolve.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { machineProfileName, type MachineHostCredential } from '../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { encodeChallenge, generateMachineKeypair, signWithMachineKey } from '../env-bridge/keypair.js';
import type { GenerateMachineKeypair, SignWithMachineKey } from '../env-bridge/keypair.js';

type Fetch = typeof globalThis.fetch;

export interface EnvEnrollHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly generateKeypair: GenerateMachineKeypair;
  readonly fetch: Fetch;
  readonly now: () => number;
}

export interface EnvTokenHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly sign: SignWithMachineKey;
  readonly fetch: Fetch;
  readonly now: () => number;
}

function hostFor(ctx: Parameters<CommandHandler>[0], flags: { host?: string }): string {
  return resolveConfig({ flags: { host: flags.host }, env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL }, credential: null }).host;
}

/** The server's refusal, as a one-line reason the user can act on; never the raw body. */
async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { reason?: unknown; error?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  return `${reason} (HTTP ${response.status})`;
}

async function postJson(fetch: Fetch, url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
}

export function createEnvEnrollHandler(deps: EnvEnrollHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [, , enrollmentId, code] = intent.args;
    if (!enrollmentId || !code) {
      ctx.stderr.write('Usage: pagespace env enroll <enrollmentId> <code> [--host <url>] [--json]\n');
      return EXIT_USAGE_ERROR;
    }
    const host = hostFor(ctx, intent.flags);

    const pair = deps.generateKeypair();
    const response = await postJson(deps.fetch, `${host}/api/env-bridge/enroll`, { enrollmentId, code, machinePublicKey: pair.publicKey });
    if (!response.ok) {
      // The key never existed as far as anyone else is concerned.
      ctx.stderr.write(`Enrollment refused: ${await refusal(response)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const result = (await response.json()) as { enrollmentId: string; envId: string; serverKeyId: string; serverPublicKey: string };

    const credential: MachineHostCredential = {
      kind: 'machine',
      privateKey: pair.privateKey,
      enrollmentId: result.enrollmentId,
      envId: result.envId,
      serverPublicKey: result.serverPublicKey,
      serverKeyId: result.serverKeyId,
      scopes: [],
      createdAt: new Date(deps.now()).toISOString(),
    };
    await deps.createCredentialStore().set(host, credential, machineProfileName(result.enrollmentId));

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ enrollmentId: result.enrollmentId, envId: result.envId, serverKeyId: result.serverKeyId, host })}\n`);
    } else {
      ctx.stdout.write(
        `Enrolled this machine as environment ${result.envId} on ${host}.\n` +
          `Pinned server signing key ${result.serverKeyId}. The machine key stays in this machine's credential store (profile "${machineProfileName(result.enrollmentId)}").\n`,
      );
    }
    return EXIT_SUCCESS;
  };
}

export function createEnvTokenHandler(deps: EnvTokenHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [, , enrollmentId] = intent.args;
    if (!enrollmentId) {
      ctx.stderr.write('Usage: pagespace env token <enrollmentId> [--host <url>] [--json]\n');
      return EXIT_USAGE_ERROR;
    }
    const host = hostFor(ctx, intent.flags);

    const credential = await deps.createCredentialStore().get(host, machineProfileName(enrollmentId));
    if (!credential || credential.kind !== 'machine') {
      ctx.stderr.write(`No machine credential for enrollment ${enrollmentId} on ${host}. Run "pagespace env enroll <enrollmentId> <code>" first.\n`);
      return EXIT_RUNTIME_ERROR;
    }

    const challengeResponse = await deps.fetch(`${host}/api/env-bridge/token?enrollmentId=${encodeURIComponent(enrollmentId)}`, { headers: { accept: 'application/json' } });
    if (!challengeResponse.ok) {
      ctx.stderr.write(`Challenge refused: ${await refusal(challengeResponse)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const challenge = (await challengeResponse.json()) as { nonce: string; expiresAt: string };

    const signature = deps.sign(credential.privateKey, encodeChallenge({ nonce: challenge.nonce, enrollmentId, exp: Date.parse(challenge.expiresAt) }));
    const redeemResponse = await postJson(deps.fetch, `${host}/api/env-bridge/token`, { enrollmentId, nonce: challenge.nonce, signature });
    if (!redeemResponse.ok) {
      ctx.stderr.write(`Token refused: ${await refusal(redeemResponse)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const minted = (await redeemResponse.json()) as { token: string; expiresInMs: number; envId: string };

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ token: minted.token, expiresInMs: minted.expiresInMs, envId: minted.envId })}\n`);
    } else {
      ctx.stdout.write(`${minted.token}\n`);
      ctx.stderr.write(`Socket token for environment ${minted.envId}, valid ${Math.round(minted.expiresInMs / 1000)}s.\n`);
    }
    return EXIT_SUCCESS;
  };
}

export const envEnrollHandler: CommandHandler = createEnvEnrollHandler({
  createCredentialStore,
  generateKeypair: generateMachineKeypair,
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
});

export const envTokenHandler: CommandHandler = createEnvTokenHandler({
  createCredentialStore,
  sign: signWithMachineKey,
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
});
