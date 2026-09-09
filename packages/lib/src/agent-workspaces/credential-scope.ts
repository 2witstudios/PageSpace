/**
 * THE credential drive-ceiling rule, in one place.
 *
 * Every other access rule around agent workspaces asks about the USER: which
 * drives they belong to, which workspaces they own, which threads were shared
 * with them. A drive-scoped MCP/API token is NOT its user — it is confined to a
 * subset of that user's drives — so a resource outside that subset must read as
 * nonexistent to it however freely its owner could reach the same thing.
 *
 * Pure and single-sourced ON PURPOSE. This rule is applied at seven call sites
 * across two layers (the tool factory and its production runtime): worker verbs,
 * both listings, the bound-workspace detail, the pane grid, the shell verbs, and
 * worker PLACEMENT. It briefly had two implementations — a helper in the tool
 * layer and an inline copy in the placement resolver — which is precisely the
 * shape of the defect this rule exists to fix: the original bug was one
 * authorization question answered in several places, and one of them forgotten.
 * If the rule ever needs to change, it must change once.
 *
 * @param allowedDriveIds The calling credential's ceiling. `[]` means UNSCOPED
 *   (a session, or a full-account token) and admits everything — the same
 *   empty-means-full convention `getAllowedDriveIds` uses.
 * @param driveId The drive the resource lives in. `null` means "no drive, or we
 *   could not resolve one", which a scoped credential is never given the benefit
 *   of: a global-assistant workspace has no drive for a drive-scope to have
 *   granted, and an unresolvable one is unknown rather than permitted.
 */
export function isDriveWithinCredentialScope(
  allowedDriveIds: readonly string[] | undefined,
  driveId: string | null | undefined,
): boolean {
  if (!allowedDriveIds || allowedDriveIds.length === 0) return true;
  return typeof driveId === 'string' && allowedDriveIds.includes(driveId);
}
