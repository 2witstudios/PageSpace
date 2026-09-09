import type { Command } from "./types";

/**
 * Drive commands — PageSpace's parameterized reusable prompts. These replace
 * PurePoint's template library; the Spawn dialog reads them directly.
 */
export const commands: Command[] = [
  {
    name: "/code-review",
    description: "Review a branch for quality and security",
    runtime: "codex",
    variables: ["BRANCH", "CONTEXT"],
    body: "Review the code on branch {{BRANCH}} for quality and security.\n{{CONTEXT}}",
  },
  {
    name: "/red-green",
    description: "TDD loop: failing test first, then the minimal green",
    runtime: "claude",
    variables: ["SPEC"],
    body: "Work the spec below RED-first: write the failing test, run it, then implement.\n\n{{SPEC}}",
  },
  {
    name: "/coverage-raise",
    description: "Push a package's branch coverage to the ratchet",
    variables: ["PACKAGE", "TARGET"],
    body: "Raise branch coverage in {{PACKAGE}} to {{TARGET}}. Pure modules get 100%; never delete tests to pass.",
  },
  {
    name: "/converge-pr",
    description: "Land an open PR: rebase, respond to review, re-verify",
    variables: ["PR"],
    body: "Converge PR {{PR}}: fetch base, rebase, resolve review threads, re-run the suite, update the description.",
  },
];
