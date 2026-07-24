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
  // "branch" only ever names an EXPLICITLY created branch worktree — never
  // "whatever git branch a project's own checkout happens to be on". A model
  // reasoning in ordinary git terms may add branch: "main"/"master" assuming
  // it addresses a project's own state, which is wrong unless that exact
  // pairing happens to be a real, separately created worktree.
  //
  // This used to assert whether such a worktree existed (`hasLiveDefaultBranch`,
  // computed once over the whole reachable set) — four rounds of review (PR
  // #2232) kept finding cases where that single yes/no answer was wrong for
  // SOME part of the set: a live branch under one project said nothing about
  // a different, also-reachable project without one (and machine-root scope
  // can reach many projects, each independently). Rather than track this
  // per-project, the warning is now unconditional whenever self isn't itself
  // a branch — it defers entirely to the "Currently reachable" list above,
  // which is already itemized per project/branch and is the only place this
  // can be answered correctly. No claim here can be wrong for any subset of
  // the set, because it makes no claim about the set's contents at all.
  //
  // Fifth round of review: telling the model "add branch: main/master if
  // that pairing is listed" is itself wrong when the model's actual INTENT
  // is the project's own default checkout — a separately created worktree
  // that happens to be named "main"/"master" is still a DIFFERENT Sprite
  // from the project's default checkout, so following that advice for
  // default-checkout intent routes the call to the wrong worktree, exactly
  // the risk this whole warning exists to prevent. The fix isn't about what
  // is listed at all: default-checkout intent always means target: { project
  // } alone, full stop, regardless of what branch names happen to be
  // reachable. branch is only ever for when the caller specifically means
  // that separate worktree, not as an alternate spelling of "my own checkout".
  //
  // Skipped when self.kind === 'branch': deriveMachinePaneBinding gives a
  // branch pane handles: [self] only — no project handle is EVER in scope
  // from there, so "pass target: { project }" would just trade one denial
  // for another, regardless of what this branch happens to be named.
  const branchWarning =
    self.kind === 'branch'
      ? ''
      : '\n• "branch" here is NOT "whatever git branch a project happens to be on" — it names a separately created branch worktree that runs in its own Sprite, distinct from the project\'s default checkout. To address a project\'s own default checkout, pass target: { project } alone and omit branch — do this even if a branch named "main"/"master" is listed below, since that pairing names a different, separately created worktree, not the project\'s own checkout. Only add branch: "<name>" when you specifically intend to address that separate worktree, and only if the exact project+branch pairing is listed above — otherwise it will be refused.';
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
