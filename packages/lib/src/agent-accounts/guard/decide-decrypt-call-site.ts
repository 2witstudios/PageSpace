export type DecryptorSpec = {
  readonly module: string;
  readonly names: readonly string[];
  readonly appliesUnder: readonly string[] | null;
};

export type AllowedDecryptSite = {
  readonly importer: string;
  readonly reason: 'plane' | 'migration' | 'legacy_pending_migration';
};

export type DecryptImportEdge = {
  readonly importer: string;
  readonly module: string;
  readonly names: readonly string[] | 'all';
};

export type DecryptCallSiteVerdict =
  | { readonly verdict: 'unrelated' }
  | { readonly verdict: 'allowed'; readonly reason: AllowedDecryptSite['reason'] }
  | { readonly verdict: 'forbidden'; readonly names: readonly string[] };

export function decideDecryptCallSite(_input: {
  readonly edge: DecryptImportEdge;
  readonly decryptors: readonly DecryptorSpec[];
  readonly allowed: readonly AllowedDecryptSite[];
}): DecryptCallSiteVerdict {
  throw new Error('decideDecryptCallSite: not implemented (RED)');
}
