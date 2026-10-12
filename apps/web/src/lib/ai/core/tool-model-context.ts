import type { ProviderResult } from './provider-factory';

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
export function toolModelContext(resolved: Pick<ProviderResult, 'provider' | 'modelName'>): ToolModelContext {
  return { aiProvider: resolved.provider, aiModel: resolved.modelName, runsModel: true };
}
