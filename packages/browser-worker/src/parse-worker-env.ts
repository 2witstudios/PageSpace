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

export const parseWorkerEnv = (_env: Readonly<Record<string, string | undefined>>): WorkerEnvVerdict => {
  throw new Error('parseWorkerEnv: not implemented (RED)');
};
