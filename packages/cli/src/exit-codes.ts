/** Fixed CLI exit code contract (Phase 4 task 1) — every future command tests against this. */
export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;

export type ExitCode = typeof EXIT_SUCCESS | typeof EXIT_RUNTIME_ERROR | typeof EXIT_USAGE_ERROR;
