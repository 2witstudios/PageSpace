/**
 * router-core — the PURE serving-edge decision: hostname in, route out.
 *
 * The whole enforcement property of the metered tier lives in one function here
 * ({@link decideAppRoute}) and is therefore testable without a database, a clock,
 * Fly, or a network: **an app whose payer is out of credits is not replayed to,
 * so its machine is never started, so it never bills.** Enforcement is
 * "don't wake", not clawback — there is no credit to claw back from an account
 * that has none, which is precisely why the check has to happen BEFORE the wake
 * rather than after it.
 *
 * That is also why the metered tier runs with NO `fly-replay-cache`. The cache
 * exists to skip the router hop on subsequent requests — which means skipping
 * this decision, which means skipping the balance check. A cached replay would
 * keep a machine awake and billing for a payer we would refuse today. The
 * dedicated (flat-rate) tier is the only legitimate cache user, because it has
 * no balance gate to bypass; wiring that is a later change and is deliberately
 * not smuggled in here. See {@link replayCachePolicyFor}.
 */

/**
 * The `timeout=` on every emitted replay, in milliseconds.
 *
 * Fly's proxy auto-starts a stopped target, and the default wait for that start
 * is long enough (~7.5s) that a cold published app reads as a hung page rather
 * than a slow one. 1500ms collapses that stall: past it the proxy gives up and
 * the caller sees a fast error it can retry, which for a scale-to-zero app is
 * strictly better than a browser spinner — the second request lands on a machine
 * the first one already started.
 */
export const FLY_REPLAY_TIMEOUT_MS = 1500;

/**
 * Fly will not replay a request whose body exceeds 1MB.
 *
 * This is a hard platform limit and it shapes the product, not just this file:
 * an upload path routed through the replay edge breaks at 1MB with a
 * platform-level error we cannot improve on. Upload paths therefore go
 * DIRECT TO TIGRIS via presigned URLs, never through the router. No upload
 * plumbing is built here — this constant and {@link exceedsReplayableBody} exist
 * so the constraint is enforced and legible at the edge (a clear 413 naming the
 * limit) instead of surfacing as an opaque 502 from Fly.
 */
export const MAX_REPLAYABLE_BODY_BYTES = 1_048_576;
// 1,048,576 — one MEBIbyte. Any proxy mirroring this cap must say `1MiB`, never
// `1MB`: Caddy (and most size parsers) read `MB` as 1,000,000, which would refuse
// every body between the two figures while this route's own 413 page names a
// limit that allows them. See `fly/Caddyfile.fly` in PageSpace-Deploy.

/** A published app, reduced to exactly what the routing decision reads. */
export interface RoutableApp {
  /** `published_apps.flyAppName` — the replay target. */
  flyAppName: string;
  /** `published_apps.status`. */
  status: string;
  /** `published_apps.tier` — 'metered' is gated, 'dedicated' is not. */
  tier: string;
  /**
   * Whether the row has a `machineId`.
   *
   * A precondition for replaying, not a detail: `fly-replay` targets an APP, and
   * Fly's proxy auto-starts a STOPPED machine — it does not create one. An app
   * with no machine yet (mid-first-deploy) has nothing to auto-start, so a replay
   * to it fails at the platform with no useful message. Answering "deploying"
   * ourselves is both honest and diagnosable.
   */
  hasMachine: boolean;
}

/**
 * What the edge should do with this request.
 *
 * `daily_cap` is a parked reason the pure decision never produces: it comes from
 * the WAKE, which is the only thing that can discover that an app has spent its
 * daily awake budget. It is kept distinct from `out_of_credits` because the two ask
 * different things of the owner — one is "top up", the other is "your app has
 * outgrown the metered tier, and it comes back on its own tomorrow".
 *
 * `parked` is deliberately its own outcome rather than a flavour of
 * `unavailable`: it is the ENFORCEMENT state, it is the one outcome that must
 * never start a machine, and it is the number worth watching in metrics.
 */
export type AppRouteDecision =
  | { kind: 'replay'; flyAppName: string; state: string; timeoutMs: number }
  | { kind: 'parked'; reason: 'out_of_credits' | 'parked_status' | 'daily_cap' }
  | { kind: 'unavailable'; reason: 'deploying' | 'failed' | 'destroying' | 'hosting_disabled' }
  | { kind: 'not_found'; reason: 'unknown_host' | 'apex' | 'custom_host' | 'no_such_app' };

/** A hostname resolved against the published-apps apex. */
export type AppHost =
  | { kind: 'subdomain'; subdomain: string }
  | { kind: 'apex' }
  /** A hostname that is not under the apex at all — a custom domain, or noise. */
  | { kind: 'foreign'; hostname: string };

/** One DNS label: alphanumeric, inner hyphens allowed, 1..63 chars. */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LABEL_LENGTH = 63;

/**
 * Normalize a `Host` header value: lowercase, strip a trailing dot, strip the
 * port — including from a bracketed IPv6 literal, where a naive "cut at the last
 * colon" would amputate the address instead.
 */
export function normalizeRequestHost(rawHost: string): string {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close !== -1) host = host.slice(0, close + 1);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Resolve a request hostname against the published-apps apex.
 *
 * Only a SINGLE label under the apex is a published app: `acme.pagespace.app`
 * yes, `a.b.pagespace.app` no. That is not fussiness — the wildcard cert covers
 * one level, so a deeper name is not TLS-terminated for us anyway, and admitting
 * it would let `evil.acme.pagespace.app` present as the app `evil` while looking
 * to a reader like a child of `acme`.
 */
export function parseAppHost(rawHost: string, apex: string): AppHost {
  const host = normalizeRequestHost(rawHost);
  const normalizedApex = apex.trim().toLowerCase();
  if (host.length === 0 || normalizedApex.length === 0) {
    return { kind: 'foreign', hostname: host };
  }
  if (host === normalizedApex) return { kind: 'apex' };
  const suffix = `.${normalizedApex}`;
  if (!host.endsWith(suffix)) return { kind: 'foreign', hostname: host };

  const label = host.slice(0, -suffix.length);
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return { kind: 'foreign', hostname: host };
  }
  if (label.includes('.') || !LABEL_PATTERN.test(label)) {
    return { kind: 'foreign', hostname: host };
  }
  return { kind: 'subdomain', subdomain: label };
}

/** Statuses whose app has something live to serve. */
const SERVABLE_STATUSES = new Set(['running', 'stopped', 'deploying']);

export interface AppRouteInput {
  /** The row the hostname resolved to, or null when nothing did. */
  app: RoutableApp | null;
  /**
   * Whether the app's PAYER can still spend — the balance-check-before-wake.
   * Read only for a 'metered' app; a 'dedicated' app is billed flat and skips
   * the gate by definition (`published_apps_parked_is_metered_only` enforces the
   * same rule in the database).
   */
  balanceOk: boolean;
  /** This app's derived fly-replay `state` key. */
  replayState: string;
}

/**
 * The routing decision.
 *
 * ORDER IS LOAD-BEARING. The persisted `parked` status is checked BEFORE the
 * live balance read: parking is an enforcement action the metering cron took,
 * and a payer who has since topped up gets un-parked by that cron (which can
 * also restart the machine), not by a router that silently forgives the state on
 * the next request.
 *
 * That cron is NOT in this branch — it arrives with the awake-seconds metering
 * work (PR #2493), which is why grepping for it here finds nothing. The ordering
 * is built now because it is the router's half of the contract and retrofitting
 * it later would mean revisiting every decision below; both halves ship dark
 * behind `APP_HOSTING_ENABLED`, so neither is load-bearing until they meet. The router NEVER writes — a status write on a
 * per-request path would put a database mutation in front of every asset a
 * published page loads.
 *
 * The converse also matters: a `running` app whose payer has run out is refused
 * here even though its row still says `running`. The row lags by up to one cron
 * tick; the balance does not.
 */
export function decideAppRoute(input: AppRouteInput): AppRouteDecision {
  const { app } = input;
  if (!app) return { kind: 'not_found', reason: 'no_such_app' };

  if (app.status === 'parked') return { kind: 'parked', reason: 'parked_status' };
  if (app.status === 'destroying') return { kind: 'unavailable', reason: 'destroying' };
  if (app.status === 'failed') return { kind: 'unavailable', reason: 'failed' };

  // provisioning / building, and any status this file has not been taught, are
  // "not serving yet". Defaulting an UNKNOWN status to unavailable rather than
  // to replay is the fail-closed direction: a status added later must not start
  // billing machines through a router that has never heard of it.
  if (!SERVABLE_STATUSES.has(app.status)) return { kind: 'unavailable', reason: 'deploying' };
  if (!app.hasMachine) return { kind: 'unavailable', reason: 'deploying' };

  if (app.tier === 'metered' && !input.balanceOk) {
    return { kind: 'parked', reason: 'out_of_credits' };
  }

  return {
    kind: 'replay',
    flyAppName: app.flyAppName,
    state: input.replayState,
    timeoutMs: FLY_REPLAY_TIMEOUT_MS,
  };
}

/**
 * Render a `fly-replay` header value.
 *
 * Throws on a target or state carrying the header's own `;`/`=` grammar rather
 * than emitting it: a value that can inject a second directive can redirect the
 * replay to another app. Both inputs are server-derived today (a `pgs-app-`
 * name and a hex digest), which is exactly the condition under which such a
 * check is cheap and stays true.
 */
export function buildFlyReplayHeader(args: {
  flyAppName: string;
  state: string;
  timeoutMs: number;
}): string {
  for (const [field, value] of [['app', args.flyAppName], ['state', args.state]] as const) {
    if (value.length === 0) throw new Error(`buildFlyReplayHeader requires a non-empty ${field}`);
    if (/[;=,\s]/.test(value)) {
      throw new Error(`buildFlyReplayHeader received a ${field} containing header-grammar characters`);
    }
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('buildFlyReplayHeader requires a positive integer timeoutMs');
  }
  return `app=${args.flyAppName};state=${args.state};timeout=${args.timeoutMs}`;
}

/**
 * Whether a request's DECLARED body size is past what Fly can replay.
 *
 * Reads `Content-Length` only, and is therefore only half the check: a request
 * that sends no length makes this answer false. {@link exceedsStreamedBody}
 * covers that case — see the note there for why the split is deliberate rather
 * than an oversight. See {@link MAX_REPLAYABLE_BODY_BYTES} for where large
 * payloads are supposed to go instead.
 */
export function exceedsReplayableBody(contentLengthHeader: string | null | undefined): boolean {
  if (!contentLengthHeader) return false;
  const bytes = Number(contentLengthHeader);
  if (!Number.isFinite(bytes) || bytes < 0) return false;
  return bytes > MAX_REPLAYABLE_BODY_BYTES;
}

/**
 * Whether a body with no declared length runs past what Fly can replay.
 *
 * A request without `Content-Length` gives the header check above nothing to
 * read, so it would let the request through to `fly-replay` — where Fly, unable
 * to replay a body over the limit, fails it at the platform. The client gets an
 * opaque 502 instead of the 413 this edge exists to give them, and it happens on
 * the one path nobody tests.
 *
 * Deliberately NOT called "chunked": that names an HTTP/1.1 transfer-encoding,
 * and HTTP/2 forbids it outright, carrying request content in DATA frames with
 * no length at all. Keying on the ABSENCE of `Content-Length` covers both, which
 * matters because the edge in front of this serves HTTP/2.
 *
 * So the body is measured, but ONLY when there is no length to read, and only up
 * to the limit: the read stops and the stream is cancelled at the first byte past
 * it. That keeps the original design property — a request that declares its size
 * pays nothing, which is nearly all of them — while closing the case that
 * declares nothing. Cancelling loses no replayable data: the only bodies
 * cancelled are ones already too large for Fly to replay.
 *
 * Returns false for a bodyless request (GET, HEAD, a POST with no body), which
 * is the same answer measuring an empty stream would give, without the read.
 */
export async function exceedsStreamedBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  limit: number = MAX_REPLAYABLE_BODY_BYTES,
): Promise<boolean> {
  if (!body) return false;

  const reader = body.getReader();
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      seen += value?.byteLength ?? 0;
      if (seen > limit) return true;
    }
  } finally {
    // Signals the producer to stop sending. This matters on the `return true`
    // path, which leaves the stream mid-flight by design: without it the sender
    // keeps streaming a body we have already decided to refuse. On the `done`
    // path the stream is already closed and this is a no-op. It does NOT release
    // the reader's lock, and does not need to — nothing else reads this body.
    // Swallowing the rejection is deliberate: we are refusing the request either
    // way, and a failure to cancel must not become the error the caller sees.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Whether this app may use `fly-replay-cache`.
 *
 * Never for a metered app: the cache skips the router hop, and the router hop IS
 * the balance gate (see the file header). Stated as a function so the rule is
 * one call away wherever the cache is eventually wired for the dedicated tier,
 * rather than a comment somebody has to remember to read.
 */
export function replayCachePolicyFor(tier: string): 'no-cache' | 'cacheable' {
  return tier === 'dedicated' ? 'cacheable' : 'no-cache';
}
