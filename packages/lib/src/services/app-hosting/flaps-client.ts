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
 * retried per `app-hosting-retry.ts` — Fly rate-limits per object at ~1 r/s with a
 * burst of 3, which is tight within one app and generous across apps.
 */

import {
  MAX_FLAPS_ATTEMPTS,
  parseRetryAfterMs,
  planFlapsRetry,
} from './app-hosting-retry';

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

const noopSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FlapsResponse {
  status: number;
  /** Parsed JSON body, or null when the response had no body / unparseable body. */
  body: unknown;
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
  body?: unknown,
): Promise<FlapsResponse> {
  const { baseUrl = FLAPS_BASE_URL, token, fetchImpl = fetch, sleep = noopSleep } = transport;
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
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(FLAPS_TIMEOUT_MS),
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
      const plan = planFlapsRetry({ status, retryAfterMs, attempt });
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
      const plan = planFlapsRetry({ status: null, retryAfterMs: null, attempt });
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
  return /already (exists|been taken)|name.*taken/i.test(message);
}

function assertOk(status: number, body: unknown, endpoint: string): void {
  if (status >= 200 && status < 300) return;
  const message = typeof body === 'object' && body !== null && 'error' in body
    ? String((body as { error: unknown }).error)
    : `HTTP ${status}`;
  throw new FlapsError(`Fly Machines API ${endpoint} failed: ${message}`, status, endpoint);
}

/**
 * Create a Fly app on the given network.
 *
 * IDEMPOTENT: an "already exists" response resolves as success, so a retried or
 * re-driven provision converges instead of failing. This mirrors how
 * `addCertificate` treats a duplicate hostname, and it matters more here — the
 * `published_apps` row is written before this call, so a retry after a partial
 * failure is the normal recovery path, not an edge case.
 */
export async function createApp(transport: FlapsTransport, input: CreateAppInput): Promise<void> {
  const path = '/v1/apps';
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    app_name: input.appName,
    org_slug: input.orgSlug,
    network: input.network,
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

export async function createMachine(
  transport: FlapsTransport,
  input: CreateMachineInput,
): Promise<Machine> {
  const path = `/v1/apps/${encodeURIComponent(input.appName)}/machines`;
  const { status, body } = await flapsRequest(transport, 'POST', path, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.region === undefined ? {} : { region: input.region }),
    config: input.config,
  });
  assertOk(status, body, path);
  return body as Machine;
}

export async function getMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<Machine> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`;
  const { status, body } = await flapsRequest(transport, 'GET', path);
  assertOk(status, body, path);
  return body as Machine;
}

export async function startMachine(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`;
  const { status, body } = await flapsRequest(transport, 'POST', path);
  assertOk(status, body, path);
}

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
 * Block until a machine reaches a state. Fly's own endpoint does the waiting, so
 * this is one long-poll rather than a poll loop of ours.
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
  const { status, body } = await flapsRequest(transport, 'GET', path);
  assertOk(status, body, path);
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
 */
export async function acquireLease(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  ttlSeconds = 30,
): Promise<MachineLease> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/lease`;
  const { status, body } = await flapsRequest(transport, 'POST', path, { ttl: ttlSeconds });
  assertOk(status, body, path);
  const lease = (body as { data?: MachineLease })?.data ?? (body as MachineLease);
  return lease;
}

export async function releaseLease(
  transport: FlapsTransport,
  appName: string,
  machineId: string,
  nonce: string,
): Promise<void> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/lease`;
  const { baseUrl = FLAPS_BASE_URL, token, fetchImpl = fetch } = transport;
  // The nonce travels in a header, not a body, so this one call bypasses the
  // shared helper rather than growing it a header parameter used exactly once.
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'fly-machine-lease-nonce': nonce,
    },
    signal: AbortSignal.timeout(FLAPS_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) {
    throw new FlapsError(`Fly Machines API release lease failed: ${response.status}`, response.status, path);
  }
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
 */
export async function createDeployToken(
  transport: FlapsTransport,
  appName: string,
  expiry: string,
): Promise<string> {
  const path = `/v1/apps/${encodeURIComponent(appName)}/deploy_token`;
  const { status, body } = await flapsRequest(transport, 'POST', path, { expiry });
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
  const { status, body } = await flapsRequest(transport, 'POST', path, { config: merged });
  assertOk(status, body, path);
  return body as Machine;
}
