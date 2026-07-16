/**
 * The composed sandbox git/gh tool table. Row order matches the original
 * factory's return order (git repo/worktree/history/remote, then gh pr/actions/
 * issues/repos-search) so SANDBOX_GIT_TOOL_NAMES — derived from these rows in
 * generate-tools.ts — stays stable. Adding a tool is adding a row to one group.
 */
import type { GitToolRow } from './types';
import { REPO_TOOL_ROWS } from './repo';
import { WORKTREE_TOOL_ROWS } from './worktree';
import { HISTORY_TOOL_ROWS } from './history';
import { REMOTE_TOOL_ROWS } from './remote';
import { PR_TOOL_ROWS } from './pr';
import { ACTIONS_TOOL_ROWS } from './actions';
import { ISSUES_TOOL_ROWS } from './issues';
import { REPOS_SEARCH_TOOL_ROWS } from './repos-search';

export const SANDBOX_GIT_TOOL_ROWS: readonly GitToolRow[] = [
  ...REPO_TOOL_ROWS,
  ...WORKTREE_TOOL_ROWS,
  ...HISTORY_TOOL_ROWS,
  ...REMOTE_TOOL_ROWS,
  ...PR_TOOL_ROWS,
  ...ACTIONS_TOOL_ROWS,
  ...ISSUES_TOOL_ROWS,
  ...REPOS_SEARCH_TOOL_ROWS,
];
