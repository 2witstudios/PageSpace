/** Fixed CLI exit code contract (Phase 4 task 1) — every future command tests against this. */
export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;

/**
 * A remote process's own exit status, passed through as the CLI's (`workspaces
 * exec`). Branded so only `remoteExitCode` can mint one: every other command
 * still speaks the fixed 0/1/2 contract above.
 */
export type RemoteExitCode = number & { readonly __brand: 'RemoteExitCode' };

export type ExitCode = typeof EXIT_SUCCESS | typeof EXIT_RUNTIME_ERROR | typeof EXIT_USAGE_ERROR | RemoteExitCode;

/** Pure: a remote exit status as a process exit code — integers 0..255 pass through, anything else is a runtime error. */
export function remoteExitCode(code: number): ExitCode {
  return Number.isInteger(code) && code >= 0 && code <= 255 ? (code as RemoteExitCode) : EXIT_RUNTIME_ERROR;
}
