/** Assistant-surface fixtures: past conversations (History tab) + the fleet activity feed. */

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface MockConversation {
  id: string;
  title: string;
  when: string;
  messages: AssistantMessage[];
}

export interface ActivityEvent {
  id: string;
  kind: "spawn" | "status" | "task" | "gate" | "send";
  when: string;
  text: string;
}

export const conversations: MockConversation[] = [
  {
    id: "conv-webhooks",
    title: "Webhooks epic kickoff",
    when: "2h ago",
    messages: [
      { id: "cw-1", role: "user", text: "Break the webhooks epic into phases and get T5 moving." },
      {
        id: "cw-2",
        role: "assistant",
        text: "Done. The epic's page now holds a Phases list: T4 (dispatch map) is already merged, T5 (after() fan-out → executeWorkflow) has RED/GREEN sub-tasks, T6 (retry bookkeeping) is Blocked behind T5 — same files. I spawned webhooks-fanout on atlas / pagespace @ pu/webhooks-fanout, grounded on T5's spec.",
      },
      { id: "cw-3", role: "user", text: "Make sure it writes the failing test before any implementation." },
      {
        id: "cw-4",
        role: "assistant",
        text: "It did — RED landed and went red before GREEN began; RED is marked Done on the board. GREEN is in progress with a tests gate: every fanOut branch covered before the task can close.",
      },
    ],
  },
  {
    id: "conv-logout",
    title: "Desktop logout triage",
    when: "yesterday",
    messages: [
      { id: "cl-1", role: "user", text: "Desktop keeps logging out after #1932. Triage it." },
      {
        id: "cl-2",
        role: "assistant",
        text: "Reproduced: the refresh path revokes the old token before the device grace window is honored. I filed 'Auth — desktop logout regression' with a RED/GREEN pair and spawned fix-auth-refresh on pu/desktop-logout-fix. It's currently waiting on a call: pursue instant-revoke (#2084) or the grace clobber first?",
      },
    ],
  },
  {
    id: "conv-coverage",
    title: "Overnight coverage loop",
    when: "3d ago",
    messages: [
      { id: "cc-1", role: "user", text: "Set up a nightly loop to push packages/lib pure-module coverage to 100%." },
      {
        id: "cc-2",
        role: "assistant",
        text: "Created the loopable task 'Coverage — packages/lib pure modules to 100%' with an agent-idle workflow: each night it spawns a session that iterates until the coverage ratchet exits 0. Three iterations so far; the ratchet is closing.",
      },
    ],
  },
];

export const activityFeed: ActivityEvent[] = [
  { id: "ev-1", kind: "status", when: "12s", text: "webhooks-fanout: 214 tests passing, 3 to go on GREEN — fanOut" },
  { id: "ev-2", kind: "send", when: "40s", text: "point-guard nudged fix-auth-refresh with the failing vitest output" },
  { id: "ev-3", kind: "gate", when: "9m", text: "fix-auth-refresh went idle — waiting on a human call (instant-revoke vs grace clobber)" },
  { id: "ev-4", kind: "task", when: "26m", text: "Extract — SheetToolbar moved to Done (1/3 on SheetView — decomposition)" },
  { id: "ev-5", kind: "spawn", when: "42m", text: "Spawned webhooks-fanout on atlas / pagespace @ pu/webhooks-fanout (grounded on T5)" },
  { id: "ev-6", kind: "status", when: "1h", text: "hunt-flaky-race broke: exit 137 (OOM) bisecting AiChatView under --repeat 200" },
  { id: "ev-7", kind: "task", when: "2h", text: "RED — failing test: one workflow per trigger row moved to Done" },
  { id: "ev-8", kind: "gate", when: "3h", text: "T6 — retry bookkeeping blocked: gated until T5 merges (same files)" },
  { id: "ev-9", kind: "spawn", when: "3h", text: "point-guard session started (root scope)" },
  { id: "ev-10", kind: "status", when: "5h", text: "cli-reference-docs benched — checkout preserved on orbit" },
];
