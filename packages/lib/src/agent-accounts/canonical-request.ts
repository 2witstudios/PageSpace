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
 * The account's in-provider resource allowlists: restriction key → allowed
 * values (`agent_accounts.resourceRestrictions`; ADR 0004 §3.2 `resources`).
 * A key the matched operation does not bind is `out_of_scope` — an operation
 * that cannot show which repo or recipient it touches cannot be proven inside
 * the list (G1c R5, R11).
 */
export type ResourceRestrictions = Readonly<Record<string, readonly string[]>>;

/**
 * A typed resource slot read from the CANONICAL BODY (G1c R5) — the Slack
 * channel of `chat.postMessage`, the recipients of a mail send — so a
 * restriction or policy can bind what a path-only template cannot. The body
 * is parsed as JSON; `pointer` walks object keys from the root. `string`
 * yields one value; `string_array` yields one value per element (duplicates
 * kept, input order). A missing field, a value of another shape, or a body
 * that is not a JSON object is `malformed`: a declared resource the request
 * does not carry is never silently empty.
 */
export type BodyResourceSlot = {
  readonly slot: string;
  readonly pointer: readonly string[];
  readonly shape: 'string' | 'string_array';
};

/**
 * Where a relay operation's resources come from when they are not in the URL
 * (G1c R11): the git smart-HTTP request itself. `receive_pack_ref_names`
 * yields every ref name a `git-receive-pack` command list updates
 * (`refs/heads/main`); `receive_pack_branches` yields the branch names of the
 * `refs/heads/*` updates (`main`). Parsed from the pkt-line command section of
 * the canonical body, so the digest — which covers the body — is recomputed
 * over exactly the refs that are pushed. A ref name that starts with `-` or
 * carries a NUL or control character is `flag_injection`.
 */
export type DerivedResourceRule = {
  readonly slot: string;
  readonly source: 'receive_pack_ref_names' | 'receive_pack_branches';
};

/**
 * One reviewed operation: keyed by provider + ORIGIN + channel + method + path
 * template, never by anything the tool layer says about itself. Lives in code
 * (the provider catalogues, G3; the relay catalogue, G4), reviewed like code.
 *
 * AMENDED 2026-09-16 (G1c R7, R5, R6, R11, R17). The entry is keyed by origin
 * as well as provider, and its provider is never null: the first shape let a
 * null-provider entry match every origin. Resources may now come from typed
 * body slots and from the git protocol request, every slot maps to the
 * restriction key it is compared and emitted under, and the audit chain
 * receives only the slots the entry explicitly allows.
 */
export type OperationRegistryEntry = {
  /** `agent_accounts.providerSlug`. An account whose `providerSlug` is null matches NO entry (generic origin). */
  readonly providerSlug: string;
  /** The canonical origin this entry describes; a request to any other origin does not match it. */
  readonly origin: CanonicalOrigin;
  readonly channel: ExecutorChannel;
  readonly method: MethodFor[ExecutorChannel];
  /**
   * Canonical path template (ADR 0004 §3.2, slot matching fully specified in
   * G1c R17). Starts with `/`; `/`-separated segments, none empty. Each
   * segment is a literal, a `{name}` slot matching exactly ONE non-empty
   * segment, or — as the LAST segment only — a `{name+}` slot matching one or
   * more non-empty segments, bound as those segments joined by `/`
   * (`/repos/{owner}/{repo}/contents/{path+}`). Matching is over the whole
   * canonical path (no prefix match); a path with an empty segment matches no
   * template. When several entries match one request the most specific wins,
   * compared segment by segment from the left: literal beats `{name}` beats
   * `{name+}`; two entries equally specific at every segment are a registry
   * conflict, refused at load and resolved to no match at lookup. A slot name
   * used twice across the path, body and derived slots is a registry defect.
   */
  readonly pathTemplate: string;
  /** Resource slots read from the JSON body (R5). */
  readonly bodySlots: readonly BodyResourceSlot[];
  /** Resource slots derived from the git protocol request; relay-runner entries only (R11). */
  readonly derivedResources: readonly DerivedResourceRule[];
  /**
   * Slot name → the `ResourceRestrictions` key its values are compared and
   * emitted under in `CanonicalRequest.resources` (R17). A slot absent from
   * the map is emitted under its own name.
   */
  readonly restrictionKeys: Readonly<Record<string, string>>;
  /**
   * The slot names whose values may enter the tamper-evident, non-erasable
   * audit chain (R6). An explicit allowlist, EMPTY by default: a slot that can
   * carry a secret (`/v1/tokens/{token}`, `/reset/{code}`) is simply never
   * listed. Naming a slot the entry does not declare is a registry defect.
   */
  readonly auditResourceSlots: readonly string[];
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
   * `[restrictionKey, value]` pairs, sorted by key (values in extraction
   * order), bound by the matched entry from the ACTUAL request — path slots,
   * body slots (R5) and git-derived resources (R11), each under its
   * `restrictionKeys` name — never supplied by the caller. `[]` for a
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
  /** A git-derived ref name that starts with `-` or carries NUL/control characters (R11; ADR 0006 F6). */
  | 'flag_injection'
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
 * `lookupOperation` — pure. The most specific entry (R17) whose provider,
 * origin, channel, method and path template match the CANONICAL origin,
 * method and path, with the PATH slot values it bound under their restriction
 * keys; `null` when none does, when `providerSlug` is null, or when the best
 * matches tie (the caller then uses `GenericOperation`, no declared headers
 * and no resources). A tie is a registry defect refused at load, never
 * resolved by order.
 */
export type LookupOperation = (input: {
  readonly registry: OperationRegistry;
  readonly providerSlug: string | null;
  readonly origin: CanonicalOrigin;
  readonly channel: ExecutorChannel;
  readonly method: MethodFor[ExecutorChannel];
  readonly path: string;
}) => { readonly entry: OperationRegistryEntry; readonly resources: readonly (readonly [string, string])[] } | null;

/**
 * `extractBodyResources` — pure (R5). The matched entry's body slots read from
 * the canonical body bytes; `malformed` when any slot cannot be read.
 */
export type ExtractBodyResources = (input: {
  readonly slots: readonly BodyResourceSlot[];
  readonly body: Uint8Array;
}) => { readonly ok: true; readonly resources: readonly (readonly [string, string])[] } | { readonly ok: false; readonly reason: 'malformed' };

/**
 * `deriveGitResources` — pure (R11). The matched relay entry's derived
 * resources parsed from a `git-receive-pack` request body's pkt-line command
 * list; `malformed` for any other method or an unparseable command list,
 * `flag_injection` for a ref name `restrictGitOperation` would refuse.
 */
export type DeriveGitResources = (input: {
  readonly method: RelayMethod;
  readonly rules: readonly DerivedResourceRule[];
  readonly body: Uint8Array;
}) =>
  | { readonly ok: true; readonly resources: readonly (readonly [string, string])[] }
  | { readonly ok: false; readonly reason: 'malformed' | 'flag_injection' };

/**
 * `canonicalizeRequest` — pure, total. `providerSlug` comes from the account
 * row the authority read, never from the tool layer; `operation`, the
 * declared headers and every resource come from the matched registry entry
 * over the ACTUAL origin, path, body and (relay) git request (R5, R7, R11).
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
