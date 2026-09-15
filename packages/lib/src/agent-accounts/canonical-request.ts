/**
 * THE CANONICAL REQUEST AND ITS DIGEST (ADR 0004 §3).
 *
 * Frozen at L1·G1a; types only. G1b implements `canonicalize-request.ts`,
 * `digest-request.ts` and `render-approval-subject.ts` against these shapes.
 *
 * The approval UI shows ONE representation of a request and the executor
 * must send exactly that one. Freezing the request as a canonical projection
 * and hashing it on both sides is what turns "approve one, execute another"
 * into a `digest_mismatch` instead of a review finding. The projection rules
 * follow `env-bridge/grant-args.ts`: a fixed field set per channel, fixed
 * order, absent optionals encoded as `null`/`[]`/`{}` never as a missing key,
 * nothing outside the declared fields ever projected.
 */
import type { ExecutorChannel, OperationRef, RequestDigest, HashBytes } from './grant';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RelayMethod = 'git-receive-pack' | 'git-upload-pack' | 'lfs-batch' | 'lfs-upload';
export type BrowserMethod = 'navigate' | 'click' | 'type' | 'read' | 'wait' | 'fill';

/** The closed method set per channel; anything else is `malformed`. */
export type MethodFor = {
  readonly 'http-executor': HttpMethod;
  readonly 'relay-runner': RelayMethod;
  readonly 'browser-worker': BrowserMethod;
};

/**
 * A canonical origin: `https://` only, host IDNA→ASCII lowercase, explicit
 * port always present (`:443` is written), no userinfo, no wildcard, no IP
 * literal (ADR 0004 §3.2). Branded so a raw string cannot pass as one.
 */
export type CanonicalOrigin = string & { readonly __brand: 'CanonicalOrigin' };

/**
 * Headers the CALLER may never supply — the executor sets them. Presence in
 * the input is a refusal, not a strip.
 */
export type ReservedHeader =
  | 'authorization'
  | 'cookie'
  | 'host'
  | 'proxy-authorization'
  | 'proxy-connection'
  | 'x-forwarded-for'
  | 'x-forwarded-host'
  | 'x-forwarded-proto'
  | 'transfer-encoding'
  | 'connection'
  | 'upgrade';

/** Headers that are always projected when present, plus the operation's declared headers. */
export type ProjectedHeader = 'accept' | 'content-type' | 'content-length';

/** What the tool layer hands the authority: untrusted, before any normalization. */
export type CanonicalRequestInput = {
  readonly channel: ExecutorChannel;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Exact body bytes; the empty body is `new Uint8Array(0)`, never null. */
  readonly body: Uint8Array;
  /** Operation-specific identifiers the policy restricts on (repo, org, recipient, webhook target, frame origin). */
  readonly resources: Readonly<Record<string, string>>;
  readonly operation: OperationRef;
  /** The operation's declared extra headers (from the reviewed catalogue), lowercase. */
  readonly declaredHeaders: readonly string[];
};

/** The frozen projection both sides hash. Field order is the canonical order. */
export type CanonicalRequest = {
  readonly channel: ExecutorChannel;
  readonly method: MethodFor[ExecutorChannel];
  readonly origin: CanonicalOrigin;
  /** Percent-decoded once, re-encoded canonically, dot-segments resolved. */
  readonly path: string;
  /** Sorted `[name, value]` pairs; duplicates kept in input order. */
  readonly query: readonly (readonly [string, string])[];
  /** Only projected + declared headers, lowercase, sorted by name. */
  readonly headers: readonly (readonly [string, string])[];
  /** Hex SHA-256 of the exact body bytes; the empty body hashes to the digest of zero bytes. */
  readonly bodySha256: string;
  /** Sorted `[key, value]` pairs. */
  readonly resources: readonly (readonly [string, string])[];
  readonly operation: OperationRef;
};

/** Why canonicalization refused (ADR 0004 F18). Reasons are for the human/audit, never the model. */
export type CanonicalizeRefusal =
  | 'method_not_allowed'
  | 'scheme_not_https'
  | 'userinfo_present'
  | 'wildcard_host'
  | 'ip_literal_host'
  | 'host_not_idna'
  | 'path_traversal'
  | 'path_control_char'
  | 'reserved_header'
  | 'malformed';

export type CanonicalizeResult =
  | { readonly ok: true; readonly canonical: CanonicalRequest }
  | { readonly ok: false; readonly reason: CanonicalizeRefusal };

/** The human-readable rendering of a canonical request, derived from it ALONE (never model text). */
export type ApprovalSubject = {
  readonly headline: string;
  readonly origin: CanonicalOrigin;
  readonly operation: OperationRef;
  readonly resources: readonly (readonly [string, string])[];
  readonly bodySha256: string;
  readonly bodyBytes: number;
};

/** `canonicalizeRequest` — pure, total. G1b implements. */
export type CanonicalizeRequest = (input: CanonicalRequestInput) => CanonicalizeResult;

/** `digestRequest` — `hash(canonicalJson(canonical))`, hash injected. G1b implements. */
export type DigestRequest = (input: { readonly canonical: CanonicalRequest; readonly hash: HashBytes }) => RequestDigest;

/** `renderApprovalSubject` — what the approval UI shows. G1b implements. */
export type RenderApprovalSubject = (input: { readonly canonical: CanonicalRequest }) => ApprovalSubject;
