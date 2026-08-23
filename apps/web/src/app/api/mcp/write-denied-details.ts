/**
 * The `details` line on a 403 from an MCP write path. Shared by
 * `mcp/documents/route.ts` and `mcp/sheets/route.ts` so the two cannot drift —
 * same shape as `auth/mcp-tokens/scope-guard.ts`, which is colocated with its
 * own two callers for the same reason.
 *
 * Issue #2470's complaint was not that a write was refused — a refusal is
 * correct for a view-only grant — but that the refusal named nowhere, so the
 * grant could only be learned one failed write at a time ("We learned by
 * trying writes and watching them fail"). Both halves of the sentence are
 * facts about this exact request rather than a guess: the caller cleared the
 * VIEW gate immediately before reaching the write gate, so it can read this
 * page and cannot write it.
 *
 * Only the `details` field. `error` stays the stable `'Write permission
 * required'` string the security suites pin and clients may branch on.
 *
 * A leaf with NO imports, deliberately. Both callers partially mock
 * `@/lib/auth` in their route suites, and any symbol they take from that
 * barrel is one more thing every mock must remember to provide or the route
 * fails with an opaque 500 instead of the 403 under test — the trap
 * `principal-permissions.ts` documents at `resolveDispatchedPrincipal`, and
 * one this module has no reason to walk into for a string.
 */
export function writeDeniedDetails(operation: string, subject: 'document' | 'sheet'): string {
  return (
    `The '${operation}' operation requires edit access to this ${subject}. This credential can view ` +
    'this page but not edit it. Call tokens.describeSelf with this pageId (CLI: "pagespace keys ' +
    'describe --page <pageId>") for what it can actually do, instead of discovering it one failed ' +
    'write at a time.'
  );
}
