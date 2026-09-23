/**
 * The one canonical union for who controls a browser session (Control Board
 * §7.5 names it: `HumanControlState`).
 *
 *  - `agent-control` — the agent's typed operations run and their results
 *    reach it.
 *  - `draining` — a human asked for control. The agent is already cut off
 *    (nothing it asked for is released to it any more) while its in-flight
 *    and queued operations are cancelled and refused. The human does not act
 *    yet: two principals never drive the same page at once.
 *  - `human-control` — the human drives through the live pane. The agent sees
 *    NOTHING: no screenshot, no accessibility snapshot, no page event, no
 *    tab list, no action result, no clipboard (S3 R7, gate exit metric).
 *  - `hydrating` — the human released control. The context the human typed
 *    into is destroyed and a fresh one started (S3 R9) before the agent gets
 *    anything back; the agent never resumes inside the human's context.
 */
export const HUMAN_CONTROL_STATES = ['agent-control', 'draining', 'human-control', 'hydrating'] as const;
export type HumanControlState = (typeof HUMAN_CONTROL_STATES)[number];

/** Who holds a session in human control. Only that user may release it. */
export type HumanPrincipal = { readonly userId: string };

export type HumanControlMode = {
  readonly state: HumanControlState;
  /** When `state` was entered (epoch ms), from the caller's clock. */
  readonly since: number;
  /** The human who asked for control; `null` exactly in `agent-control`. */
  readonly heldBy: HumanPrincipal | null;
};

export const INITIAL_HUMAN_CONTROL_MODE = (now: number): HumanControlMode => ({ state: 'agent-control', since: now, heldBy: null });
