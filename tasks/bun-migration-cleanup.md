# Bun Migration Cleanup

Post-migration cleanup items identified during code review of `pu/bun`.

## Requirements

- Given `bun run test:unit` is invoked, should run `apps/web` vitest with its proper config (including the `server-only` stub alias), not with `--config=/dev/null`.
- Given `bun run test:unit` is invoked, should use `bun` consistently — no `npx vitest` invocation.
- Given `bun install` is run, should not execute lifecycle scripts for the `web` workspace package, which has no install scripts and should not appear in `trustedDependencies`.
- Given `signup/page.tsx` validates the `next=` redirect target, should import URL validation utilities from `url-utils` directly rather than through `auth-helpers` (which carries `server-only`), for consistency with `signin/page.tsx`.
- Given vitest imports the `server-only-stub.ts` stub, should expose an empty ES module with no default export, matching the shape of the real `server-only` package.
- Given the webpack externals config in `next.config.ts` handles a non-array existing externals value, should use a proper type cast rather than `as never`.
