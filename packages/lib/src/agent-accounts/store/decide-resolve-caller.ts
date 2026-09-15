/**
 * `decideResolveCaller` — the runtime re-check of `ResolvableBy<C>` (ADR
 * 0005 §4.2, §8 F1/F2/F2a). The TYPE already stops most call sites at
 * compile time; this is the adapter's own gate for the values that reach it
 * anyway (a channel/kind pair assembled at runtime, a `@ts-expect-error`
 * escape hatch, a caller outside this package's type checking). `password`
 * is the browser-fill executor's alone; `session` reaches `http-executor`
 * only through the audited `sessionHttp: true` exception
 * (`resolveSessionOverHttp`), never through the ordinary `resolve` gate.
 */
import type { AccountKind } from '@pagespace/db/schema/agent-accounts';
import type { PresenterChannel } from '../grant';

export type ResolveCallerDecision = { readonly ok: true } | { readonly ok: false; readonly reason: 'kind_not_resolvable' };

export type DecideResolveCaller = (input: {
  readonly aud: PresenterChannel;
  readonly kind: AccountKind;
  /** Only meaningful for `aud: 'http-executor'` and `kind: 'session'` (`resolveSessionOverHttp`). */
  readonly sessionHttp?: boolean;
}) => ResolveCallerDecision;

const DENY: ResolveCallerDecision = { ok: false, reason: 'kind_not_resolvable' };
const ALLOW: ResolveCallerDecision = { ok: true };

export const decideResolveCaller: DecideResolveCaller = ({ aud, kind, sessionHttp }) => {
  switch (aud) {
    case 'refresh-worker':
      return kind === 'oauth2' ? ALLOW : DENY;
    case 'browser-worker':
      return kind === 'session' || kind === 'password' ? ALLOW : DENY;
    case 'http-executor':
      if (kind === 'session') return sessionHttp === true ? ALLOW : DENY;
      return kind === 'api_key' || kind === 'bearer' || kind === 'oauth2' ? ALLOW : DENY;
    case 'relay-runner':
      return kind === 'api_key' || kind === 'bearer' || kind === 'oauth2' ? ALLOW : DENY;
    default:
      return DENY;
  }
};
