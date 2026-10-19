# Throwaway App Store signing chain (TEST ONLY)

A self-signed root → intermediate → leaf chain, generated with openssl for the
apple-verify tests. It mimics the shape of Apple's StoreKit signing chain (ES256,
the intermediate carries OID 1.2.840.113635.100.6.2.1 and the leaf OID
1.2.840.113635.100.6.11.1) so tests can sign JWS payloads and verify them through
Apple's own SignedDataVerifier end to end.

Nothing here is trusted outside the tests: production verification only trusts the
embedded Apple Root CA - G3 (`../../apple-root-certs.ts`). The leaf key is not a secret.
