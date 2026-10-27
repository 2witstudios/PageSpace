import type { Schedule, Trigger } from "./types";

export const triggers: Trigger[] = [
  {
    name: "task-to-agent",
    description: "A task moved to In Progress spawns an agent grounded on its spec",
    event: "task_status",
    enabled: true,
    steps: [
      { inject: "/red-green {{SPEC}}" },
      {
        inject: "/commit-push-pr",
        gate: { run: "bun run test:unit", expectExit: 0 },
        maxRetries: 3,
      },
    ],
  },
  {
    name: "post-task",
    description: "Polish and ship when an agent finishes its work",
    event: "agent_idle",
    enabled: true,
    steps: [
      { inject: "/simplify" },
      {
        inject: "/review",
        gate: { run: "bun run test:unit", expectExit: 0 },
        maxRetries: 3,
      },
      { inject: "/commit-push-pr" },
    ],
  },
  {
    name: "quality-gate",
    description: "Block commits unless the suite is green",
    event: "pre_commit",
    enabled: true,
    steps: [
      { gate: { run: "bun run typecheck", expectExit: 0 } },
      { gate: { run: "bun run test:unit", expectExit: 0 } },
    ],
  },
  {
    name: "push-guard",
    description: "Knip + lint before anything leaves the workspace",
    event: "pre_push",
    enabled: false,
    steps: [
      { gate: { run: "bun run lint", expectExit: 0 } },
      { gate: { run: "bun run knip:check", expectExit: 0 } },
    ],
  },
];

export const schedules: Schedule[] = [
  {
    name: "overnight-coverage",
    nextRun: "Tonight · 10:30 PM",
    recurrence: "daily",
    mode: "checkout",
    triggerType: "inline-prompt",
    triggerRef: "Raise branch coverage on packages/lib pure modules to 100%",
    enabled: true,
  },
  {
    name: "morning-status",
    nextRun: "Tomorrow · 8:00 AM",
    recurrence: "weekdays",
    mode: "root",
    triggerType: "inline-prompt",
    triggerRef: "Scan overnight commits and summarize fleet state",
    enabled: true,
  },
  {
    name: "nightly-security-review",
    nextRun: "Tonight · 3:00 AM",
    recurrence: "daily",
    mode: "root",
    triggerType: "agent-def",
    triggerRef: "security-review",
    enabled: false,
  },
  {
    name: "friday-dep-sweep",
    nextRun: "Fri · 6:00 PM",
    recurrence: "weekly",
    mode: "checkout",
    triggerType: "swarm-def",
    triggerRef: "dep-sweep",
    enabled: true,
  },
];
