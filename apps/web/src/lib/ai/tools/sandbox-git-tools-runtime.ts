/**
 * Production wiring for the agent git/GitHub tools.
 *
 * Mirrors sandbox-tools-runtime.ts: binds the pure factory (createSandboxGitTools)
 * to the real DB-backed token resolver and the session-anchored sandbox
 * acquisition (shared with bash/readFile/writeFile — one acquire path, one CAS).
 * The @fly/sprites SDK is never statically imported — see the comment in
 * sandbox-tools-runtime.ts for why.
 */

import type { Tool } from 'ai';
import { db } from '@pagespace/db/db';
import { defaultBuildEnv, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import {
  buildRealSandboxRunDeps,
  resolveSandboxActorContext,
  productionSandboxGate,
  ownSandboxTarget,
} from './sandbox-tools-runtime';
import { createSandboxGitTools } from './sandbox-git-tools';

function buildGitSandboxRunDeps(): GitSandboxRunDeps {
  const base: SandboxRunDeps = buildRealSandboxRunDeps();
  return {
    ...base,
    buildEnv: defaultBuildEnv,
    resolveGitHubToken: (userId: string) =>
      resolveGitHubTokenForSandbox({ userId, db }),
  };
}

export function buildGitSandboxTools(): Record<string, Tool> {
  return createSandboxGitTools({
    gitRunDeps: buildGitSandboxRunDeps(),
    // The git toolkit is deliberately NOT addressed: it works on the
    // conversation's own sandbox, so it says that explicitly rather than
    // relying on a fallback — `acquireSandbox` has none (leaf C).
    resolveContext: async (context) => {
      const ctx = await resolveSandboxActorContext(context);
      return 'error' in ctx ? ctx : { ...ctx, environment: ownSandboxTarget(ctx) };
    },
    gate: productionSandboxGate,
  });
}
