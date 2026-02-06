# Review Vector: Encryption at Rest

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/encryption/**`, `packages/lib/src/auth/**`
**Level**: service

## Context
Sensitive data including passwords and potentially other secrets are encrypted or hashed before storage using the shared encryption package alongside bcryptjs for password hashing. Review the encryption algorithm choices, key management practices, and whether encryption keys are hardcoded, derived, or loaded from secure storage. Examine password hashing cost factors and whether the implementation protects against hash length extension or other algorithm-specific attacks.
