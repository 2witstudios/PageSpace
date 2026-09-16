/**
 * Is the agent signup door open for this deployment? (ADR 0005 Decision 11)
 *
 * Cloud and tenant: always (tenant is a cloud topology with billing via the
 * control plane, not an on-prem install). Onprem: only when the operator has
 * set `AGENT_SIGNUP_ENABLED` to exactly `'true'` — billing is off there, so
 * an agent would get unlimited AI, and that must be an explicit opt-in.
 *
 * Pure: the mode and the raw flag are injected; the env-reading edge is the
 * route (`getDeploymentMode()`, `process.env.AGENT_SIGNUP_ENABLED`).
 *
 * @module @pagespace/lib/auth/agent/enabled
 */

import type { DeploymentMode } from '../../deployment-mode';

export interface AgentSignupEnabledInput {
  deploymentMode: DeploymentMode;
  /** Raw `AGENT_SIGNUP_ENABLED` value; `undefined` when unset. */
  envFlag: string | undefined;
}

export function isAgentSignupEnabled(input: AgentSignupEnabledInput): boolean {
  if (input.deploymentMode !== 'onprem') return true;
  return input.envFlag === 'true';
}
