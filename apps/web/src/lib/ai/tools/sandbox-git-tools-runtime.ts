/**
 * Production wiring for the agent git/GitHub tools.
 *
 * Mirrors sandbox-tools-runtime.ts: binds the pure factory (createSandboxGitTools)
 * to the real DB-backed token resolver and Sprites driver. The @fly/sprites SDK is
 * never statically imported — see the comment in sandbox-tools-runtime.ts for why.
 */

import type { Tool } from 'ai';
import { db } from '@pagespace/db/db';
import { defaultBuildEnv, type SandboxRunDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import { gateSandboxToolCall } from '@pagespace/lib/services/sandbox/tool-gate';
import { buildRealSandboxRunDeps, resolveSandboxActorContext, machineDirectory } from './sandbox-tools-runtime';
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
    resolveContext: resolveSandboxActorContext,
    gate: (ctx) =>
      gateSandboxToolCall({
        userId: ctx.userId,
        driveId: ctx.driveId,
        tenantId: ctx.tenantId,
        requestOrigin: ctx.requestOrigin,
        agentPageId: ctx.agentPageId,
        tier: ctx.tier,
      }),
    machines: machineDirectory,
  });
}
