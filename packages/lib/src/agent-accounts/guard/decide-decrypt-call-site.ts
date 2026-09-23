/**
 * `decideDecryptCallSite` — whether one import edge reaches a credential
 * decryptor from a place allowed to hold plaintext (ADR 0005 §10.14; threat
 * model Λ2). Pure: the repo-wide guard test extracts every import edge and
 * hands it here with the policy data (`decrypt-guard-policy.ts`).
 *
 * - A decryptor is a named export of a module. `appliesUnder: null` counts it
 *   everywhere (`decryptCredentials`); a list of path prefixes counts it only
 *   there (the raw `decrypt` of `encryption-utils` is also the PII field
 *   primitive, so it is policed only in integration/OAuth paths).
 * - A namespace or dynamic import (`names: 'all'`) imports every decryptor.
 * - An allowlist entry ending in `/` covers its directory; any other entry is
 *   one exact file. `…/migration-evil.ts` is not inside `…/migration/`.
 * - A non-normalized importer (`..`, `.` segments, a leading `/`, a backslash)
 *   is forbidden before any allowlist match, so path spelling cannot reach an
 *   allowed prefix.
 */
export type DecryptorSpec = {
  /** Repo-relative module path without extension, e.g. `packages/lib/src/encryption/encryption-utils`. */
  readonly module: string;
  readonly names: readonly string[];
  /** Repo-relative path prefixes where importing counts; null = everywhere. */
  readonly appliesUnder: readonly string[] | null;
};

export type AllowedDecryptSite = {
  /** A repo-relative file, or a directory ending in `/`. */
  readonly importer: string;
  /**
   * `plane`: inside the credential plane. `migration`: the one-way move into
   * the plane. `legacy_pending_migration`: a call site G3 has not moved yet —
   * the ratchet; each entry is removed when its path moves, never added.
   */
  readonly reason: 'plane' | 'migration' | 'legacy_pending_migration';
};

export type DecryptImportEdge = {
  /** Repo-relative path of the importing file. */
  readonly importer: string;
  /** Repo-relative resolved module path without extension. */
  readonly module: string;
  /** The named imports, or `all` for a namespace / dynamic / require import. */
  readonly names: readonly string[] | 'all';
};

export type DecryptCallSiteVerdict =
  | { readonly verdict: 'unrelated' }
  | { readonly verdict: 'allowed'; readonly reason: AllowedDecryptSite['reason'] }
  | { readonly verdict: 'forbidden'; readonly names: readonly string[] };

const isNormalized = (path: string): boolean =>
  path.length > 0 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every((segment) => segment !== '..' && segment !== '.' && segment !== '');

const covers = (site: AllowedDecryptSite, importer: string): boolean =>
  site.importer.endsWith('/') ? importer.startsWith(site.importer) : importer === site.importer;

export function decideDecryptCallSite({
  edge,
  decryptors,
  allowed,
}: {
  readonly edge: DecryptImportEdge;
  readonly decryptors: readonly DecryptorSpec[];
  readonly allowed: readonly AllowedDecryptSite[];
}): DecryptCallSiteVerdict {
  const names = decryptors
    .filter((spec) => spec.module === edge.module)
    .filter((spec) => spec.appliesUnder === null || spec.appliesUnder.some((prefix) => edge.importer.startsWith(prefix)))
    .flatMap((spec) => (edge.names === 'all' ? spec.names : spec.names.filter((name) => edge.names.includes(name))));
  if (names.length === 0) return { verdict: 'unrelated' };
  if (!isNormalized(edge.importer)) return { verdict: 'forbidden', names };
  const site = allowed.find((candidate) => covers(candidate, edge.importer));
  if (site === undefined) return { verdict: 'forbidden', names };
  return { verdict: 'allowed', reason: site.reason };
}
