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
import { homedir as osHomedir } from 'node:os';
import { resolveConfig } from '../config/resolve.js';
import { createCredentialStore } from '../credentials/store.js';
import type { CredentialStore } from '../credentials/store.js';
import { machineProfileName, type HostCredential, type MachineHostCredential } from '../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { generateMachineKeypair, signWithMachineKey } from '../env-bridge/keypair.js';
import type { GenerateMachineKeypair, SignWithMachineKey } from '../env-bridge/keypair.js';
import { BridgeTokenError, mintBridgeToken, postJson, refusalOf } from '../env-bridge/token.js';
import { defaultPolicyPath, describePolicyWarnings, openPolicyFile, parseMachinePolicyText, writePolicyFile, type OpenedPolicyFile } from '../env-bridge/policy.js';
import { GRANT_OPS, type GrantOp } from '../env-bridge/lib-core.js';

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
  /** For the policy scaffold (D-6): where `~/.pagespace/env-policy.json` lives … */
  readonly homedir: string;
  /** … the one root the scaffold names (where the owner ran `enroll`) … */
  readonly cwd: () => string;
  /** … whether a policy already exists (never overwritten) … */
  readonly openPolicy: (path: string) => OpenedPolicyFile | null;
  /** … and the 0600 write. */
  readonly writePolicyFile: (path: string, content: string) => Promise<void>;
}

/**
 * The ops the enroller may pre-approve on the machine: file operations only.
 * `exec` is NEVER in this set (GA wave 2, Tier B): a shell command must reach
 * the daemon's `ask` verdict by construction, so every exec class needs the
 * owner's click on the exact normalised command, however permissive the
 * server policy is. File operations inside the roots are Tier A — bounded by
 * the roots, so a deliberate setup is enough and they run headless.
 */
export const HEADLESS_MACHINE_OPS: readonly GrantOp[] = ['fs_read', 'fs_write'];

/**
 * The machine `ops` to scaffold from what the server said it allows:
 * `serverPolicy.ops ∩ HEADLESS_MACHINE_OPS`, in the headless set's order. The
 * value comes off the wire and is checked strictly — an unrecognised shape or
 * an op outside the closed union yields `[]` (ask about everything), never a
 * guess.
 */
export function machineOpsFromServerPolicy(serverPolicy: unknown): GrantOp[] {
  if (serverPolicy === null || typeof serverPolicy !== 'object') return [];
  const { ops, checkpoint } = serverPolicy as { ops?: unknown; checkpoint?: unknown };
  if (typeof checkpoint !== 'boolean') return [];
  if (!Array.isArray(ops) || !ops.every((op) => typeof op === 'string' && (GRANT_OPS as readonly string[]).includes(op))) return [];
  const allowed = ops as GrantOp[];
  return HEADLESS_MACHINE_OPS.filter((op) => allowed.includes(op));
}

/**
 * The policy scaffolded at enrol, while the owner is at the keyboard (D-6,
 * invariant 13 — defence in depth): `principals` is the machine's OWNER and
 * nobody else, so this daemon refuses every other user even if the server
 * were wrong about who may bind. `mode: ask` with the server-allowed FILE ops
 * pre-approved (never `exec`) means file work inside the root runs headless
 * and every command prompts; the only root is the directory `enroll` ran in.
 * The owner edits from there.
 */
export function scaffoldedPolicy(input: { ownerId: string; root: string; ops?: readonly GrantOp[] }): string {
  return `${JSON.stringify({ mode: 'ask', principals: [input.ownerId], ops: [...(input.ops ?? [])], roots: [input.root], envAllowlist: [] }, null, 2)}\n`;
}

/**
 * A minimal line diff for "here is what enroll would have written": lines
 * only in `existing` are `-`, lines only in `scaffold` are `+`, shared lines
 * are printed once with a leading space. Order follows the scaffold, then
 * the existing file's extras. Good enough to read; not a patch.
 */
export function describePolicyDiff(existing: string, scaffold: string): string {
  const before = existing.split('\n').filter((line) => line.length > 0);
  const after = scaffold.split('\n').filter((line) => line.length > 0);
  const lines: string[] = [];
  const remaining = [...before];
  for (const line of after) {
    const index = remaining.indexOf(line);
    if (index === -1) {
      lines.push(`+${line}`);
    } else {
      lines.push(` ${line}`);
      remaining.splice(index, 1);
    }
  }
  for (const line of remaining) lines.push(`-${line}`);
  return lines.join('\n');
}

type PolicyScaffoldOutcome = { path: string; scaffolded: boolean; kept: boolean; ops: readonly GrantOp[]; diff: string | null; warning: string | null; error: string | null };

/** Write the scaffold IFF no policy file exists; never touch an existing one, but say when it does not name the owner — and show the diff it would have written. */
async function scaffoldPolicyForOwner(deps: EnvEnrollHandlerDeps, env: Readonly<Record<string, string | undefined>>, ownerId: string, ops: readonly GrantOp[]): Promise<PolicyScaffoldOutcome> {
  const path = defaultPolicyPath(env, deps.homedir);
  let existing: OpenedPolicyFile | null;
  try {
    existing = deps.openPolicy(path);
  } catch (error) {
    // Unreadable is not "missing": leave whatever is there alone.
    return { path, scaffolded: false, kept: true, ops, diff: null, warning: null, error: `could not read the existing policy: ${messageOf(error)}` };
  }
  const content = scaffoldedPolicy({ ownerId, root: deps.cwd(), ops });
  if (existing !== null) {
    const parsed = parseMachinePolicyText(existing.content);
    const warning =
      parsed !== null && !parsed.principals.includes(ownerId)
        ? `The existing policy at ${path} does not name you (${ownerId}) in "principals", so requests from your own sessions will be denied principal_not_allowed until you add it.`
        : null;
    return { path, scaffolded: false, kept: true, ops, diff: describePolicyDiff(existing.content, content), warning, error: null };
  }
  // Never guess a root for someone's machine (Codex P2 on #2582): the scaffold
  // must be a policy `connect` will accept, so it is parsed with the same
  // strict parser before it is written. The filesystem root, a relative
  // directory, or one with `..` are all refused — and refused OUT LOUD.
  const root = deps.cwd();
  if (parseMachinePolicyText(content) === null) {
    return {
      path,
      scaffolded: false,
      kept: false,
      ops,
      diff: null,
      warning: null,
      error:
        `the directory you ran enroll in (${root}) is not a valid root — a root must be an absolute directory other than the filesystem root, without ".." segments — so nothing was written. ` +
        `Create ${path} yourself (chmod 600) with "principals": ["${ownerId}"] and "roots": ["<an absolute project directory>"], then run "pagespace env policy" to check it`,
    };
  }
  try {
    await deps.writePolicyFile(path, content);
    return { path, scaffolded: true, kept: false, ops, diff: null, warning: null, error: null };
  } catch (error) {
    return { path, scaffolded: false, kept: false, ops, diff: null, warning: null, error: messageOf(error) };
  }
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
    const result = (await response.json()) as { enrollmentId: string; envId: string; serverKeyId: string; serverPublicKey: string; ownerId?: string; serverPolicy?: unknown };

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

    // The key is pinned; from here on nothing can un-enrol. The policy
    // scaffold (D-6) is best-effort and reported, never a reason to fail.
    const ownerId = typeof result.ownerId === 'string' && result.ownerId.length > 0 ? result.ownerId : null;
    // Tier A: the FILE ops the server allows run headless from the start. Tier
    // B: `exec` is never pre-approved here, so every command reaches `ask`.
    const ops = machineOpsFromServerPolicy(result.serverPolicy);
    const policy = ownerId === null ? null : await scaffoldPolicyForOwner(deps, ctx.env, ownerId, ops);

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ enrollmentId: result.enrollmentId, envId: result.envId, serverKeyId: result.serverKeyId, host, ownerId, policy: policy && { path: policy.path, scaffolded: policy.scaffolded, kept: policy.kept, ops: policy.ops } })}\n`);
    } else {
      ctx.stdout.write(
        `Enrolled this machine as environment ${result.envId} on ${host}.\n` +
          `Pinned server signing key ${result.serverKeyId}. The machine key stays in this machine's credential store (profile "${machineProfileName(result.enrollmentId)}").\n`,
      );
      if (policy?.scaffolded) {
        const headless = policy.ops.length > 0 ? `pre-approved ops ${policy.ops.join(', ')} (file work inside the root runs without asking)` : 'no pre-approved ops';
        ctx.stdout.write(
          `Wrote a starter policy to ${policy.path}: principals [${ownerId}] (you, and nobody else — a machine is driven by its owner only), mode ask, ${headless}, root ${deps.cwd()}. ` +
            'Commands (exec) are never pre-approved by enroll: each program needs your approval the first time, in the chat or in this terminal. Edit the file to allow more; "pagespace env policy" shows what is in force.\n',
        );
      } else if (policy?.kept) {
        ctx.stdout.write(`Kept the existing policy at ${policy.path}.\n`);
        if (policy.diff !== null) ctx.stdout.write(`Enroll would have written (- existing, + scaffold):\n${policy.diff}\n`);
      }
    }
    // A6: the scaffolded root is the directory `enroll` ran in, so enrolling
    // from $HOME scopes an agent to ~/.ssh and every project at once. Say it
    // HERE — this is the one moment the owner is at the keyboard and can still
    // choose differently — in the same words `connect` and `policy` use.
    if (policy?.scaffolded === true) {
      const scaffolded = parseMachinePolicyText(scaffoldedPolicy({ ownerId: ownerId ?? '', root: deps.cwd(), ops: policy.ops }));
      if (scaffolded !== null) {
        for (const warning of describePolicyWarnings(scaffolded, { homedir: deps.homedir })) ctx.stderr.write(`${warning.message}\n`);
      }
    }
    if (ownerId === null) ctx.stderr.write('The server did not say who the owner of this environment is, so no policy was scaffolded; create ~/.pagespace/env-policy.json yourself with "principals": [<your user id>].\n');
    if (policy?.warning) ctx.stderr.write(`${policy.warning}\n`);
    if (policy?.error) {
      // The enrollment stands (the key is pinned); the SCAFFOLD step failed,
      // and a step that failed exits non-zero so a script notices.
      ctx.stderr.write(`Enrolled, but no starter policy was written to ${policy.path}: ${policy.error}.\n`);
      return EXIT_RUNTIME_ERROR;
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
  homedir: osHomedir(),
  cwd: () => process.cwd(),
  openPolicy: openPolicyFile,
  writePolicyFile,
});

export const envTokenHandler: CommandHandler = createEnvTokenHandler({
  createCredentialStore,
  sign: signWithMachineKey,
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
});
