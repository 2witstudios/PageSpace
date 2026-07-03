/**
 * run() — the composition root. Takes argv/env/stdout/stderr/credentialStore
 * as plain injected values (no `process.*` reference anywhere in this file)
 * and returns an exit code; `bin.ts` is the only caller that touches the
 * real process.
 */
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import { parseArgv } from './argv/parse.js';
import { helpHandler } from './commands/help.js';
import { versionHandler } from './commands/version.js';
import { resolveConfig } from './config/resolve.js';
import type { CredentialStore } from './credential-store.js';
import { EXIT_USAGE_ERROR, type ExitCode } from './exit-codes.js';
import type { HandlerContext, OutputSink } from './handler-context.js';
import { resolveRoute, type Route } from './router/router.js';

export interface RunDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
  readonly credentialStore: CredentialStore;
}

const ROUTES: readonly Route[] = [{ path: ['help'], handler: helpHandler }];

export async function run(deps: RunDependencies): Promise<ExitCode> {
  const parsed = parseArgv(deps.argv);
  if (parsed.kind === 'usage-error') {
    deps.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const profile = await deps.credentialStore.read();
  const config = resolveConfig({
    flags: { host: parsed.flags.host, token: parsed.flags.token },
    env: { PAGESPACE_TOKEN: deps.env.PAGESPACE_TOKEN, PAGESPACE_API_URL: deps.env.PAGESPACE_API_URL },
    profile,
  });

  const ctx: HandlerContext = {
    sdk: new PageSpaceClient({ baseUrl: config.host, auth: new StaticTokenProvider(config.token ?? '') }),
    stdout: deps.stdout,
    stderr: deps.stderr,
    env: deps.env,
    credentialStore: deps.credentialStore,
  };

  if (parsed.flags.version) {
    return versionHandler(ctx, parsed);
  }
  if (parsed.flags.help && parsed.args.length === 0) {
    return helpHandler(ctx, parsed);
  }

  const resolution = resolveRoute(ROUTES, parsed.args);
  if (resolution.kind === 'usage-error') {
    deps.stderr.write(`${resolution.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  return resolution.route.handler(ctx, { ...parsed, args: resolution.rest });
}
