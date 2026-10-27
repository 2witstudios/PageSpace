/**
 * Pure authorization decision for page restore (security finding H1).
 *
 * The restore endpoint historically performed NO resource (delete) authorization:
 * it authenticated the caller and checked only MCP token scope — which is a no-op
 * for session auth (sessions get full access) — then restored the page. Any
 * authenticated user could restore any trashed page in any drive (IDOR).
 *
 * This module isolates the security DECISION into a pure, side-effect-free
 * function. The route shell resolves the facts (await params, authenticate,
 * look up delete permission and MCP token scope) and then calls this function.
 * Keeping the decision pure makes it deterministic and exhaustively testable.
 */

export interface RestoreAuthFacts {
  /**
   * Whether the caller has delete/manage permission on the target page.
   * Resolved via the same guard the sibling trash endpoint uses —
   * `canUserDeletePage(userId, pageId)`. Owner/admin/editor → true;
   * viewer/non-member → false.
   */
  canDelete: boolean;
  /**
   * Whether the caller's token is in scope for the page's drive.
   * Session auth always has full scope (true). A scoped MCP token is only in
   * scope when the page's drive is in its allow-list. An out-of-scope MCP token
   * must be denied regardless of the underlying user's delete permission.
   */
  withinTokenScope: boolean;
}

/**
 * Decide whether a caller may restore a trashed page.
 *
 * Both conditions must hold:
 *  - the caller's token is in scope for the page's drive, AND
 *  - the caller has delete/manage permission on the page.
 */
export function canRestorePage(facts: RestoreAuthFacts): boolean {
  return facts.withinTokenScope && facts.canDelete;
}
