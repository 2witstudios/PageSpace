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
});

describe('canonicalizeRequest normalization', () => {
  it.todo('given a mixed-case IDNA host, should lowercase and IDNA→ASCII it');
  it.todo('given an https URL without a port, should write :443 explicitly');
  it.todo('given query and header maps in any order, should emit sorted pairs');
  it.todo('given only projected + declared headers, should drop every other header from the projection');
  it.todo('given an empty body, should record the SHA-256 of zero bytes, never null');
  it.todo('given a valid input, should round-trip: canonicalize ∘ canonicalize is the identity [0004 §8.13]');
});

describe('digestRequest', () => {
  it.todo('given two inputs differing only by header order, key order, host case or :443, should produce the same digest');
  it.todo('given two inputs differing in one body byte, should produce different digests');
  it.todo('given the same canonical request and operation {class,name} differing, should produce different digests (op discriminator)');
});

describe('renderApprovalSubject (ASI06)', () => {
  it.todo('given a canonical request, should render the subject from it alone — no field sourced from model text, page body or summary');
});
