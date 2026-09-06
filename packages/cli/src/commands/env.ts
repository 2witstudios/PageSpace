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
import { machineProfileName, type HostCredential, type MachineHostCredential } from '../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { generateMachineKeypair, signWithMachineKey } from '../env-bridge/keypair.js';
import type { GenerateMachineKeypair, SignWithMachineKey } from '../env-bridge/keypair.js';
import { BridgeTokenError, mintBridgeToken, postJson, refusalOf } from '../env-bridge/token.js';

type Fetch = typeof globalThis.fetch;

/** Placeholder in a pending machine credential for what the server has not answered yet. */
const PENDING = 'pending';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** The deployment this machine talks to: `--host`, else PAGESPACE_API_URL, else the default — exactly as `login` resolves it. */
export function resolveHostFor(ctx: Parameters<CommandHandler>[0], flags: { host?: string }): string {
  return resolveConfig({ flags: { host: flags.host }, env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL }, credential: null }).host;
}

/**
 * A machine credential the server has actually pinned. A pending record
 * (enroll interrupted after the store write) is NOT enrolled: the server
 * never saw its key, so it can neither mint a token nor connect.
 */
export function isEnrolledMachineCredential(credential: HostCredential | null): credential is MachineHostCredential {
  return credential !== null && credential.kind === 'machine' && credential.serverKeyId !== PENDING;
}

export function createEnvEnrollHandler(deps: EnvEnrollHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [enrollmentId, code] = intent.args;
    if (!enrollmentId || !code) {
      ctx.stderr.write('Usage: pagespace env enroll <enrollmentId> <code> [--host <url>] [--json]\n');
      return EXIT_USAGE_ERROR;
    }
    const host = resolveHostFor(ctx, intent.flags);

    const pair = deps.generateKeypair();
    const store = deps.createCredentialStore();
    const profile = machineProfileName(enrollmentId);
    const createdAt = new Date(deps.now()).toISOString();

    // Persist the key BEFORE spending the code. The server consumes the code
    // and pins this public key on success; if the private half could not be
    // kept (keychain down, fallback file unwritable) the environment would be
    // stranded — enrolled to a key nobody holds. So prove the store is
    // writable first, with a pending record that carries the key and
    // placeholders for what the server has not said yet.
    const pending: MachineHostCredential = {
      kind: 'machine',
      privateKey: pair.privateKey,
      enrollmentId,
      envId: PENDING,
      serverPublicKey: PENDING,
      serverKeyId: PENDING,
      scopes: [],
      createdAt,
    };
    try {
      await store.set(host, pending, profile);
    } catch (error) {
      ctx.stderr.write(`Could not write this machine's credential store, so the enrollment code was not used: ${messageOf(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    const response = await postJson(deps.fetch, `${host}/api/env-bridge/enroll`, { enrollmentId, code, machinePublicKey: pair.publicKey });
    if (!response.ok) {
      // The key never existed as far as anyone else is concerned.
      await store.delete(host, profile).catch(() => undefined);
      ctx.stderr.write(`Enrollment refused: ${await refusalOf(response)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const result = (await response.json()) as { enrollmentId: string; envId: string; serverKeyId: string; serverPublicKey: string };

    const credential: MachineHostCredential = { ...pending, envId: result.envId, serverPublicKey: result.serverPublicKey, serverKeyId: result.serverKeyId };
    // (Codex C11) The code is spent and the server has pinned this key. The
    // pending record already proved the store writable moments ago, so a
    // failure here is transient far more often than not: retry once, and if
    // it still fails say exactly what state things are in and how to
    // recover — never the key.
    const saved = await storeWithOneRetry(store, host, credential, profile);
    if (!saved.ok) {
      ctx.stderr.write(
        `Enrolled on the server as environment ${result.envId}, but this machine's credential store refused the final write twice: ${saved.error}\n` +
          `The server has pinned this machine's key; a pending record under profile "${profile}" still holds it locally, but "env token" and "env connect" will not use a pending record.\n` +
          `To recover: make the credential store writable (keychain access, or a writable ~/.pagespace), then delete environment ${result.envId} in PageSpace, create a new local environment, and run "pagespace env enroll" again with its code.\n`,
      );
      return EXIT_RUNTIME_ERROR;
    }

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

async function storeWithOneRetry(store: CredentialStore, host: string, credential: MachineHostCredential, profile: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await store.set(host, credential, profile);
      return { ok: true };
    } catch (error) {
      lastError = messageOf(error);
    }
  }
  return { ok: false, error: lastError };
}

export function createEnvTokenHandler(deps: EnvTokenHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [enrollmentId] = intent.args;
    if (!enrollmentId) {
      ctx.stderr.write('Usage: pagespace env token <enrollmentId> [--host <url>] [--json]\n');
      return EXIT_USAGE_ERROR;
    }
    const host = resolveHostFor(ctx, intent.flags);

    const credential = await deps.createCredentialStore().get(host, machineProfileName(enrollmentId));
    if (!isEnrolledMachineCredential(credential)) {
      ctx.stderr.write(`No machine credential for enrollment ${enrollmentId} on ${host}. Run "pagespace env enroll <enrollmentId> <code>" first.\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let minted: Awaited<ReturnType<typeof mintBridgeToken>>;
    try {
      minted = await mintBridgeToken({ host, credential, fetch: deps.fetch, sign: deps.sign });
    } catch (error) {
      if (error instanceof BridgeTokenError) {
        ctx.stderr.write(`${error.message}\n`);
        return EXIT_RUNTIME_ERROR;
      }
      throw error;
    }

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
