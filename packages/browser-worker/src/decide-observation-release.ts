/**
 * May this observation of the page reach this audience right now? — the
 * observation cut (S3 R7, gate exit metric "event count = 0"), pure.
 *
 * The table below is exhaustive over `HumanControlState` × `ObservationKind`
 * × audience, so a new state or a new way of observing the page does not
 * typecheck until someone has written down who may see it.
 *
 * The agent sees the page only in `agent-control`. From the moment a human
 * asks for control (`draining`), through `human-control`, and until a fresh
 * context has replaced the one the human touched (`hydrating`), every kind is
 * suppressed. The worker asks this question when a result is RETURNED, not
 * when the action was admitted: an action admitted a moment before a
 * take-over still returns nothing to the agent.
 *
 * The human's live pane gets pixels, page events and tabs in every state
 * (watching the agent work is the point of the pane) and never the
 * agent-shaped surfaces. Nobody gets the clipboard.
 */
import type { HumanControlState } from './human-control-state.js';
import type { ObservationAudience, ObservationKind, ObservationRelease } from './observation-kind.js';

export type DecideObservationReleaseOptions = {
  readonly mode: HumanControlState;
  readonly kind: ObservationKind;
  readonly audience: ObservationAudience;
};

type ReleaseByKind = Readonly<Record<ObservationKind, ObservationRelease>>;

const AGENT_SEES_THE_PAGE: ReleaseByKind = {
  screenshot: 'release',
  'accessibility-snapshot': 'release',
  'page-event': 'release',
  'tab-list': 'release',
  'action-result': 'release',
  clipboard: 'suppress',
};

const AGENT_CUT_OFF: ReleaseByKind = {
  screenshot: 'suppress',
  'accessibility-snapshot': 'suppress',
  'page-event': 'suppress',
  'tab-list': 'suppress',
  'action-result': 'suppress',
  clipboard: 'suppress',
};

const HUMAN_PANE: ReleaseByKind = {
  screenshot: 'release',
  'accessibility-snapshot': 'suppress',
  'page-event': 'release',
  'tab-list': 'release',
  'action-result': 'suppress',
  clipboard: 'suppress',
};

const RELEASE_TABLE: Readonly<Record<ObservationAudience, Readonly<Record<HumanControlState, ReleaseByKind>>>> = {
  agent: {
    'agent-control': AGENT_SEES_THE_PAGE,
    draining: AGENT_CUT_OFF,
    'human-control': AGENT_CUT_OFF,
    hydrating: AGENT_CUT_OFF,
  },
  human: {
    'agent-control': HUMAN_PANE,
    draining: HUMAN_PANE,
    'human-control': HUMAN_PANE,
    hydrating: HUMAN_PANE,
  },
};

export const decideObservationRelease = ({ mode, kind, audience }: DecideObservationReleaseOptions): ObservationRelease =>
  RELEASE_TABLE[audience][mode][kind];
