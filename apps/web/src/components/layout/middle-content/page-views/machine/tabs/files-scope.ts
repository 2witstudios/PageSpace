/**
 * Shared vocabulary for what the Files tab is browsing: either the Machine's
 * own root Sprite filesystem (`/workspace`), or a project/branch checkout
 * within it (Machine Files Manager epic, Part A).
 *
 * Lives in `tabs/` rather than `workspace/` because `MachineFileTree` already
 * imports from `../tabs/checkout-states` — same precedent, no import cycle.
 */

export type FilesScope = { kind: 'root' } | { kind: 'branch'; projectName: string; branchName: string };

/**
 * Stable identity for a scope — used as a React key so switching scopes (root
 * to branch, or between branches) remounts rather than reusing stale state.
 *
 * JSON-encoded rather than joined on a separator so that no project/branch
 * name pair can collide with another (a branch name may legally contain
 * `/`), mirroring `branchKey` in FilesTab.tsx. `'root'` is a bare literal
 * that can never equal a `JSON.stringify([...])` result, so root and branch
 * keys can never collide with each other either.
 */
export const filesScopeKey = (scope: FilesScope): string =>
  scope.kind === 'root' ? 'root' : JSON.stringify(['branch', scope.projectName, scope.branchName]);

/**
 * The files route's query params for a given scope — `projectName`/`branchName`
 * only appear for branch scope. The route itself doesn't accept root-scope
 * requests yet (that's a separate epic task landing the GET root-scope
 * support); this helper is forward-declared so FilesTab/MachineFileTree can
 * adopt `FilesScope` in one place once both land, rather than twice.
 */
export const filesScopeSearchParams = (machineId: string, scope: FilesScope): URLSearchParams => {
  const params = new URLSearchParams({ machineId });
  if (scope.kind === 'branch') {
    params.set('projectName', scope.projectName);
    params.set('branchName', scope.branchName);
  }
  return params;
};
