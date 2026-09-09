/**
 * `pagespace env policy [--json]` — print and validate this machine's local
 * policy exactly as `env connect` would load it: same path
 * (`PAGESPACE_ENV_POLICY` or `~/.pagespace/env-policy.json`), same strict
 * parser, same ownership and permission checks. Exit 0 with the policy in
 * force, exit 1 with the reason it would be treated as missing (deny-all).
 */
import { homedir as osHomedir, userInfo } from 'node:os';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../../exit-codes.js';
import type { CommandHandler } from '../../router/router.js';
import { defaultPolicyPath, describePolicyRefusal, describePolicyWarnings, loadMachinePolicy, openPolicyFile, type OpenedPolicyFile } from '../../env-bridge/policy.js';

export interface EnvPolicyHandlerDeps {
  readonly homedir: string;
  readonly uid: number;
  readonly openPolicy: (path: string) => OpenedPolicyFile | null;
}

export function createEnvPolicyHandler(deps: EnvPolicyHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    const path = defaultPolicyPath(ctx.env, deps.homedir);
    const loaded = loadMachinePolicy({ path, uid: deps.uid, open: deps.openPolicy });
    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify({ path, policy: loaded.policy, reason: loaded.reason, digest: loaded.digest })}\n`);
      return loaded.policy === null ? EXIT_RUNTIME_ERROR : EXIT_SUCCESS;
    }
    if (loaded.policy === null) {
      ctx.stderr.write(`${describePolicyRefusal(loaded.reason ?? 'missing', path)}\n`);
      return EXIT_RUNTIME_ERROR;
    }
    const policy = loaded.policy;
    ctx.stdout.write(
      [
        `Policy ${path} (digest ${loaded.digest.slice(0, 16)}) is in force:`,
        `  mode           ${policy.mode}`,
        `  principals     ${policy.principals.join(', ') || '(none - every request is denied principal_not_allowed)'}`,
        `  ops            ${policy.ops.join(', ') || '(none)'}${policy.mode === 'ask' ? ' (pre-approved; anything else prompts)' : ''}`,
        `  roots          ${policy.roots.join(', ')}`,
        `  envAllowlist   ${policy.envAllowlist.join(', ') || '(none)'}`,
        `  maxBytes       ${policy.maxBytes}`,
        `  maxTimeoutMs   ${policy.maxTimeoutMs}`,
        '',
      ].join('\n'),
    );
    for (const warning of describePolicyWarnings(policy)) ctx.stderr.write(`${warning.message}\n`);
    return EXIT_SUCCESS;
  };
}

export const envPolicyHandler: CommandHandler = createEnvPolicyHandler({
  homedir: osHomedir(),
  uid: userInfo().uid,
  openPolicy: openPolicyFile,
});
