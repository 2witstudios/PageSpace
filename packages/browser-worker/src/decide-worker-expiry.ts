/**
 * Should an idle worker end itself? — pure.
 *
 * The web process that provisioned a session reaps it when idle, but that
 * clock dies with the process. The worker therefore keeps its own: when no
 * accepted instruction has arrived for `idleShutdownMs`, it closes the
 * browser, deletes the profile and exits, so a session state on disk never
 * outlives the work that needed it (S3 R3, R15) whatever happens upstream.
 */
export type WorkerExpiry = { readonly expire: true } | { readonly expire: false; readonly recheckInMs: number };

export type DecideWorkerExpiryOptions = {
  readonly lastInstructedAt: number;
  readonly now: number;
  readonly idleShutdownMs: number;
};

export const decideWorkerExpiry = ({ lastInstructedAt, now, idleShutdownMs }: DecideWorkerExpiryOptions): WorkerExpiry => {
  const remaining = lastInstructedAt + idleShutdownMs - now;
  return remaining <= 0 ? { expire: true } : { expire: false, recheckInMs: remaining };
};
