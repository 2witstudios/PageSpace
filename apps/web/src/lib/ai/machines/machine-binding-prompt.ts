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
 * A bound conversation lives at ONE node of a machine tree. Its
 * code-execution tools (bash, readFile, writeFile, editFile, git/gh) ALWAYS run
 * at that own node — they do not take a node address. The prompt states which
 * node this is, which other nodes exist beneath it, and where to discover them.
 * Discovery is deliberately delegated to `list_sessions` rather than enumerated
 * here: the set can change mid-run (a branch spawned, a Sprite torn down) and a
 * stale inline listing would read as authoritative.
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
  // Which other nodes exist beneath this one. The code-execution tools no
  // longer take a node address — they always run at THIS node — so this is
  // discovery context (what else is in the family), not an instruction to aim
  // tools elsewhere. Cross-node interaction is the session tools' job; use
  // list_sessions to discover and reach them.
  const beneath = handles.filter((handle) => handle !== self);
  const reachable =
    beneath.length === 0
      ? '• Nothing else lies beneath this node.'
      : `• Other nodes exist beneath this one: ${beneath
          .map((handle) =>
            handle.kind === 'branch'
              ? `project "${handle.project}" / branch: "${handle.branch}"`
              : `project "${handle.project}"`,
          )
          .join(', ')}. Your code-execution tools always run at YOUR node; use list_sessions and the session tools to see and interact with the others.`;
  return (
    `\n\nMACHINE BINDING (this conversation)` +
    `\n• This conversation is bound to machine "${self.machineId}" at ${where} — code-execution tools (bash, readFile, writeFile, editFile, git/gh) operate from working directory: ${self.cwd}` +
    `\n${reachable}` +
    `\n• Call list_sessions to see the nodes in this scope and what is running in them; it is the only discovery tool for this machine.` +
    `\n• switch_machine and list_machines are unavailable — this conversation cannot leave its bound machine`
  );
}
