/**
 * flaps-client — a thin, fetch-based client for the Fly Machines API
 * (`api.machines.dev`, a.k.a. flaps).
 *
 * NO SDK DEPENDENCY, on purpose. The Sprites SDK is ESM-only and had to be kept
 * out of shared code entirely, with instantiation pushed to app boundaries where
 * the bundler could cope. This module avoids that whole class of problem: it is
 * plain `fetch` against documented HTTP endpoints, importable from anywhere.
 *
 * THE ONE FOOTGUN THIS MODULE EXISTS TO CONTAIN: a Fly machine update REPLACES
 * THE ENTIRE CONFIG. Send `{guest: {...}}` alone and you have just deleted the
 * machine's `services`, `mounts` and `checks` — the app stops serving and nothing
 * reports an error. So there is deliberately NO exported function that takes a
 * config and sends it. The only mutation path is `updateMachineConfig`, which
 * fetches the live config, hands it to a merge function, and sends the result. If
 * you find yourself wanting a raw setter, you want `updateMachineConfig` with a
 * merge function that returns `{...current, ...yourChanges}`.
 *
 * Every request is bounded by a 10s AbortSignal (the pattern in
 * apps/web/src/lib/fly/certs.ts) so a hung Fly response cannot stall a caller, and
 * retried per `flaps-retry.ts` — Fly rate-limits per object at ~1 r/s with a
 * burst of 3, which is tight within one app and generous across apps. The ONE
 * endpoint that overrides that bound is `/wait`, which is a long poll: it is given
 * the window it asked the server to hold, plus the usual budget for the answer.
 *
 * RETRY SAFETY IS PER ENDPOINT, and each exported function documents its own.
 * A failed request may be AMBIGUOUS — a socket error or a 5xx says nothing about
 * whether Fly processed it before the answer was lost — so a blanket retry of every
 * method would double-create billable machines and mint deploy tokens returned to
 * nobody. The rule here: a mutation is retried on an ambiguous failure only when it
 * is IDEMPOTENT BY KEY (app name, machine name), and everything else is retried
 * only on a 429, the one failure Fly states it did not process.
 */

import {
  MAX_FLAPS_ATTEMPTS,
  parseRetryAfterMs,
  planFlapsRetry,
} from './flaps-retry';

export const FLAPS_BASE_URL = 'https://api.machines.dev';

/**
 * Bound every Fly request. Provisioning runs behind a job, but a hung socket with
 * no timeout holds a connection and a worker slot indefinitely.
 */
export const FLAPS_TIMEOUT_MS = 10_000;

/**
 * Transport seam. `fetchImpl` and `sleep` are injected so tests assert the exact
 * request without a network call and without paying real backoff wall-clock —
 * the same seam `SpriteSessionKillTransport` uses.
 */
export interface FlapsTransport {
  /** Defaults to the public Machines API. */
  baseUrl?: string;
  /** Bearer token — an org token, or an app-scoped deploy token. */
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * How a request's abort signal is built from its timeout. Defaults to
   * `AbortSignal.timeout`.
   *
   * A seam purely so a test can assert WHICH timeout a call was given —
   * `AbortSignal.timeout` exposes its own duration nowhere, and the long-poll
   * endpoint's whole correctness is "was this bounded at 10s or at the wait window
   * it asked for?". Without the seam that question can only be answered by waiting
   * ten real seconds.
   */
  abortSignalFor?: (timeoutMs: number) => AbortSignal;
}

/** A Flaps call that failed for a reason the caller may want to branch on. */
export class FlapsError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null for a transport-level failure (DNS, socket, timeout). */
    public readonly status: number | null,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'FlapsError';
  }
}

/**
 * A machine's guest sizing. `cpu_kind`/`cpus`/`memory_mb` are the fields we set;
 * anything else Fly adds round-trips through the index signature.
 */
export interface MachineGuest {
  cpu_kind?: string;
  cpus?: number;
  memory_mb?: number;
  [key: string]: unknown;
}

/**
 * A machine config as Fly stores it.
 *
 * The fields we actually read or write are named; everything else is preserved by
 * the index signature. That is not laziness — it is the merge-safety requirement.
 * A config round-trips through `updateMachineConfig`, and any field this type
 * DROPPED would be silently deleted from the live machine on the next update.
 * Modelling the config exhaustively would be a standing liability every time Fly
 * adds a field; preserving unknown keys is correct by construction.
 */
export interface MachineConfig {
  image?: string;
  guest?: MachineGuest;
  env?: Record<string, string>;
  services?: unknown[];
  mounts?: unknown[];
  checks?: Record<string, unknown>;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

export interface Machine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  config?: MachineConfig;
  [key: string]: unknown;
}

/** One entry from a machine's event log. Shape is Fly's; we pass it through raw. */
export interface MachineEvent {
  id?: string;
  type?: string;
  status?: string;
  source?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface MachineLease {
  nonce: string;
  expires_at?: number;
  [key: string]: unknown;
}

export interface CreateAppInput {
  appName: string;
  orgSlug: string;
  /**
   * The Fly network to place this app on. Callers pass the ONE shared
   * published-apps network — see `resolvePublishedAppsNetwork()`. This client
   * neither defaults nor derives it, because a per-app network makes fly-replay
   * fail with `502 cross-network replays are not allowed`.
   */
  network: string;
}

export interface CreateMachineInput {
  appName: string;
  name?: string;
  region?: string;
  config: MachineConfig;
}

/**
 * The wait the retry path uses when a transport has not supplied its own. It is
 * a REAL delay — tests inject a no-op `sleep` so backoff costs them no
 * wall-clock time, and naming this one for that injection would describe the
 * test rather than the production behaviour.
 */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FlapsResponse {
  status: number;
  /** Parsed JSON body, or null when the response had no body / unparseable body. */
  body: unknown;
}

interface FlapsRequestOptions {
  body?: unknown;
  /**
   * Extra request headers, merged over the defaults. The lease endpoints key on
   * one (`fly-machine-lease-nonce`) and nothing else in this client needs any.
   */
  headers?: Record<string, string>;
  /**
   * The abort bound for THIS request. Defaults to `FLAPS_TIMEOUT_MS`, which is right
   * for every endpoint that answers immediately and wrong for the one that does not:
   * `/wait` long-polls for as long as the caller asked, so a fixed 10s bound aborts a
   * perfectly healthy wait, retries it twice, and reports a transport failure for a
   * machine that was fine all along.
   */
  timeoutMs?: number;
  /**
   * Whether re-sending this request is harmless. Defaults to true. Set false on a
   * mutation whose repetition creates a second billable or credentialed thing —
   * see `planFlapsRetry`, which then retries only an explicit 429.
   */
  idempotent?: boolean;
}

/**
 * One bounded, retried HTTP call. Returns the status and parsed body for ANY
 * status — deciding whether a given status is an error is the caller's job,
 * because 404 means "already gone, success" on a delete and "wrong app, failure"
 * on a read.
 */
async function flapsRequest(
  transport: FlapsTransport,
  method: string,
  path: string,
  { body, headers, timeoutMs = FLAPS_TIMEOUT_MS, idempotent = true }: FlapsRequestOptions = {},
): Promise<FlapsResponse> {
  const {
    baseUrl = FLAPS_BASE_URL,
    token,
    fetchImpl = fetch,
    sleep = defaultSleep,
    abortSignalFor = (ms: number) => AbortSignal.timeout(ms),
  } = transport;
  const url = `${baseUrl}${path}`;

  let lastError: FlapsError | null = null;

  for (let attempt = 1; attempt <= MAX_FLAPS_ATTEMPTS; attempt += 1) {
    let status: number | null = null;
    let retryAfterMs: number | null = null;

    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: abortSignalFor(timeoutMs),
      });

      status = response.status;

      if (response.ok) {
        const text = await response.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            // A successful call with a non-JSON body is fine (some deletes return
            // an empty or plain-text body); the status is what mattered.
            parsed = null;
          }
        }
        return { status, body: parsed };
      }

      retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const text = await response.text().catch(() => '');
      lastError = new FlapsError(
        `Fly Machines API ${method} ${path} failed: ${status}${text ? ` ${text}` : ''}`,
        status,
        path,
      );

      // A non-retryable status (404, 409, 422…) is still a RESULT the caller may
      // want to inspect rather than an exception — return it so callers can treat
      // "already exists" or "already gone" as success.
      const plan = planFlapsRetry({ status, retryAfterMs, attempt, idempotent });
      if (!plan.retry) {
        return { status, body: safeJson(text) };
      }
      await sleep(plan.delayMs);
      continue;
    } catch (error) {
      // Transport-level: DNS, socket, or our own AbortSignal timeout. Never reached
      // Fly, so it says nothing about the request — retry it like a 5xx.
      lastError = new FlapsError(
        `Fly Machines API ${method} ${path} failed: ${error instanceof Error ? error.message : 'unknown transport error'}`,
        null,
        path,
      );
      const plan = planFlapsRetry({ status: null, retryAfterMs: null, attempt, idempotent });
      if (!plan.retry) break;
      await sleep(plan.delayMs);
    }
  }

  throw lastError ?? new FlapsError(`Fly Machines API ${method} ${path} failed`, null, path);
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when a Fly error body says the resource is already there. */
function isAlreadyExists(status: number, body: unknown): boolean {
  if (status !== 409 && status !== 422 && status !== 400) return false;
  const message = typeof body === 'object' && body !== null && 'error' in body
    ? String((body as { error: unknown }).error)
    : '';
  // `already_exists` (underscored) is the machine-create form; `already exists` and
  // "name has already been taken" are the app-create forms.
  return /already[ _](exists|been taken|in use)|name.*taken/i.test(message);
}

function assertOk(status: number, body: unknown, endpoint: string): void {
  if (status >= 200 && status < 300) return;
  const message = typeof body === 'object' && body !== null && 'error' in body
    ? String((body as { error: unknown }).error)
    : `HTTP ${status}`;
  throw new FlapsError(`Fly Machines API ${endpoint} failed: ${message}`, status, endpoint);
}

/**
 * A 2xx whose body is not a machine is not a machine.
 *
 * `flapsRequest` reports an empty or non-JSON success body as `null` — a real
 * case, since some endpoints answer with nothing and the status is what matters
 * there. Casting that `null` to `Machine` does not make the problem go away; it
 * moves it. The value travels as a machine and finally throws a TypeError on
 * `.id` in whatever code touched it first, with no status, no endpoint and no
 * relation to the call that produced it.
 *
 * So the shape is checked at the boundary, where the endpoint is still known,
 * and a bad answer becomes the same `FlapsError` every other failure in this
 * file raises. `id` is the field checked because it is the only one the rest of
 * the system dereferences — it is the machine's identity, and a machine object
 * without it cannot be started, stopped or destroyed.
 */
function asMachine(body: unknown, status: number, endpoint: string): Machine {
  const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    throw new FlapsError(
      `Fly Machines API ${endpoint} returned no machine`,
      status,
      endpoint,
    );
  }
  return body as Machine;
}

/**
 * Create a Fly app on the given network.
 *
 * IDEMPOTENT BY KEY: the request is keyed on `app_name`, which is globally unique
 * at Fly, so a second send cannot produce a second app — and an "already exists"
 * response resolves as success, so a retried or re-driven provision converges
 * instead of failing. This mirrors how `addCertificate` treats a duplicate
 * hostname, and it matters more here — the `published_apps` row is written before
 * this call, so a retry after a partial failure is the normal recovery path, not an
 * edge case. Being idempotent by key is exactly what makes retrying an AMBIGUOUS
 * failure (a lost response to a request Fly may already have processed) safe.
 */
export async function createApp(transport: FlapsTransport, input: CreateAppInput): Promise<void> {
  const path = '/v1/apps';
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: {
      app_name: input.appName,
      org_slug: input.orgSlug,
      network: input.network,
    },
  });
  if (isAlreadyExists(status, body)) return;
  assertOk(status, body, path);
}

/**
 * Destroy a Fly app. 404/410 resolve as success — the drain cron's kill must be
 * idempotent so a re-run confirms the death rather than failing forever.
 */
export async function deleteApp(transport: FlapsTransport, appName: string): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}`;
  const { status, body } = await flapsRequest(transport, 'DELETE', path);
  if (status === 404 || status === 410) return;
  assertOk(status, body, path);
}

/** Every machine in an app. Used to resolve a name-keyed create that raced itself. */
export async function listMachines(
  transport: FlapsTransport,
  appName: string,
): Promise<Machine[]> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines`;
  const { status, body } = await flapsRequest(transport, 'GET', path);
  assertOk(status, body, path);
  return Array.isArray(body) ? (body as Machine[]) : [];
}

/**
 * Create a machine.
 *
 * A MACHINE IS BILLABLE, so "did that request land?" is the question this function
 * exists to answer safely, and the answer depends entirely on whether the caller
 * supplied a `name`:
 *
 *  - WITH a name — machine names are unique within an app, so the name IS the
 *    idempotency key. A retry after an ambiguous failure either creates the machine
 *    (the first attempt never landed) or comes back "already exists", which is then
 *    resolved BY LOOKUP into the machine the earlier attempt created. Retrying is
 *    safe, so ambiguous failures are retried.
 *  - WITHOUT a name — Fly assigns one, and every send produces a NEW machine. There
 *    is no key to converge on, so a lost response cannot be distinguished from a
 *    lost request and the retry is exactly the thing that double-bills. Such a
 *    create is therefore NOT retried on an ambiguous failure (only on a 429, which
 *    Fly states it did not process). Callers that want retries should pass a name;
 *    the provisioner does.
 */
export async function createMachine(
  transport: FlapsTransport,
  input: CreateMachineInput,
): Promise<Machine> {
  const name = input.name;
  const path = `/v1/apps/${encodeURIComponent(input.appName)}/machines`;
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: {
      ...(name === undefined ? {} : { name }),
      ...(input.region === undefined ? {} : { region: input.region }),
      config: input.config,
    },
    idempotent: name !== undefined,
  });

  if (name !== undefined && isAlreadyExists(status, body)) {
    // The name is ours and unique per app, so a conflict means an earlier attempt of
    // THIS create landed. Success-by-lookup rather than a second create.
    const existing = (await listMachines(transport, input.appName)).find(
      (machine) => machine.name === name,
    );
    if (existing) return existing;
  }

  assertOk(status, body, path);
  return asMachine(body, status, path);
}

export async function getMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<Machine> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`;
  const { status, body } = await flapsRequest(transport, 'GET', path);
  assertOk(status, body, path);
  return asMachine(body, status, path);
}

/**
 * Start a machine. A POST, but idempotent by nature: it names one machine and asks
 * for one state, so a repeat is a no-op rather than a second resource. Ambiguous
 * failures are safe to retry.
 */
export async function startMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`;
  const { status, body } = await flapsRequest(transport, 'POST', path);
  assertOk(status, body, path);
}

/** Stop a machine. Idempotent for the same reason as `startMachine`. */
export async function stopMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`;
  const { status, body } = await flapsRequest(transport, 'POST', path);
  assertOk(status, body, path);
}

/** Destroy a machine. 404 resolves as success — the kill must be idempotent. */
export async function deleteMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`;
  const { status, body } = await flapsRequest(transport, 'DELETE', path);
  if (status === 404 || status === 410) return;
  assertOk(status, body, path);
}

/**
 * The client-side abort bound for a `/wait` long poll: the window the server was
 * asked to hold, plus the ordinary request budget for the answer to come back.
 *
 * Bounding a 60-second long poll at the 10-second default aborts a healthy wait
 * before Fly has said anything, retries it twice (1s, 2s), and finally reports a
 * transport error for a machine that reached its state fine — the caller sees a
 * failed provision that never failed. The bound has to cover what the endpoint was
 * told to do.
 */
export function waitRequestTimeoutMs(timeoutSeconds: number): number {
  return timeoutSeconds * 1000 + FLAPS_TIMEOUT_MS;
}

/**
 * Block until a machine reaches a state. Fly's own endpoint does the waiting, so
 * this is one long-poll rather than a poll loop of ours — which is why it is the one
 * call that overrides the shared request timeout.
 */
export async function waitForMachineState(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  state: string,
  timeoutSeconds = 60,
): Promise<void> {
  const path =
    `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}` +
    `/wait?state=${encodeURIComponent(state)}&timeout=${timeoutSeconds}`;
  const { status, body } = await flapsRequest(transport, 'GET', path, {
    timeoutMs: waitRequestTimeoutMs(timeoutSeconds),
  });
  assertOk(status, body, path);
}

/** What running a command inside a machine produced. */
export interface MachineExecResult {
  /** Fly's `exit_code`. 0 is the only success; a missing code is reported as -1. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command INSIDE a machine and collect its exit code and output.
 *
 * This is the deploy health check: a new machine reaching `state=started` means
 * Fly started the VM, NOT that the app inside it is serving. A blue/green swap
 * that destroys the old machine on `started` alone will happily replace a working
 * app with one that crash-loops on its first request, and the only evidence is a
 * 502 to the user. Asking the machine itself is the difference.
 *
 * NOT RETRIED on an ambiguous failure. The command is the caller's and may not be
 * idempotent, and a health probe that silently ran three times is a probe whose
 * result nobody can reason about — a lost response is reported as a failed check,
 * which fails the deploy CLOSED and keeps the old machine serving. That is the
 * correct bias for a call whose whole job is to withhold promotion.
 *
 * `timeoutSeconds` is Fly's own bound on the command; the request is given that
 * window plus the usual budget for the answer, the same arithmetic `/wait` uses.
 */
export async function execMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  command: string[],
  timeoutSeconds = 30,
): Promise<MachineExecResult> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/exec`;
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: { command, timeout: timeoutSeconds },
    timeoutMs: waitRequestTimeoutMs(timeoutSeconds),
    idempotent: false,
  });
  assertOk(status, body, path);
  const result = (body ?? {}) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown };
  return {
    exitCode: typeof result.exit_code === 'number' ? result.exit_code : -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/**
 * A machine's event log, returned RAW and unfiltered.
 *
 * HARD LIMIT, measured in the Phase 0 spike: Fly returns ONLY THE MOST RECENT 20
 * EVENTS. There is no pagination and no time-window parameter. Twenty events is
 * about five stop/start cycles, so on a busy app this endpoint has forgotten
 * yesterday by lunchtime.
 *
 * That is why metering CANNOT be reconstructed from this endpoint after the fact.
 * Our own start/stop calls are the primary billing record and events must be
 * mirrored to a local table AT WRITE TIME; this call is for confirming the recent
 * past and reconciling drift, never for rebuilding history.
 */
export async function listMachineEvents(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<MachineEvent[]> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/events`;
  const { status, body } = await flapsRequest(transport, 'GET', path);
  assertOk(status, body, path);
  return Array.isArray(body) ? (body as MachineEvent[]) : [];
}

/**
 * Take a lease on a machine, so two workers can't mutate it concurrently. Fly's
 * leases are the machine-level counterpart to our row-level claim.
 *
 * NOT RETRIED on an ambiguous failure: the response carries the nonce, so a lost
 * response leaves a lease held by a nonce nobody has — and the retry then fails on
 * the lease this call itself took. Better to surface the error and let the caller
 * come back after the TTL.
 */
export async function acquireLease(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  ttlSeconds = 30,
): Promise<MachineLease> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/lease`;
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: { ttl: ttlSeconds },
    idempotent: false,
  });
  assertOk(status, body, path);
  // Same reasoning as `asMachine`: a lease with no nonce cannot be released, and
  // an unreleasable lease blocks every later mutation of this machine until its
  // TTL expires. Better to fail here, where the caller can come back, than to
  // hand out an object whose nonce is `undefined`.
  const envelope = (body as { data?: MachineLease })?.data ?? (body as MachineLease);
  const nonce = typeof envelope === 'object' && envelope !== null ? envelope.nonce : undefined;
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new FlapsError(`Fly Machines API ${path} returned no lease nonce`, status, path);
  }
  return envelope;
}

export async function releaseLease(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  nonce: string,
): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/lease`;
  // Through the shared helper, so a 429 or a dropped socket is retried like every
  // other call. Retrying is safe and it MATTERS: the nonce names one specific
  // lease, so a repeat either releases it or finds it already gone — while an
  // un-retried failure leaves the machine locked until the TTL runs out, and
  // every worker that wants it in the meantime is refused.
  const { status, body } = await flapsRequest(transport, 'DELETE', path, {
    headers: { 'fly-machine-lease-nonce': nonce },
  });
  // Already released (or expired) is the outcome we wanted.
  if (status === 404) return;
  assertOk(status, body, path);
}

/**
 * Mint an app-scoped deploy token.
 *
 * Verified live by the Phase 0 spike (it is in Fly's OpenAPI spec but absent from
 * the prose docs). Its blast radius is exactly one app: full machine CRUD on its
 * own app, and 403 on every sibling app, on the org app list, and on app create.
 *
 * Two things the caller must know:
 *  - The BODY IS REQUIRED. Omitting it returns `400 {"error":"EOF"}`.
 *  - The response is `{"token": "FlyV1 fm2_…,fm2_…"}` and NOTHING else — no id, no
 *    expires_at. Fly hands back no handle, so if you want any record that this
 *    mint happened you must write it yourself. `mintDeployToken` in the
 *    provisioner does exactly that, and is the entry point you should be using.
 *
 * NEVER RETRIED on an ambiguous failure. There is no idempotency key — every send
 * mints a NEW token — and a token whose response was lost is the worst object in
 * this system: live, app-scoped, able to renew itself indefinitely, returned to
 * nobody and recorded nowhere. One clean error beats a second orphan credential, so
 * only an explicit 429 (which Fly states it did not process) is retried.
 */
export async function createDeployToken(
  transport: FlapsTransport,
  appName: string,
  expiry: string,
): Promise<string> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/deploy_token`;
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: { expiry },
    idempotent: false,
  });
  assertOk(status, body, path);
  const token = (body as { token?: unknown })?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new FlapsError('Fly returned no deploy token', status, path);
  }
  return token;
}

/**
 * THE ONLY WAY TO MUTATE A MACHINE CONFIG. Fetch the live config, apply `mergeFn`,
 * send the WHOLE result back.
 *
 * Fly's machine update is a FULL REPLACE: whatever config you POST becomes the
 * machine's entire config, and every field you omitted is gone. Posting a partial
 * update therefore deletes `services` (the app stops accepting traffic), `mounts`
 * (volumes detach), and `checks` — with a 200 OK and no warning. This function
 * exists so that mistake is not expressible: there is no exported alternative that
 * accepts a config, and `mergeFn` receives the real current config so a caller who
 * spreads it (`{...current, guest}`) keeps everything they didn't name.
 *
 * A `mergeFn` that ignores its argument and returns a fresh object will still wipe
 * the machine. That is the caller's bug, but it is the one to look for in review.
 */
export async function updateMachineConfig(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  mergeFn: (current: MachineConfig) => MachineConfig,
): Promise<Machine> {
  const machine = await getMachine(transport, appName, machineId);
  const current = machine.config ?? {};
  const merged = mergeFn(current);

  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`;
  // Idempotent: a full-replace update of one named machine to one exact config
  // reaches the same state however many times it lands.
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: { config: merged },
  });
  assertOk(status, body, path);
  return asMachine(body, status, path);
}

// ── TLS certificates ─────────────────────────────────────────────────────────
//
// Custom hostnames are attached to the ROUTER app (`resolveAppRouterFlyAppName`),
// never to an individual published app: the router is what Fly TLS-terminates,
// and the replay target has no public IP at all.
//
// These live on the Machines API (`api.machines.dev`) rather than Fly's GraphQL,
// which is what `apps/web/src/lib/fly/certs.ts` used to call. The REST resource is
// the reason that port is worth doing: GraphQL's `addCertificate` returns a bare
// `{configured, clientStatus}` and nothing about WHY a cert is stuck, while
// `dns_requirements` / `validation` here name the exact records the customer is
// missing — including the `_fly-ownership` TXT, which has no GraphQL equivalent
// and is the only validation path available to a domain behind a CDN.

/** The DNS records Fly needs in place before it can issue for a hostname. */
export interface FlyCertificateDnsRequirements {
  a?: string[];
  aaaa?: string[];
  cname?: string;
  acme_challenge?: { name?: string; target?: string };
  /**
   * The `_fly-ownership` TXT record. Present when Fly cannot validate by
   * reachability — a CDN-fronted host, an imported certificate, or an apex the
   * customer will not point at us until the cert exists.
   */
  ownership?: { name?: string; app_value?: string; org_value?: string };
  [key: string]: unknown;
}

/** Which validation methods Fly has confirmed for a hostname. */
export interface FlyCertificateValidation {
  dns_configured?: boolean;
  alpn_configured?: boolean;
  http_configured?: boolean;
  ownership_txt_configured?: boolean;
  [key: string]: unknown;
}

/**
 * A hostname's certificate state.
 *
 * Named fields are the ones we read; the index signature preserves everything
 * else, for the same reason `MachineConfig` does — Fly adds fields, and a type
 * that dropped them would make every future response lossy at the boundary.
 */
export interface FlyCertificate {
  hostname?: string;
  /** `'pending_validation' | 'active'` are the documented values. */
  status?: string;
  configured?: boolean;
  acme_requested?: boolean;
  dns_provider?: string;
  rate_limited_until?: string | null;
  validation?: FlyCertificateValidation;
  dns_requirements?: FlyCertificateDnsRequirements;
  validation_errors?: unknown[];
  [key: string]: unknown;
}

/** A 2xx whose body is not an object is not a certificate. */
function asCertificate(body: unknown, status: number, endpoint: string): FlyCertificate {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FlapsError(`Fly Machines API ${endpoint} returned no certificate`, status, endpoint);
  }
  return body as FlyCertificate;
}

function certificatesPath(appName: string): string {
  return `/v1/apps/${encodeURIComponent(appName)}/certificates`;
}

function certificatePath(appName: string, hostname: string): string {
  return `${certificatesPath(appName)}/${encodeURIComponent(hostname)}`;
}

/**
 * Request a Let's Encrypt certificate for `hostname` on `appName`.
 * `POST /v1/apps/{app}/certificates/acme`, body `{hostname}`.
 *
 * IDEMPOTENT BY KEY (the hostname): a hostname already registered on the app
 * resolves to that existing certificate rather than failing, so a re-provision,
 * a poll cycle, or a retried ambiguous request all converge instead of
 * alternating between "created" and "already exists". This mirrors `createApp`,
 * and it is what makes retrying a lost response safe.
 *
 * Returns the certificate's CURRENT state, which for a fresh request is
 * `status: 'pending_validation'` with `dns_requirements` filled in — that is the
 * useful part, not the status: it names the records the customer still has to
 * publish.
 */
export async function requestAcmeCertificate(
  transport: FlapsTransport,
  appName: string,
  hostname: string,
): Promise<FlyCertificate> {
  const path = `${certificatesPath(appName)}/acme`;
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    body: { hostname },
  });
  if (isAlreadyExists(status, body)) {
    const existing = await getCertificate(transport, appName, hostname);
    if (existing) return existing;
  }
  assertOk(status, body, path);
  return asCertificate(body, status, path);
}

/**
 * Read a hostname's certificate. `GET /v1/apps/{app}/certificates/{hostname}`.
 *
 * Returns null on 404 — "this app has no certificate for that hostname" is an
 * ANSWER on this endpoint, and the whole point of calling it before requesting
 * one. Every other non-2xx still throws.
 */
export async function getCertificate(
  transport: FlapsTransport,
  appName: string,
  hostname: string,
): Promise<FlyCertificate | null> {
  const path = certificatePath(appName, hostname);
  const { status, body } = await flapsRequest(transport, 'GET', path);
  if (status === 404) return null;
  assertOk(status, body, path);
  return asCertificate(body, status, path);
}

/**
 * Force Fly to re-run validation for a hostname.
 * `POST /v1/apps/{app}/certificates/{hostname}/check`.
 *
 * A POST that mutates nothing we own — it makes Fly re-read DNS — so it is safe
 * to retry, and it is the endpoint that answers "the customer says they added
 * the record; has Fly seen it?". Its response carries `dns_records`, i.e. what
 * Fly ACTUALLY resolved, which is the difference between telling a customer
 * "still not configured" and telling them "we see your TXT, but it says X".
 *
 * Returns null on 404, same reasoning as {@link getCertificate}.
 */
export async function checkCertificate(
  transport: FlapsTransport,
  appName: string,
  hostname: string,
): Promise<FlyCertificate | null> {
  const path = `${certificatePath(appName, hostname)}/check`;
  const { status, body } = await flapsRequest(transport, 'POST', path);
  if (status === 404) return null;
  assertOk(status, body, path);
  return asCertificate(body, status, path);
}

/**
 * Remove a hostname and all its certificates from the app.
 * `DELETE /v1/apps/{app}/certificates/{hostname}` (204 on success).
 *
 * IDEMPOTENT: a 404 is success — the desired end state is "this app does not
 * serve that hostname", and it already holds. Certs bill per hostname, so the
 * delete path must converge rather than strand a charge behind a retry that
 * refuses to run twice.
 */
export async function deleteCertificate(
  transport: FlapsTransport,
  appName: string,
  hostname: string,
): Promise<void> {
  const path = certificatePath(appName, hostname);
  const { status, body } = await flapsRequest(transport, 'DELETE', path);
  if (status === 404) return;
  assertOk(status, body, path);
}
