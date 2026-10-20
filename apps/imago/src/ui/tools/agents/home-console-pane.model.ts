import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

/** The colour an environment's status dot is drawn in, as a token name. */
export type EnvDotTone = 'success' | 'warning' | 'faint';

/**
 * An environment's status as the Agents pane words it: the dot's accessible label and its tone.
 * A local env reports its machine's connection, a sprite env its VM state, and an env whose
 * machine has never enrolled says so rather than reading as disconnected.
 */
export function envStatusOf(env: DriveEnvDTO): { readonly label: string; readonly tone: EnvDotTone } {
  if (env.substrate === 'local') {
    if (!env.enrolled) return { label: 'Awaiting enrollment', tone: 'warning' };
    if (env.status === 'connected') return { label: 'Machine connected', tone: 'success' };
    if (env.status === 'connecting') return { label: 'Machine connecting', tone: 'warning' };
    return { label: 'Machine not connected', tone: 'faint' };
  }
  if (env.status === 'running') return { label: 'Environment running', tone: 'success' };
  if (env.status === 'stopped') return { label: 'Environment stopped', tone: 'warning' };
  return { label: 'Environment not started yet', tone: 'faint' };
}
