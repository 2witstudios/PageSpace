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

/**
 * Headers projected alongside the operation's declared headers. `accept` and
 * `content-type` when present; `content-length` ALWAYS, derived from the body
 * bytes (a caller value that disagrees is `malformed`). A projected value
 * carrying a control character is `malformed` (ADR 0004 §3.2).
 */
export type ProjectedHeader = 'accept' | 'content-type' | 'content-length';

/**
 * What the tool layer hands the authority: untrusted, before any
 * normalization. It carries NO operation, NO declared headers and NO
 * resources: a tool that could name its own operation could call a DELETE a
 * `read`, and a tool that could name its own resources could claim repo A
 * while the URL targets repo B. All three are derived server-side from the
 * `OperationRegistry` and the ACTUAL path (G1a review M1, M8).
 */
export type CanonicalRequestInput = {
  readonly channel: ExecutorChannel;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Exact body bytes; the empty body is `new Uint8Array(0)`, never null. */
  readonly body: Uint8Array;
};

/**
 * One reviewed operation: keyed by provider + channel + method + path
 * template, never by anything the tool layer says about itself. Lives in
 * code (the provider catalogues, G3), reviewed like code.
 */
export type OperationRegistryEntry = {
  /** `agent_accounts.providerSlug`; null = the generic-origin entries. */
  readonly providerSlug: string | null;
  readonly channel: ExecutorChannel;
  readonly method: MethodFor[ExecutorChannel];
  /**
   * Canonical path with `{name}` placeholders for whole segments, e.g.
   * `/repos/{owner}/{repo}/pulls/{number}/merge`. Each placeholder is a NAMED
   * RESOURCE SLOT: its value is the matching segment of the actual canonical
   * path, so `canonical.resources` is extracted from the URL being sent and
   * the placeholder names are the operation's declared resource keys (audit
   * projection, ADR 0004 §5). A placeholder name used twice is a registry defect.
   */
  readonly pathTemplate: string;
  readonly operation: OperationRef;
  /** Extra headers this operation may carry, lowercase; projected into the digest. */
  readonly declaredHeaders: readonly string[];
};

export type OperationRegistry = readonly OperationRegistryEntry[];

/** The operation every request without a registry match gets: class `unknown`, never self-declared. */
export type GenericOperation = { readonly class: 'unknown'; readonly name: 'generic_request' };

/** The frozen projection both sides hash. Field order is the canonical order. */
export type CanonicalRequest = {
  readonly channel: ExecutorChannel;
  readonly method: MethodFor[ExecutorChannel];
  readonly origin: CanonicalOrigin;
  /**
   * Dot-segments resolved. A DECODED copy is used only for the traversal and
   * control-character checks; the digested segments are normalized like a query
   * component (upper-case hex, only unreserved unescaped), never decoded — so
   * `foo;bar` ≠ `foo%3Bbar`, `+` ≠ `%2B`, `@` ≠ `%40`, `=` ≠ `%3D`, and `%2F` stays
   * encoded (ADR 0004 §3.2, second amendment).
   */
  readonly path: string;
  /**
   * Sorted `[name, value]` pairs; duplicates kept in input order. Each half is
   * NORMALIZED, never decoded (upper-case hex, only the RFC 3986 unreserved set
   * unescaped), so `a+b` and `a%2Bb` stay distinct digests (ADR 0004 §3.2).
   */
  readonly query: readonly (readonly [string, string])[];
  /** Only projected + registry-declared headers, lowercase, sorted by name. */
  readonly headers: readonly (readonly [string, string])[];
  /** Hex SHA-256 of the exact body bytes; the empty body hashes to the digest of zero bytes. */
  readonly bodySha256: string;
  /**
   * Sorted `[slot, segment]` pairs extracted from `path` by the matched
   * registry entry's `pathTemplate` — never supplied by the caller. `[]` for a
   * `generic_request` (no match) (G1a review M8).
   */
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

/**
 * The human-readable rendering of a canonical request, derived from it ALONE
 * (never model text). Everything the digest binds that changes what the
 * request DOES is shown: the query is part of the digest, so a human
 * approving `DELETE /repos/x` sees `?force=true&recursive=1` too. Header
 * NAMES are shown, never header values (G1a review H5).
 */
export type ApprovalSubject = {
  readonly headline: string;
  readonly origin: CanonicalOrigin;
  readonly operation: OperationRef;
  /** `canonical.path`, verbatim. */
  readonly path: string;
  /** `canonical.query`, verbatim — the same normalized pairs the digest covers. */
  readonly query: readonly (readonly [string, string])[];
  /** The names of `canonical.headers` (projected + declared), sorted; values are never rendered. */
  readonly headerNames: readonly string[];
  readonly resources: readonly (readonly [string, string])[];
  readonly bodySha256: string;
  readonly bodyBytes: number;
};

/**
 * `lookupOperation` — pure. The entry whose provider, channel, method and
 * path template match the CANONICAL method and path, with the slot values it
 * bound; `null` when none does (the caller then uses `GenericOperation`, no
 * declared headers and no resources). More
 * than one match is a registry defect, refused at registry load, never
 * resolved by order. G1b implements.
 */
export type LookupOperation = (input: {
  readonly registry: OperationRegistry;
  readonly providerSlug: string | null;
  readonly channel: ExecutorChannel;
  readonly method: MethodFor[ExecutorChannel];
  readonly path: string;
}) => { readonly entry: OperationRegistryEntry; readonly resources: readonly (readonly [string, string])[] } | null;

/**
 * `canonicalizeRequest` — pure, total. `providerSlug` comes from the account
 * row the authority read, never from the tool layer; `operation` and the
 * declared headers come from `lookupOperation` over `registry`. G1b implements.
 */
export type CanonicalizeRequest = (input: {
  readonly request: CanonicalRequestInput;
  readonly providerSlug: string | null;
  readonly registry: OperationRegistry;
}) => CanonicalizeResult;

/** `digestRequest` — `hash(canonicalJson(canonical))`, hash injected. G1b implements. */
export type DigestRequest = (input: { readonly canonical: CanonicalRequest; readonly hash: HashBytes }) => RequestDigest;

/** `renderApprovalSubject` — what the approval UI shows. G1b implements. */
export type RenderApprovalSubject = (input: { readonly canonical: CanonicalRequest }) => ApprovalSubject;
