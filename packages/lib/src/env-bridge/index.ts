/**
 * `@pagespace/lib/env-bridge` — the PURE decision core of the zero-trust bridge
 * between PageSpace and a user's own machine (a "local environment").
 *
 * Everything under this folder is I/O-free: no sockets, no filesystem, no
 * child processes, no clock, no `node:crypto`. Those are injected by the thin
 * adapters in the CLI daemon and in apps/web. Keeping the boundary here is what
 * makes every security decision exhaustively testable — see each module's
 * `__tests__` for its adversarial matrix.
 */
export * from './grant';
export * from './policy-types';
export * from './intersect-capabilities';
export * from './scrub-env';
export * from './confine-path';
export * from './decide-execution';
export * from './frame-codec';
export * from './bridge-session';
export * from './resolve-timeout';
export * from './decide-bind';
export * from './plan-local-provision';
