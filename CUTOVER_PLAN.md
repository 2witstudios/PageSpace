# GDPR PII Encryption — Live Call-Site Cutover (dual-lookup edge)

Foundation: PR #1715 (merged, commit e201276dc). Schema columns `users.emailBidx`
(unique) + `security_audit_log.ip_bidx`, migration `0175`, pure crypto core, gated
backfill are all on `master` but **inert**. This PR makes the running app
encryption-aware so the backfill becomes safe to run.

## The edge module — `packages/lib/src/auth/user-repository.ts`

Builds on the existing pure core (`encryption/user-crypto.ts`, `blind-index.ts`,
`field-crypto.ts`). Mirrors the proven `audit-ip-crypto` + `audit-query` wiring.

### Env edges
- `getUserIndexKey(): Buffer | null` — `deriveIndexKey(ENCRYPTION_KEY)` when
  `ENCRYPTION_KEY.length >= 32`, else `null`. `null` ⇒ behaviour byte-identical to
  today (plaintext path, no bidx, no decrypt needed).
- `isPiiCiphertextWriteEnabled(): boolean` — `getUserIndexKey() !== null &&
  process.env.PII_ENCRYPTION_ENABLED === 'true'`. Gates **ciphertext** writes only.

### Lookup (read) — dual-lookup, active whenever a key is configured
- `buildUserEmailMatch(email, key): SQL` — pure. `key` present ⇒
  `or(eq(users.emailBidx, emailLookupBidx(email,key)), eq(users.email, email))`;
  `key` null ⇒ `eq(users.email, email)`.
- `userEmailMatch(email): SQL` — env wrapper over `getUserIndexKey()`. Drop-in for
  any `eq(users.email, x)`, composes inside `and(...)`.
- `buildUserEmailInListMatch(emails, key): SQL` — IN-list variant for calendar sync.

### Write — emailBidx ALWAYS when key present; ciphertext gated by flag
- `buildUserPiiInsert({email,name}): Promise<{email,name,emailBidx?}>` — create path.
- `encryptUserWriteValues<T>(values): Promise<T>` — generic helper for
  `createUser(values)` / `updateUser(fields)` shapes carrying email and/or name;
  recomputes emailBidx iff email present.

### Read projection
- `decryptUserRow<T extends {email?,name?}>(row): Promise<T>` — decrypts in place
  (legacy plaintext passes through); null-safe.
- `decryptUserRows<T>(rows): Promise<T[]>`.
- `findUserByEmail(email): Promise<UserRow|null>` — dual-lookup + decrypt full row.

### Flag semantics / safety invariant
| ENCRYPTION_KEY | PII_ENCRYPTION_ENABLED | read lookup | bidx write | value write |
|---|---|---|---|---|
| absent | — | raw eq (today) | none | plaintext (today) |
| present | false (default) | dual | yes | plaintext (staged) |
| present | true | dual | yes | ciphertext |

Dual-lookup + bidx-write never regress lookups. Raw `email` unique constraint stays
(retiring it is a LATER PR). Email normalization = `lower(trim(email))` everywhere.

## Test matrix (TDD — RED first), `packages/lib/src/auth/__tests__/user-repository.test.ts`
1. `buildUserPiiInsert`: key+flag ⇒ ciphertext + bidx; key only ⇒ plaintext + bidx;
   no key ⇒ plaintext, no bidx.
2. Parity: `buildUserEmailMatch` bidx target == insert emailBidx for same email
   (case/whitespace-insensitive). Proves a ciphertext row is found by bidx.
3. `buildUserEmailMatch` no key ⇒ raw eq only (legacy plaintext row fallback).
4. `decryptUserRow`: ciphertext ⇒ plaintext; legacy plaintext ⇒ unchanged; null safe.
5. `isPiiCiphertextWriteEnabled` truth table.
6. `buildUserEmailInListMatch` bidx-list parity.

## A) Equality-lookup sites → dual-lookup
- [ ] packages/lib/src/auth/passkey-service.ts:378, 754, 858
- [ ] packages/lib/src/auth/account-lockout.ts:79, 188
- [ ] packages/lib/src/auth/oauth-utils.ts:203 (keep sub/email split; email→dual)
- [ ] packages/lib/src/auth/verification-utils.ts:131 (keep id eq; email→dual)
- [ ] apps/web/src/lib/auth/magic-link-adapters.ts:52
- [ ] apps/web/src/lib/repositories/auth-repository.ts:21
- [ ] apps/web/src/lib/repositories/connection-invite-repository.ts:217
- [ ] apps/web/src/lib/repositories/drive-invite-repository.ts:152, 180, 349
- [ ] apps/web/src/lib/repositories/page-invite-repository.ts:285
- [ ] apps/web/src/app/api/account/route.ts:96
- [ ] apps/web/src/app/api/connections/search/route.ts:70
- [ ] apps/web/src/app/api/users/find/route.ts:46
- [ ] apps/web/src/app/api/users/search/route.ts:98
- [ ] apps/web/src/app/api/stripe/webhook/route.ts:463
- [ ] apps/web/src/lib/integrations/google-calendar/sync-service.ts:791 (IN-list)

## B) User CREATE / UPDATE sites → ciphertext + emailBidx
- [ ] apps/web/src/lib/auth/magic-link-adapters.ts:30
- [ ] apps/web/src/lib/repositories/auth-repository.ts:102 (createUser) + :109 (updateUser)
- [ ] packages/lib/src/auth/oauth-utils.ts:289 (create) + :258 (name update) + decrypt returned user
- [ ] packages/lib/src/auth/passkey-service.ts:913 (create, in tx)
- [ ] packages/lib/src/services/validated-service-token.ts:625
- [ ] apps/web/src/app/api/account/route.ts:111 (update email/name)

## C) Projection / display / aggregation sites → decrypt email/name on read
- [ ] apps/web/src/app/api/account/route.ts GET:36, PATCH compare:88, DELETE accountRepository.findById:188
- [ ] apps/web/src/app/api/account/drives-status:73
- [ ] apps/web/src/app/api/activities/actors/route.ts:112,117
- [ ] apps/web/src/app/api/connections/route.ts:62
- [ ] apps/web/src/app/api/connections/search:51,63
- [ ] apps/web/src/app/api/drives/[driveId]/assignees:67,131
- [ ] apps/web/src/app/api/pulse/cron:251,504,539
- [ ] apps/web/src/app/api/pulse/generate:152,374,410
- [ ] apps/web/src/app/api/search/route.ts:360
- [ ] apps/web/src/app/api/users/messageable:144
- [ ] apps/web/src/app/api/users/search:93
- [ ] apps/web/src/lib/ai/tools/activity-tools:416
- [ ] apps/web/src/lib/ai/tools/member-tools:38,125
- [ ] apps/web/src/lib/workflows/calendar-trigger-executor:153
- [ ] packages/lib/src/services/api/permission-management-service:165
- [ ] packages/lib/src/monitoring/monitoring-queries.ts (698,708,729,772,785,849,858,1075,1084)
- [ ] packages/lib/src/compliance/export/gdpr-export.ts:160
- [ ] packages/lib/src/notifications/notifications.ts:104
- [ ] packages/lib/src/services/app-shell-service.ts:65
- [ ] packages/lib/src/services/drive-member-service.ts:219,332

## Docs
- [ ] `docs/security/pii-encryption-design.md`: flag + enable order.
- [ ] Ops note: deploy cutover → verify → run backfill → set
  `PII_ENCRYPTION_CUTOVER_DEPLOYED=true` + `PII_ENCRYPTION_ENABLED=true`.

## Validation
`bun run --filter @pagespace/lib test` · `bun run typecheck` · `bun run lint` green.
