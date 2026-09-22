export type WorkerExpiry = { readonly expire: true } | { readonly expire: false; readonly recheckInMs: number };

export type DecideWorkerExpiryOptions = {
  readonly lastInstructedAt: number;
  readonly now: number;
  readonly idleShutdownMs: number;
};

export const decideWorkerExpiry = (_options: DecideWorkerExpiryOptions): WorkerExpiry => {
  throw new Error('decideWorkerExpiry: not implemented (RED)');
};
