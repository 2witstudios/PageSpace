import { describe, it } from 'vitest';

// ADR 0004 §3 + §8.13 — RED at G1b before canonicalize-request.ts / digest-request.ts exist.

describe('canonicalizeRequest refusals (ADR 0004 F18)', () => {
  it.todo('given a URL with userinfo, should refuse with userinfo_present');
  it.todo('given a wildcard host, should refuse with wildcard_host');
  it.todo('given an IP-literal host (v4 or v6, incl. decimal/hex encodings), should refuse with ip_literal_host');
  it.todo('given an http:// URL, should refuse with scheme_not_https');
  it.todo('given an authorization, cookie, host, proxy-* or x-forwarded-* header supplied by the caller, should refuse with reserved_header (never strip)');
  it.todo('given a path containing .. or a NUL in its decoded check-only copy (e.g. /x/%2e%2e/y), should refuse with path_traversal / path_control_char');
  it.todo('given a method outside the channel closed set, should refuse with method_not_allowed');
  it.todo('given an admitted header (accept, content-type or a declared header) whose VALUE carries CR, LF or another control character, should refuse with malformed (a name-only check lets CRLF smuggle authorization:) [0004 §8.26]');
  it.todo('given a caller-supplied content-length that disagrees with the body bytes, should refuse with malformed [0004 §8.26]');
});

describe('operation is derived, never declared (ADR 0004 §3.4 amendment, §8.30; G1a review M1)', () => {
  it.todo('given CanonicalRequestInput, should have no operation and no declaredHeaders key (type-level test)');
  it.todo('given a github registry entry PUT /repos/{owner}/{repo}/pulls/{number}/merge → irreversible merge_pr and a request to PUT /repos/a/b/pulls/7/merge, should set canonical.operation to merge_pr / irreversible');
  it.todo('given a DELETE to a path no registry entry matches, should set canonical.operation to unknown / generic_request, never read');
  it.todo('given providerSlug null (from the account row), should not match a github entry for the same method and path');
  it.todo('given a header declared only by a registry entry the request does not match, should drop it from the projection');
  it.todo('given a registry with two entries matching the same provider, channel, method and path, should be refused at registry load, never resolved by order');
});

describe('canonicalizeRequest normalization', () => {
  it.todo('given a mixed-case IDNA host, should lowercase and IDNA→ASCII it');
  it.todo('given an https URL without a port, should write :443 explicitly');
  it.todo('given query and header maps in any order, should emit sorted pairs');
  it.todo('given only projected + registry-declared headers, should drop every other header from the projection');
  it.todo('given an empty body, should record the SHA-256 of zero bytes, never null');
  it.todo('given a valid input, should round-trip: canonicalize ∘ canonicalize is the identity [0004 §8.13]');
  it.todo('given a round-trip input built VERBATIM (never re-encoded by the test helper), should still be the identity [0004 §8.26]');
  it.todo('given a query escape in lower-case hex or an escaped unreserved character, should upper-case the hex and unescape only the RFC 3986 unreserved set [0004 §8.26]');
  it.todo('given a path segment carrying an encoded slash (%2F), should keep it encoded so it never becomes a segment boundary [0004 §8.26]');
  it.todo('given a body with and without a correct explicit content-length, should project the same derived content-length [0004 §8.26]');
});

describe('digestRequest', () => {
  it.todo('given two inputs differing only by header order, key order, host case or :443, should produce the same digest');
  it.todo('given two inputs differing in one body byte, should produce different digests');
  it.todo('given queries ?to=a+b vs ?to=a%2Bb, ?q=%2Fsafe vs ?q=/safe, and ?x=a%26b vs ?x=a&b, should produce different digests — the query is normalized, never decoded [0004 §8.26]');
  it.todo('given paths /x/foo;bar vs /x/foo%3Bbar, should produce different digests — the digested path is normalized, never decoded [0004 §3.2 second amendment, §8.26]');
  it.todo('given paths /x/a+b vs /x/a%2Bb, should produce different digests [0004 §8.26]');
  it.todo('given paths /x/u@h vs /x/u%40h, should produce different digests [0004 §8.26]');
  it.todo('given paths /x/k=v vs /x/k%3Dv, should produce different digests [0004 §8.26]');
  it.todo('given a path escape in lower-case hex (/x/%3b) or an escaped unreserved character (/x/%41), should normalize to /x/%3B and /x/A — the same digest as the normalized form [0004 §8.26]');
  it.todo('given the same canonical request and operation {class,name} differing, should produce different digests (op discriminator)');
});

describe('renderApprovalSubject (ASI06)', () => {
  it.todo('given a canonical request, should render the subject from it alone — no field sourced from model text, page body or summary');
  it.todo('given a canonical request with query force=true&recursive=1, should render subject.query equal to canonical.query [0004 §8.29; G1a review H5]');
  it.todo('given projected and declared headers, should render subject.headerNames as their sorted names and JSON.stringify(subject) should contain no header value [0004 §8.29]');
});
