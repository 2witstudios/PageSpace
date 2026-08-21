import { toast } from 'sonner';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

/**
 * What a caller should do with the surface it wrote from, after an environment
 * write.
 *
 * `'retry'` is reserved for the ONE refusal the user can fix without leaving
 * the form: a name already taken in this drive. Every other failure — a plan's
 * environment ceiling, a role that turned out not to be enough, the network —
 * is toasted and the form closes, because retyping the name would not change
 * the answer.
 *
 * It lives here rather than beside either caller because BOTH write
 * environments now: the spawn palette creates them and the sidebar row renames
 * them, and the 409-is-retryable rule is the same rule in both places.
 */
export type DriveEnvWriteOutcome = 'done' | 'retry';

export function reportDriveEnvWriteFailure(error: unknown, fallbackTitle: string): DriveEnvWriteOutcome {
  const description = error instanceof Error ? error.message : 'Please try again.';
  const nameTaken = error instanceof ApiRequestError && error.status === 409;
  toast.error(nameTaken ? 'That name is already used in this drive' : fallbackTitle, {
    description: nameTaken ? 'Environment names are unique within a drive.' : description,
  });
  return nameTaken ? 'retry' : 'done';
}
