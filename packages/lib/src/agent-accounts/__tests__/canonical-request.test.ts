import { describe, it } from 'vitest';

// ADR 0004 §3 + §8.13 — RED at G1b before canonicalize-request.ts / digest-request.ts exist.

describe('canonicalizeRequest refusals (ADR 0004 F18)', () => {
  it.todo('given a URL with userinfo, should refuse with userinfo_present');
  it.todo('given a wildcard host, should refuse with wildcard_host');
  it.todo('given an IP-literal host (v4 or v6, incl. decimal/hex encodings), should refuse with ip_literal_host');
  it.todo('given an http:// URL, should refuse with scheme_not_https');
  it.todo('given an authorization, cookie, host, proxy-* or x-forwarded-* header supplied by the caller, should refuse with reserved_header (never strip)');
  it.todo('given a path containing .. or a NUL after one percent-decode, should refuse with path_traversal / path_control_char');
  it.todo('given a method outside the channel closed set, should refuse with method_not_allowed');
  it.todo('given an admitted header (accept, content-type or a declared header) whose VALUE carries CR, LF or another control character, should refuse with malformed (a name-only check lets CRLF smuggle authorization:) [0004 §8.26]');
  it.todo('given a caller-supplied content-length that disagrees with the body bytes, should refuse with malformed [0004 §8.26]');
});

describe('canonicalizeRequest normalization', () => {
  it.todo('given a mixed-case IDNA host, should lowercase and IDNA→ASCII it');
  it.todo('given an https URL without a port, should write :443 explicitly');
  it.todo('given query and header maps in any order, should emit sorted pairs');
  it.todo('given only projected + declared headers, should drop every other header from the projection');
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
  it.todo('given the same canonical request and operation {class,name} differing, should produce different digests (op discriminator)');
});

describe('renderApprovalSubject (ASI06)', () => {
  it.todo('given a canonical request, should render the subject from it alone — no field sourced from model text, page body or summary');
  it.todo('given a canonical request with query force=true&recursive=1, should render subject.query equal to canonical.query [0004 §8.29; G1a review H5]');
  it.todo('given projected and declared headers, should render subject.headerNames as their sorted names and JSON.stringify(subject) should contain no header value [0004 §8.29]');
});
