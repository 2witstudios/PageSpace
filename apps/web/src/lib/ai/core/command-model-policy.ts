/**
 * POL-8 for Universal Commands: a command's entry page and its children reach a run's model only when their org
 * allows the model the run RESOLVED — the same tool-boundary check read_page gets (actor-permissions). Resolution
 * (command-resolver.ts) checks only that the sender may view the pages; this judges the model they are sent to.
 */
import { pageReadableByModel, type ModelRunFields } from '../tools/actor-permissions';
import { buildCommandPromptSection, type CommandExecutionPlan } from './command-processor';

async function planReadableByModel(plan: CommandExecutionPlan, run: ModelRunFields): Promise<CommandExecutionPlan> {
  if (plan.kind === 'skip' || plan.injection.entryPage === null) return plan;
  const { injection } = plan;
  const { entryPage } = plan.injection;
  // An entry page the model may not read skips the command exactly like any other no-access page.
  if (!(await pageReadableByModel(run, entryPage.id))) {
    return { kind: 'skip', commandId: injection.commandId, label: injection.label, reason: 'no_access' };
  }
  const readable = await Promise.all(injection.children.map((child) => pageReadableByModel(run, child.id)));
  return { ...plan, injection: { ...injection, children: injection.children.filter((_, i) => readable[i]) } };
}

/** The plans a run's model may receive, and the prompt section built from exactly those. */
export async function commandsForModel(
  plans: CommandExecutionPlan[],
  run: ModelRunFields,
): Promise<{ plans: CommandExecutionPlan[]; prompt: string }> {
  const judged = await Promise.all(plans.map((plan) => planReadableByModel(plan, run)));
  return { plans: judged, prompt: buildCommandPromptSection(judged) };
}
