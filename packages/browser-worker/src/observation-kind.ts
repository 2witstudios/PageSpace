/**
 * Everything a browser session can emit that tells a watcher what is on the
 * page. The observation cut (S3 R7) is stated over THIS list: in human
 * control, none of these reaches the agent. A new way of observing the page
 * is a new member here, and `decideObservationRelease`'s exhaustive table
 * refuses to typecheck until someone has decided who may see it.
 *
 * `clipboard` has no producer today and must never gain an agent-facing one;
 * it is listed so that the rule "the agent never gets the clipboard" is a
 * row in a table rather than an absence someone could fill in.
 */
export const OBSERVATION_KINDS = [
  'screenshot',
  'accessibility-snapshot',
  'page-event',
  'tab-list',
  'action-result',
  'clipboard',
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** Who an observation would go to. The live pane is the human's; tool results are the agent's. */
export const OBSERVATION_AUDIENCES = ['agent', 'human'] as const;
export type ObservationAudience = (typeof OBSERVATION_AUDIENCES)[number];

export type ObservationRelease = 'release' | 'suppress';
