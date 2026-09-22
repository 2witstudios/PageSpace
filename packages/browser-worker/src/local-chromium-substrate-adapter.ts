/**
 * The LOCAL substrate: one worker process per session on this host, each
 * driving its own Chromium over a pipe. For development, tests and the
 * onprem path (S3 Option 3's worker, without the per-session network pair).
 *
 * Isolation here is a separate OS process with its own 0700 profile under
 * the worker's temp root and a loopback-only control port that obeys only
 * signed instructions; it is NOT a VM boundary. An agent sandbox on the same
 * host is the local substrate's weaker case, stated rather than hidden:
 * production browser sessions run on a VM substrate (Sprites) instead.
 *
 * The worker gets a minimal environment — never this server's own — so no
 * server secret reaches the process that renders untrusted pages.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { BrowserSessionShape, BrowserSessionSpec, BrowserSubstrate, ProvisionedBrowserSession, WorkerRequest, WorkerResponse } from './browser-substrate.js';

export type LocalWorkerProcess = {
  readonly url: string;
  readonly stop: () => Promise<void>;
};

export type LocalChromiumSubstrateOptions = {
  /** Starts one worker for a session. Defaults to spawning the built entry point. */
  readonly launch?: (spec: BrowserSessionSpec) => Promise<LocalWorkerProcess>;
  /** Path of `standalone-browser-worker.js`; defaults to the sibling in this package's dist. */
  readonly entryPath?: string;
  /** The Chromium executable the workers launch; `undefined` uses Playwright's own browser cache. */
  readonly executablePath?: string;
  readonly shape?: BrowserSessionShape;
  readonly clock?: () => number;
};

const STARTUP_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
/** The only variables a worker inherits: enough to find node, the browser cache and a temp dir. */
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH'] as const;

const spawnWorker = (entryPath: string, executablePath: string | undefined, spec: BrowserSessionSpec): Promise<LocalWorkerProcess> =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      BROWSER_SESSION_ID: spec.sessionId,
      BROWSER_CONTROL_PUBLIC_KEY: spec.controlPublicKey,
      BROWSER_WORKER_HOST: '127.0.0.1',
      BROWSER_WORKER_PORT: '0',
    };
    if (spec.allowedOrigins !== null) env.BROWSER_ALLOWED_ORIGINS = JSON.stringify(spec.allowedOrigins);
    if (executablePath !== undefined) env.BROWSER_EXECUTABLE_PATH = executablePath;
    for (const name of INHERITED_ENV) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const child = spawn(process.execPath, [entryPath], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('browser worker did not start in time'));
    }, STARTUP_TIMEOUT_MS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`browser worker exited during startup (${code})`));
    });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      clearTimeout(timer);
      const url = (JSON.parse(line) as { listening?: unknown }).listening;
      if (typeof url !== 'string') {
        child.kill('SIGKILL');
        reject(new Error('browser worker announced no address'));
        return;
      }
      resolve({
        url,
        stop: async () => {
          if (child.exitCode !== null) return;
          child.kill('SIGTERM');
          const forced = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
          await exited;
          clearTimeout(forced);
        },
      });
    });
  });

const sendTo = async (baseUrl: string, request: WorkerRequest): Promise<WorkerResponse> => {
  const response = await fetch(`${baseUrl}${request.path}`, { method: request.method, headers: request.headers, body: request.body });
  return { status: response.status, body: await response.text() };
};

export const createLocalChromiumSubstrate = ({
  launch,
  entryPath = fileURLToPath(new URL('./standalone-browser-worker.js', import.meta.url)),
  executablePath,
  shape = { cpus: 1, memoryGB: 1 },
  clock = Date.now,
}: LocalChromiumSubstrateOptions = {}): BrowserSubstrate => {
  const start = launch ?? ((spec: BrowserSessionSpec) => spawnWorker(entryPath, executablePath, spec));
  const sessions = new Map<string, Promise<{ readonly process: LocalWorkerProcess; readonly session: ProvisionedBrowserSession }>>();

  const provision = async (spec: BrowserSessionSpec): Promise<ProvisionedBrowserSession> => {
    const existing = sessions.get(spec.sessionId);
    if (existing !== undefined) return (await existing).session;
    const starting = start(spec).then((process) => ({
      process,
      session: {
        sessionId: spec.sessionId,
        substrate: 'local',
        shape,
        provisionedAt: clock(),
        send: (request: WorkerRequest) => sendTo(process.url, request),
      },
    }));
    sessions.set(spec.sessionId, starting);
    try {
      return (await starting).session;
    } catch (error) {
      sessions.delete(spec.sessionId);
      throw error;
    }
  };

  const find = async (sessionId: string): Promise<ProvisionedBrowserSession | null> => {
    const entry = sessions.get(sessionId);
    return entry === undefined ? null : (await entry.catch(() => null))?.session ?? null;
  };

  const destroy = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    sessions.delete(sessionId);
    const started = entry === undefined ? null : await entry.catch(() => null);
    await started?.process.stop();
  };

  return { substrate: 'local', shape, provision, find, destroy };
};
