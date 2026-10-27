/**
 * Pure builder + guard for search audit `details` (GDPR #971).
 *
 * Audit details enter the tamper-evident hash chain and are not erasable under
 * Art 17, so user-typed query text must never appear in them. This builder
 * whitelists only non-PII result metadata — it is structurally incapable of
 * emitting the query, regardless of what the caller passes.
 */

export interface SearchAuditInput {
  /** Number of results returned — safe, non-PII. */
  resultCount: number;
  /** Search surface, e.g. 'multi-drive' | 'mentions'. */
  source?: string;
  /** Search type/scope label. */
  searchType?: string;
}

export type SearchAuditDetails = Record<string, string | number>;

/** Construct audit details from a fixed non-PII whitelist. */
export function buildSearchAuditDetails(input: SearchAuditInput): SearchAuditDetails {
  const details: SearchAuditDetails = { resultCount: input.resultCount };
  if (input.source !== undefined) details.source = input.source;
  if (input.searchType !== undefined) details.searchType = input.searchType;
  return details;
}

/**
 * Runtime guard: does any string value in `details` contain `text`? Lets tests
 * (and defensive callers) prove the user query never leaked into the payload.
 */
export function auditDetailsContainText(details: Record<string, unknown>, text: string): boolean {
  if (!text) return false;
  const needle = text.toLowerCase();
  return Object.values(details).some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
  );
}
