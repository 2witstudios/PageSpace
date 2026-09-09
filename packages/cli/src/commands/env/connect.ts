/**
 * `pagespace env connect <enrollmentId>` — the bridge daemon: the machine end
 * of a local Environment (Local Environments epic, M1 · t08). Runs until
 * Ctrl-C, `pagespace env disconnect`, or a server-signed revoke.
 *
 * This file is argv parsing, wiring and rendering. Every decision is made in
 * `@pagespace/lib/env-bridge/*` through `env-bridge/dispatcher.ts`; the
 * socket lifecycle is `env-bridge/ws-client.ts`; the only process-spawning
 * code is `env-bridge/exec-runner.ts`. What is decided HERE, before anything
 * connects:
 *
 *  - the machine credential must exist and be fully enrolled (a pending
 *    record from an interrupted `env enroll` is not enrolled);
 *  - the policy file is loaded once and its status printed — missing or
 *    untrusted ⇒ the daemon still starts, advertises, and denies everything
 *    (`no_policy`), never crashes (invariant 5);
 *  - `ask` mode needs a terminal to ask on: headless + `ask` refuses to
 *    start rather than silently deny or silently allow.
 *
 * AUTH-EXEMPT (`run.ts`): a machine has no login; its key is its credential.
 * Long-running (`routes.ts`): the handler resolves once the first connect is
 * under way and the process lives on the socket; exits go through `exit`.
 */
import * as clack from '@clack/prompts';
import { appendFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { homedir as osHomedir, userInfo } from 'node:os';
import { dirname } from 'node:path';
import WebSocket from 'ws';
import { decodeBase64 } from '../../env-bridge/lib-core.js';
import type { PathProbe } from '../../env-bridge/lib-core.js';
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { machineProfileName } from '../../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { signWithMachineKey, type SignWithMachineKey } from '../../env-bridge/keypair.js';
import { ed25519Verify, envBridgeHash } from '../../env-bridge/crypto.js';
import { createAuditLog, defaultAuditPath } from '../../env-bridge/audit-log.js';
import { createAskPrompter, describeScope, describeSubject } from '../../env-bridge/ask.js';
import { createApprovalsStore, defaultApprovalsPath, writeApprovalsFile } from '../../env-bridge/approvals-store.js';
import { resolveCommand, type CommandResolverDeps } from '../../env-bridge/command-resolver.js';
import { APPROVAL_SCOPES, type ApprovalScope } from '../../env-bridge/lib-core.js';
import { createDispatcher, DAEMON_CAPABILITIES } from '../../env-bridge/dispatcher.js';
import { createNodeExecRunner, type ExecRunner } from '../../env-bridge/exec-runner.js';
import { createFsRunner, type FsRunner } from '../../env-bridge/fs-runner.js';
import { createDaemonNonceStore } from '../../env-bridge/nonce-store.js';
import { createPathProbe } from '../../env-bridge/path-probe.js';
import { defaultPolicyPath, describePolicyRefusal, loadMachinePolicy, openPolicyFile, type OpenedPolicyFile, describePrincipalsWarning } from '../../env-bridge/policy.js';
import { signHello } from '../../env-bridge/result-signer.js';
import { mintBridgeToken } from '../../env-bridge/token.js';
import { assertSecureHost, bridgeSocketUrl } from '../../env-bridge/secure-host.js';
import { createBridgeConnection, DEFAULT_BACKOFF, DEFAULT_FRAME_LIMITS, DEFAULT_IDLE_TIMEOUT_MS, type BridgeConnection, type SocketFactory } from '../../env-bridge/ws-client.js';
import { isEnrolledMachineCredential, resolveHostFor } from '../env.js';

type Fetch = typeof globalThis.fetch;

/** The daemon's process identity, stored beside the pid so `env disconnect` can refuse a reused pid (never signal a stranger). */
export interface PidRecord {
  readonly pid: number;
  /** ms since epoch; the record is re-written on a heartbeat so a stale file is detectable by age. */
  readonly startedAt: number;
  /** argv0 identity — a bare pid file left by some other tool is not ours. */
  readonly argv0: string;
}

export interface PidFileStore {
  write(path: string, record: PidRecord): Promise<void>;
  remove(path: string): Promise<void>;
}

/** How often the pid record is refreshed while the daemon lives; `env disconnect` treats a record older than PID_STALE_MS as dead. */
export const PID_HEARTBEAT_MS = 30_000;

/** Everything `env connect` needs from the outside world, injected so the daemon is unit-testable end to end. */
export interface EnvConnectHandlerDeps {
  readonly createCredentialStore: () => CredentialStore;
  readonly fetch: Fetch;
  readonly sign: SignWithMachineKey;
  readonly now: () => number;
  readonly homedir: string;
  readonly uid: number;
  readonly pid: number;
  readonly argv0: string;
  readonly platform: NodeJS.Platform | string;
  readonly openPolicy: (path: string) => OpenedPolicyFile | null;
  readonly appendAuditLine: (path: string, line: string) => Promise<void>;
  readonly pidFile: PidFileStore;
  readonly probe: PathProbe;
  readonly createExecRunner: (resolver: CommandResolverDeps) => ExecRunner;
  readonly createFsRunner: () => FsRunner;
  readonly createSocket: SocketFactory;
  readonly confirm: (message: string) => Promise<boolean>;
  /** How long a terminal approval is remembered (GA wave 2); omitted ⇒ the default scope. */
  readonly chooseScope?: (subjects: readonly string[]) => Promise<ApprovalScope>;
  /** The atomic 0600 writer for `~/.pagespace/env-approvals.json`. */
  readonly writeApprovals: (path: string, content: string) => Promise<void>;
  /** Id for an approval the terminal prompt writes. */
  readonly approvalId: () => string;
  /** Register a handler for SIGINT / SIGTERM. */
  readonly onSignal: (handler: (signal: string) => void) => void;
  readonly exit: (code: number) => void;
  /** Test hook: observe the live connection and runner. */
  readonly onStarted?: (controls: { connection: BridgeConnection; execRunner: ExecRunner }) => void;
}

export function pidFilePath(homedir: string, enrollmentId: string): string {
  return `${homedir}/.pagespace/env-connect.${enrollmentId}.pid`;
}

export function createEnvConnectHandler(deps: EnvConnectHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const [enrollmentId] = intent.args;
    if (!enrollmentId) {
      ctx.stderr.write('Usage: pagespace env connect <enrollmentId> [--host <url>]\n');
      return EXIT_USAGE_ERROR;
    }
    if (deps.platform === 'win32') {
      ctx.stderr.write('Windows is not supported by the bridge daemon yet: it relies on POSIX process groups to kill a timed-out command and on O_NOFOLLOW to open files safely, neither of which Windows provides. Run env connect on macOS or Linux.\n');
      return EXIT_RUNTIME_ERROR;
    }
    let host: string;
    try {
      host = assertSecureHost(resolveHostFor(ctx, intent.flags));
    } catch (error) {
      ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const store = deps.createCredentialStore();
    const profile = machineProfileName(enrollmentId);
    const credential = await store.get(host, profile);
    if (!isEnrolledMachineCredential(credential)) {
      ctx.stderr.write(`No machine credential for enrollment ${enrollmentId} on ${host}. Run "pagespace env enroll <enrollmentId> <code>" first.\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const serverPublicKey = decodeBase64(credential.serverPublicKey);
    if (serverPublicKey === null) {
      ctx.stderr.write(`The pinned server key for enrollment ${enrollmentId} is unreadable; re-enroll this machine.\n`);
      return EXIT_RUNTIME_ERROR;
    }

    // Policy: loaded once; its absence is a running daemon that denies everything.
    const policyPath = defaultPolicyPath(ctx.env, deps.homedir);
    const loaded = loadMachinePolicy({ path: policyPath, uid: deps.uid, open: deps.openPolicy });
    if (loaded.policy === null) {
      ctx.stderr.write(`${describePolicyRefusal(loaded.reason ?? 'missing', policyPath)}\n`);
    } else {
      ctx.stderr.write(`Policy ${policyPath}: mode ${loaded.policy.mode}, principals ${loaded.policy.principals.join(', ') || '(none)'}, ops ${loaded.policy.ops.join(', ') || '(none)'}, roots ${loaded.policy.roots.join(', ')}\n`);
      const principalsWarning = describePrincipalsWarning(loaded.policy);
      if (principalsWarning) ctx.stderr.write(`${principalsWarning}\n`);
      if (loaded.policy.mode === 'ask' && !ctx.isTTY) {
        ctx.stderr.write('Policy mode "ask" needs an interactive terminal to ask on, and there is none (stdin is not a TTY). Use mode "allowlist" or "deny" for a headless machine, or run env connect in a terminal.\n');
        return EXIT_RUNTIME_ERROR;
      }
    }

    const log = (line: string) => ctx.stderr.write(`[env connect] ${line}\n`);
    const auditPath = defaultAuditPath(ctx.env, deps.homedir);
    const audit = createAuditLog({ appendLine: (line) => deps.appendAuditLine(auditPath, line), now: deps.now, onError: log });
    const resolver: CommandResolverDeps = {
      platform: deps.platform,
      env: ctx.env,
      isExecutableFile: (path) => isExecutable(path),
      isDirectory: (path) => isDirectory(path),
      listDir: (path) => listDir(path),
    };
    const execRunner = deps.createExecRunner(resolver);
    const fsRunner = deps.createFsRunner();
    const ask = loaded.policy?.mode === 'ask' && ctx.isTTY ? createAskPrompter({ confirm: deps.confirm, chooseScope: deps.chooseScope, write: (chunk) => ctx.stderr.write(chunk) }) : null;

    // Durable approvals (GA wave 2): the machine's own file, through the same
    // one-descriptor adapter and trust rules as the policy. Re-read at every
    // decision; written only after an owner's byte-compared approval.
    const approvalsPath = defaultApprovalsPath(ctx.env, deps.homedir);
    const approvals = createApprovalsStore({ path: approvalsPath, uid: deps.uid, open: deps.openPolicy, write: deps.writeApprovals, now: deps.now, log });
    const approvalsLoaded = approvals.reload();
    ctx.stderr.write(
      approvalsLoaded.reason === null || approvalsLoaded.reason === 'missing'
        ? `Approvals ${approvalsPath}: ${approvalsLoaded.approvals.length} in force.\n`
        : `Approvals ${approvalsPath}: ignored (${approvalsLoaded.reason}) — every non-pre-approved request will ask.\n`,
    );

    const dispatcher = createDispatcher({
      envId: credential.envId,
      enrollmentId: credential.enrollmentId,
      serverKeyId: credential.serverKeyId,
      serverPublicKey,
      privateKey: credential.privateKey,
      sign: deps.sign,
      verify: ed25519Verify,
      hash: envBridgeHash,
      now: deps.now,
      startedAt: deps.now(),
      nonces: createDaemonNonceStore(),
      policy: () => loaded.policy,
      probe: deps.probe,
      execRunner,
      fsRunner,
      audit,
      ask,
      approvals,
      resolveArgv0: (name) => resolveCommand(name, resolver),
      ids: { approvalId: deps.approvalId },
      log,
      limits: DEFAULT_FRAME_LIMITS,
    });

    const pidPath = pidFilePath(deps.homedir, enrollmentId);
    let exiting = false;
    // A pid write that a heartbeat tick already started; shutdown awaits it
    // before removing the file, so an in-flight write can never recreate a
    // stale pid file after disconnect.
    let inFlightPidWrite: Promise<void> = Promise.resolve();
    let stopHeartbeat = () => undefined as void;
    const shutdown = async (code: number, why: string) => {
      if (exiting) return;
      exiting = true;
      stopHeartbeat();
      connection.stop(why);
      execRunner.killAll();
      await inFlightPidWrite.catch(() => undefined);
      await deps.pidFile.remove(pidPath).catch(() => undefined);
      deps.exit(code);
    };

    const connection = createBridgeConnection({
      url: bridgeSocketUrl(host, credential.envId),
      mintToken: async () => (await mintBridgeToken({ host, credential, fetch: deps.fetch, sign: deps.sign })).token,
      hello: () => signHello({ type: 'hello', envId: credential.envId, capabilities: DAEMON_CAPABILITIES, policyDigest: loaded.digest }, { privateKey: credential.privateKey, sign: deps.sign }),
      dispatcher,
      audit,
      createSocket: deps.createSocket,
      deleteKey: () => store.delete(host, profile),
      onSuperseded: () => {
        ctx.stderr.write(`Another daemon took over this environment (${credential.envId}); this one stops. Run "pagespace env disconnect ${enrollmentId}" on the other machine first if that was not intended.\n`);
        void shutdown(EXIT_RUNTIME_ERROR, 'superseded');
      },
      onRevoked: () => {
        ctx.stderr.write(`This machine's enrollment ${enrollmentId} was REVOKED by the server. The machine key has been deleted from the credential store; re-enroll to connect again.\n`);
        void shutdown(EXIT_RUNTIME_ERROR, 'revoked');
      },
      log,
      limits: DEFAULT_FRAME_LIMITS,
      backoff: DEFAULT_BACKOFF,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    });

    deps.onSignal((signal) => {
      ctx.stderr.write(`\n${signal}: disconnecting.\n`);
      void shutdown(EXIT_SUCCESS, signal);
    });

    const pidRecord: PidRecord = { pid: deps.pid, startedAt: deps.now(), argv0: deps.argv0 };
    const writePid = (): Promise<void> => {
      if (exiting) return Promise.resolve();
      inFlightPidWrite = deps.pidFile.write(pidPath, pidRecord).catch((error) => {
        log(`could not write ${pidPath} (env disconnect will not find this daemon): ${error instanceof Error ? error.message : String(error)}`);
      });
      return inFlightPidWrite;
    };
    await writePid();
    // Refresh the record so its age proves the daemon is still alive (a crashed
    // daemon's file goes stale and env disconnect refuses to signal its pid).
    const pidTimer = setInterval(() => void writePid(), PID_HEARTBEAT_MS);
    if (typeof pidTimer.unref === 'function') pidTimer.unref();
    stopHeartbeat = () => clearInterval(pidTimer);

    ctx.stderr.write(`Connecting environment ${credential.envId} (enrollment ${enrollmentId}) to ${host}. Audit log: ${auditPath}. Ctrl-C to disconnect.\n`);
    connection.start();
    deps.onStarted?.({ connection, execRunner });
    return EXIT_SUCCESS;
  };
}

// ---- production bindings ----------------------------------------------------

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path: string): readonly string[] {
  return readdirSync(path);
}

export const nodePidFile: PidFileStore = {
  async write(path, record) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  },
  async remove(path) {
    await unlink(path);
  },
};

async function appendAuditLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, line, { mode: 0o600 });
}

async function clackConfirm(message: string): Promise<boolean> {
  const answer = await clack.confirm({ message, initialValue: false });
  return answer === true;
}

/** The scope picker after an approval; Ctrl-C here is a decline (the prompter treats a throw as one). */
async function clackChooseScope(subjects: readonly string[]): Promise<ApprovalScope> {
  const answer = await clack.select<ApprovalScope>({
    message: `Remember this approval of ${subjects.map(describeSubject).join(', ')} for how long?`,
    initialValue: '30d',
    options: APPROVAL_SCOPES.map((scope) => ({ value: scope, label: describeScope(scope) })),
  });
  if (clack.isCancel(answer)) throw new Error('cancelled');
  return answer;
}

export const envConnectHandler: CommandHandler = createEnvConnectHandler({
  createCredentialStore,
  fetch: (...args) => globalThis.fetch(...args),
  sign: signWithMachineKey,
  now: Date.now,
  homedir: osHomedir(),
  uid: userInfo().uid,
  pid: process.pid,
  argv0: 'pagespace',
  platform: process.platform,
  openPolicy: openPolicyFile,
  appendAuditLine,
  pidFile: nodePidFile,
  probe: createPathProbe(),
  createExecRunner: createNodeExecRunner,
  createFsRunner: () => createFsRunner(),
  createSocket: (url, headers) => new WebSocket(url, { headers }),
  confirm: clackConfirm,
  chooseScope: clackChooseScope,
  writeApprovals: writeApprovalsFile,
  approvalId: () => `local_${crypto.randomUUID()}`,
  onSignal: (handler) => {
    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  },
  exit: (code) => process.exit(code),
});

