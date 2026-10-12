import type { ProviderResult } from './provider-factory';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, resolveProviderModel } from './ai-providers-config';

/** A run's resolved provider and model, as the provider factory names them. */
export type AgentRunModel = Pick<ProviderResult, 'provider' | 'modelName'>;

/** What a model run's tool context carries about the model it runs (see toolModelContext). */
export interface ToolModelContext {
  aiProvider: string;
  aiModel: string;
  runsModel: true;
}

/**
 * POL-8: the model a run's tools are judged by — the provider and model the provider factory RESOLVED for the run (an
 * agent with no model is the default it fell back to), never a raw agent setting or the caller's. Marked as a model
 * run, so a context that loses the pair is refused at the tool boundary (actor-permissions.ts) rather than passed.
 * Every tool context built for a model run takes its model from here.
 */
export function toolModelContext(resolved: AgentRunModel): ToolModelContext {
  return { aiProvider: resolved.provider, aiModel: resolved.modelName, runsModel: true };
}

/**
 * The pair an agent's run resolves, for a caller that must judge it before the run builds its provider (a channel
 * mention injecting commands into ask_agent): the agent's own pair, else the default — ask_agent's selection — through
 * the provider factory's own resolver, so it is the pair the factory then runs.
 */
export function agentRunModel(agent: { aiProvider: string | null; aiModel: string | null }): AgentRunModel {
  const { provider, model } = resolveProviderModel(agent.aiProvider || DEFAULT_PROVIDER, agent.aiModel || DEFAULT_MODEL);
  return { provider, modelName: model };
}
