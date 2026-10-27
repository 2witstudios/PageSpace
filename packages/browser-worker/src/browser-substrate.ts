/**
 * The substrate-agnostic seam (G6a entry, 2026-09-21): WHERE a browser
 * session runs is an adapter behind this type, and nothing outside an
 * adapter may name a host. D-19 puts the browser outside the agent VM; S3
 * picked a per-session Sprite; D-34 keeps the door open for Modal and others.
 * Every adapter therefore promises the same four things, and the rest of the
 * system is written against the promise:
 *
 *  1. ISOLATION — one session, one browser process, one throwaway profile.
 *     The browser is driven over a debugging PIPE (no CDP port exists), and
 *     the worker is the pipe's only end. No agent sandbox shares its host.
 *  2. ONE DOOR — the only way in is `send`, which reaches the worker's
 *     control port. Any credential the substrate needs to reach that port
 *     (an org token, a tunnel) lives inside the adapter's closure and never
 *     in a value this seam returns.
 *  3. PINNED KEY — the worker is started with `controlPublicKey` and obeys
 *     only instructions signed by its private half (`control-instruction.ts`).
 *  4. NOTHING PERSISTS — `destroy` removes the process and the profile; no
 *     checkpoint, snapshot or hibernation ever holds a live profile (S3 R3).
 */

/** The machine a session occupies, for metering at its real size (S3 R14). */
export type BrowserSessionShape = {
  readonly cpus: number;
  readonly memoryGB: number;
};

export type BrowserSessionSpec = {
  /** Deterministic per (owner, agent, conversation); names the session everywhere. */
  readonly sessionId: string;
  /** Base64 SPKI DER of the Ed25519 key whose instructions this worker obeys. */
  readonly controlPublicKey: string;
  /**
   * Transport origins the browser may reach, or `null` for the public web
   * (G6a has no accounts; G6b pins sessions to an account's origins).
   */
  readonly allowedOrigins: readonly string[] | null;
};

export type WorkerRequest = {
  readonly method: 'GET' | 'POST';
  /** Path on the worker's control port, e.g. `/control`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
};

export type WorkerResponse = {
  readonly status: number;
  readonly body: string;
};

export type ProvisionedBrowserSession = {
  readonly sessionId: string;
  /** The adapter's self-reported label, for logs and metering only — never branched on. */
  readonly substrate: string;
  readonly shape: BrowserSessionShape;
  readonly provisionedAt: number;
  readonly send: (request: WorkerRequest) => Promise<WorkerResponse>;
};

export type BrowserSubstrate = {
  readonly substrate: string;
  readonly shape: BrowserSessionShape;
  /** Idempotent by `sessionId`: a live session is returned, not duplicated. */
  readonly provision: (spec: BrowserSessionSpec) => Promise<ProvisionedBrowserSession>;
  /** The live session for `sessionId`, or `null`. Never provisions. */
  readonly find: (sessionId: string) => Promise<ProvisionedBrowserSession | null>;
  /** Removes the session's process and profile. Idempotent. */
  readonly destroy: (sessionId: string) => Promise<void>;
};
