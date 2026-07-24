/**
 * The MACHINE BINDING prompt block — shared by the chat route (a human's turn
 * in a machine pane) and the headless session engine (a dispatched turn in the
 * same pane, with no client attached).
 *
 * It lives here rather than in either caller because the string is a FROZEN
 * CONTRACT: it names `list_sessions` as the one discovery tool and states that
 * `switch_machine`/`list_machines` are gone. A dispatched run that described a
 * different tool surface than the human's run on the same session would be a
 * silent behavioural fork in one conversation's own history.
 *
 * A bound conversation lives at ONE node of a machine tree and may address any
 * node BENEATH it (the derived handle set — `deriveMachinePaneBinding`), so the
 * prompt states three things: which node this is, which nodes it can reach with
 * `target`, and where to discover them. Discovery is deliberately delegated to
 * `list_sessions` rather than enumerated here: the set can change mid-run (a
 * branch spawned, a Sprite torn down) and a stale inline listing would read as
 * authoritative.
 *
 * `switch_machine`/`list_machines` are dropped from the tool set for bound
 * conversations (filterToolsForMachineBinding); the prompt says so rather than
 * leaving the model to discover it by calling one.
 */

import type { MachineNodeHandleSet } from '@pagespace/lib/services/machines/machine-pane-binding';
import { isMainBranchName } from '@pagespace/lib/services/sandbox/machine-diff-scope';

export function buildMachineBindingPrompt(binding: MachineNodeHandleSet): string {
  const { self, handles } = binding;
  const where =
    self.kind === 'branch'
      ? `branch "${self.branch}" of project "${self.project}"`
      : self.kind === 'project'
        ? `project "${self.project}"`
        : 'the machine root';
  const beneath = handles.filter((handle) => handle !== self);
  const reachable =
    beneath.length === 0
      ? '• Nothing lies beneath this node — every tool call runs here.'
      : `• You can also address nodes BENEATH this one by passing target to bash/readFile/writeFile/editFile and the git/gh tools — e.g. target: { project: "my-repo" } or target: { project: "my-repo", branch: "my-branch" }. Omit target to run at your own node. Currently reachable: ${beneath
          .map((handle) =>
            handle.kind === 'branch'
              ? `project "${handle.project}" / branch: "${handle.branch}"`
              : `project "${handle.project}"`,
          )
          .join(', ')}.`;
  // A project can have a genuinely LIVE branch worktree named "main"/"master"
  // (spawnBranch doesn't reserve these names) — when one is actually in the
  // reachable list, targeting it by name is correct, so the blanket "never"
  // below would be actively wrong advice for that case. Only warn when no
  // such live branch is listed (Codex review, PR #2232): the reachable list
  // itself is always the source of truth, this is just interpreting it.
  const hasLiveDefaultBranch = beneath.some((h) => h.kind === 'branch' && h.branch !== undefined && isMainBranchName(h.branch));
  // The warning's advice ("run at a project via target: { project }") is
  // UNREACHABLE from a branch-scoped self: deriveMachinePaneBinding gives a
  // branch pane handles: [self] only — no project handle in scope, ever,
  // regardless of what this branch happens to be named. Recommending it
  // would just trade one target_not_in_set for another (Codex review, third
  // pass) — so the whole warning is skipped for a branch self, not only when
  // that branch happens to be named main/master.
  const branchWarning =
    self.kind === 'branch' || hasLiveDefaultBranch
      ? ''
      : '\n• "branch" here is NOT "whatever git branch a project happens to be on" — it only names a separately created branch worktree (none is currently listed above). A project\'s own default checkout has no branch of its own to address: to run at a project, pass target: { project } alone, not target: { project, branch: "main" } — there is no such branch here.';
  return (
    `\n\nMACHINE BINDING (this conversation)` +
    `\n• This conversation is bound to machine "${self.machineId}" at ${where} — code-execution tools (bash, readFile, writeFile, editFile, git/gh) operate from working directory: ${self.cwd}` +
    `\n${reachable}` +
    branchWarning +
    `\n• A node outside this scope (a sibling project or branch, another machine) is not addressable — such a target is refused.` +
    `\n• Call list_sessions to see the nodes in this scope and what is running in them; it is the only discovery tool for this machine.` +
    `\n• switch_machine and list_machines are unavailable — this conversation cannot leave its bound machine`
  );
}
