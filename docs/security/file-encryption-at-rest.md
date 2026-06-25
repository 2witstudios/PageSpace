# File Storage Encryption at Rest (GDPR S4:F2 / #966 + S4:F9 / #973)

## Mechanism

`apps/processor/src/cache/envelope-crypto.ts` provides AES-256-GCM envelope
encryption for stored object bytes. Each object gets a per-object random salt
(→ scrypt-derived data key) and IV; the output is self-describing:

```
[ MAGIC "PSE1"(4) | salt(32) | iv(12) | authTag(16) | ciphertext ]
```

The MAGIC prefix lets reads transparently detect and decrypt envelopes, so
legacy plaintext objects — and objects written while encryption was enabled but
later disabled — keep reading correctly (`maybeDecryptBuffer`).

`ContentStore` (`content-store.ts`) applies the codec at its PUT/GET edges. The
content-address hash is always computed over **plaintext**, so dedup and
integrity checks are stable regardless of at-rest encryption.

## The presigned-URL constraint (why originals default to OFF)

Originals and browser-rendered cache presets (thumbnails, image variants) are
delivered to the browser via **presigned S3 URLs** that point the client
*directly at object storage* (`apps/web/src/lib/presigned-url.ts`). The browser
cannot decrypt an application-layer envelope, so encrypting those objects while
they are served via presigned URLs would break delivery.

Therefore:

- **Originals + binary cache presets** are encrypted only when
  `FILE_ENCRYPTION_ENABLED=true` (**default OFF**). Cloud relies on Tigris/infra
  disk encryption and keeps presigned delivery. Onprem/tenant deployments that
  lack infra disk encryption can opt in — but enabling it **requires switching
  file delivery to a server-side decrypt-proxy** (serve through the processor's
  `serve.ts`, which decrypts, instead of presigned URLs). That delivery change is
  the tracked follow-up that must land before flipping the flag in production.

- **Server-side-only text caches** (`extracted-text.txt`, `ocr-text.txt`) are
  encrypted **whenever `ENCRYPTION_KEY` is set, regardless of the flag**, because
  they are never browser-presigned — they are consumed/served server-side. See
  `TEXT_PRESETS` in `content-store.ts`.

## Extracted document text (#973)

Extracted text is PII. The ingest pipeline persists it to the **database** (for
search) via the worker return value (`setPageCompleted`); the object-store cache
copy is redundant. Per `extracted-text-policy.ts`:

- The cache copy is written **only when an encryption key is available** (so it is
  encrypted at rest). With no key, the plaintext write is **skipped** — never
  stored unencrypted — and the text is still returned for DB-backed search.
- GDPR Art 17 erasure: `ContentStore.deleteCache` deletes the entire
  `cache/<hash>/` prefix, purging extracted/OCR text when a file is deleted.
- Indefinite retention (Art 5(1)(e)): object-store **lifecycle TTL** on the
  `cache/` prefix is an infra requirement tracked in PageSpace-Deploy alongside
  #956; `cleanupOldCache` is intentionally a no-op (TTL handled by the bucket).

## Metadata

`metadata.json` sidecar objects (originalName + tenant/drive/user IDs) are not
yet enveloped — they are parsed server-side for access control. Encrypting them
(decrypt-before-parse at every read site) is a tracked follow-up; the headline
finding (file content bytes + extracted text) is covered here.

## Verification

- `apps/processor/src/cache/__tests__/envelope-crypto.test.ts` — codec round-trip,
  tamper-fail-closed, policy passthrough.
- `apps/processor/src/cache/__tests__/content-store-encryption.test.ts` — originals
  encrypted under the flag, text caches always encrypted, legacy plaintext reads.
- `apps/processor/src/workers/__tests__/extracted-text-policy.test.ts` and
  `text-extractor.test.ts` — no plaintext PII persisted without a key.
