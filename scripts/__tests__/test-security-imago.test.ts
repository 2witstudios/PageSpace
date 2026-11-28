/**
 * Closing review F6 (IMG-10.7): `bun run test:security` must exercise imago's
 * and realtime's trust boundaries locally, not only through ci.yml and
 * security.yml. Pins each registration to its workspace and to a file that
 * exists, so a rename or a dropped line fails here instead of shrinking the
 * suite silently.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const script = readFileSync(join(ROOT, 'scripts/test-security.sh'), 'utf-8');

const WORKSPACE_DIRS: Record<string, string> = {
  web: 'apps/web',
  '@pagespace/lib': 'packages/lib',
  '@pagespace/imago': 'apps/imago',
  realtime: 'apps/realtime',
};

/** Every `run_*suite "name" "filter" "path"` line, as [runner, filter, path]. */
const registrations = [...script.matchAll(/^(run_\w+) "[^"]+" "([^"]+)" "([^"]+)"$/gm)].map(
  ([, runner, filter, path]) => ({ runner, filter, path }),
);

const REQUIRED: Array<{ runner: string; filter: string; path: string }> = [
  { runner: 'run_test_suite', filter: '@pagespace/imago', path: 'src/middleware.test.ts' },
  { runner: 'run_test_suite', filter: '@pagespace/imago', path: 'src/middleware/security-headers.test.ts' },
  { runner: 'run_test_suite', filter: '@pagespace/imago', path: 'src/lib/auth/sign-in-url.test.ts' },
  { runner: 'run_test_suite', filter: '@pagespace/imago', path: 'src/lib/auth/get-viewer.test.ts' },
  { runner: 'run_integration_test_suite', filter: '@pagespace/imago', path: 'src/lib/auth/get-viewer.integration.test.ts' },
  { runner: 'run_test_suite', filter: '@pagespace/imago', path: 'src/api/client.test.ts' },
  { runner: 'run_test_suite', filter: '@pagespace/imago', path: 'src/realtime/socket-token.test.ts' },
  { runner: 'run_test_suite', filter: 'web', path: 'src/lib/auth/__tests__/resolve-signin-next.test.ts' },
  { runner: 'run_test_suite', filter: 'web', path: 'src/lib/ai/core/__tests__/imago-agent-context.integration.test.ts' },
  { runner: 'run_db_test_suite', filter: '@pagespace/lib', path: 'src/agents/__tests__/imago-drive-access.integration.test.ts' },
  { runner: 'run_db_test_suite', filter: '@pagespace/lib', path: 'src/agents/__tests__/provision-imago-agents.integration.test.ts' },
  { runner: 'run_test_suite', filter: 'web', path: 'src/lib/ai/chat-pipeline/__tests__/imago-agent-reach.security.test.ts' },
  { runner: 'run_test_suite', filter: 'web', path: 'src/lib/ai/chat-pipeline/__tests__/imago-global-parity.integration.test.ts' },
  { runner: 'run_test_suite', filter: 'web', path: 'src/lib/ai/tools/__tests__/actor-permissions.test.ts' },
  { runner: 'run_test_suite', filter: '@pagespace/lib', path: 'src/agent-workspaces/__tests__/decide-workspace-access.test.ts' },
  { runner: 'run_db_test_suite', filter: '@pagespace/lib', path: 'src/compliance/export/__tests__/imago-drive-access-export.integration.test.ts' },
  { runner: 'run_test_suite', filter: 'realtime', path: 'src/__tests__/origin-allowlist.test.ts' },
  { runner: 'run_test_suite', filter: 'realtime', path: 'src/__tests__/origin-validation.test.ts' },
  { runner: 'run_test_suite', filter: 'realtime', path: 'src/__tests__/auth.test.ts' },
  { runner: 'run_test_suite', filter: 'realtime', path: 'src/__tests__/per-event-auth.test.ts' },
];

describe('scripts/test-security.sh imago and realtime suites', () => {
  it.each(REQUIRED)('should register $path in $filter via $runner', (required) => {
    expect(registrations).toContainEqual(required);
  });

  it.each(REQUIRED)('given $path, should name a file that exists', ({ filter, path }) => {
    expect(existsSync(join(ROOT, WORKSPACE_DIRS[filter], path))).toBe(true);
  });

  it('given the imago integration runner, should call that workspace\'s test:integration script', () => {
    expect(script).toMatch(/run_integration_test_suite\(\) \{[\s\S]*?bun run --filter "\$filter" test:integration -- "\$path"/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'apps/imago/package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:integration']).toBeDefined();
  });
});
