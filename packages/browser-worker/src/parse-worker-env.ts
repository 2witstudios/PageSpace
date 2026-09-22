/**
 * The worker's environment → its configuration, or a refusal to start —
 * pure. A worker that has no session id or no pinned control key must not
 * start at all: it would either obey nobody or, worse, have to guess whom.
 */
export type WorkerConfig = {
  readonly sessionId: string;
  readonly controlPublicKey: string;
  readonly allowedOrigins: readonly string[] | null;
  readonly host: string;
  readonly port: number;
  readonly profileRoot: string | null;
  readonly executablePath: string | null;
};

export type WorkerEnvRefusal = 'session-id-missing' | 'session-id-invalid' | 'control-key-missing' | 'control-key-invalid' | 'allowed-origins-invalid' | 'port-invalid';

export type WorkerEnvVerdict = { readonly ok: true; readonly config: WorkerConfig } | { readonly ok: false; readonly reason: WorkerEnvRefusal };

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const parseOrigins = (raw: string | null): readonly string[] | null | 'invalid' => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : 'invalid';
  } catch {
    return 'invalid';
  }
};

const parsePort = (raw: string | null): number | null => {
  if (raw === null) return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
};

export const parseWorkerEnv = (env: Readonly<Record<string, string | undefined>>): WorkerEnvVerdict => {
  const sessionId = present(env.BROWSER_SESSION_ID);
  if (sessionId === null) return { ok: false, reason: 'session-id-missing' };
  if (!SESSION_ID.test(sessionId)) return { ok: false, reason: 'session-id-invalid' };

  const controlPublicKey = present(env.BROWSER_CONTROL_PUBLIC_KEY);
  if (controlPublicKey === null) return { ok: false, reason: 'control-key-missing' };
  if (!BASE64.test(controlPublicKey)) return { ok: false, reason: 'control-key-invalid' };

  const allowedOrigins = parseOrigins(present(env.BROWSER_ALLOWED_ORIGINS));
  if (allowedOrigins === 'invalid') return { ok: false, reason: 'allowed-origins-invalid' };

  const port = parsePort(present(env.BROWSER_WORKER_PORT));
  if (port === null) return { ok: false, reason: 'port-invalid' };

  return {
    ok: true,
    config: {
      sessionId,
      controlPublicKey,
      allowedOrigins,
      host: present(env.BROWSER_WORKER_HOST) ?? DEFAULT_HOST,
      port,
      profileRoot: present(env.BROWSER_PROFILE_ROOT),
      executablePath: present(env.BROWSER_EXECUTABLE_PATH),
    },
  };
};
