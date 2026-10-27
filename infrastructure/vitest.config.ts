import { defineConfig, configDefaults } from 'vitest/config';

/**
 * `infrastructure/` is deliberately NOT a bun workspace (see the root
 * package.json `workspaces` list): it ships compose files, Traefik config,
 * an UPGRADE.md and shell scripts — no JS package, no exports, nothing any
 * app imports. Making it a workspace would put a phantom package into the
 * turbo graph, the knip config and every `--filter` glob for no gain.
 *
 * The consequence, until now, was that its ~15 test files ran in NO job at
 * all. They are invoked directly instead: `bun run test:infra` from the repo
 * root, wired into .github/workflows/ci.yml.
 *
 * `scripts/__tests__/image-runtime.test.ts` is the one exception. It pulls the
 * PUBLISHED ghcr.io images and boots them under docker compose, so it is slow,
 * network-dependent, and tests artifacts of the image pipeline rather than
 * anything in the working tree. It stays out of the default run and keeps its
 * own entry point (`bun run test:infra:runtime`, which sets the env var below).
 */
const includeImageRuntime = process.env.INFRA_IMAGE_RUNTIME === '1';

export default defineConfig({
  test: {
    include: ['scripts/__tests__/**/*.test.ts', '__tests__/**/*.test.ts'],
    exclude: includeImageRuntime
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, 'scripts/__tests__/image-runtime.test.ts'],
    testTimeout: 10_000,
  },
});
