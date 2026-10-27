/**
 * Which operation classes a bounded `always` policy may ever cover (ADR 0004
 * §3.4, F15). `irreversible` and `privilege` need a concrete human decision
 * per digest, every time; `unknown` may be covered only when the human
 * explicitly accepted the generic capability by exact name (never by
 * wildcard — `decideApproval` enforces the name rule). One `Record` over the
 * union so an added class must be classified here or typecheck fails.
 */
import type { AlwaysAllowedByClass } from './approval';

export const ALWAYS_ALLOWED_BY_CLASS: AlwaysAllowedByClass = {
  read: true,
  write: true,
  irreversible: false,
  privilege: false,
  unknown: true,
};
