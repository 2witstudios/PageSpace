/**
 * Exit-gate preflight (Local Environments epic, M1 · t10).
 *
 * The M1 exit gate needs a running app, a real Postgres, a built CLI and a
 * terminal. Every one of the conditions below has cost this repo a wasted run
 * before, so this refuses LOUDLY and by name rather than letting the gate fail
 * later with a symptom three layers from its cause:
 *
 *   F01 the app answers at all
 *   F02 LOCAL_ENVS_ENABLED=true              (`GET /api/env-bridge/token` with no
 *                                             enrollmentId: 400 when the flag is on,
 *                                             404 when the route does not exist)
 *   F03 ENV_BRIDGE_SIGNING_KEY is loaded     (the app boots refusing to start without it
 *                                             when the flag is on — t06 commit 5 — so F02
 *                                             passing is the proof; recorded separately
 *                                             because an operator who sees only F02 will
 *                                             not know that)
 *   F04 the CLI under test is the BUILT one  (`node packages/cli/dist/bin.js --version`,
 *                                             never `bun run src/…`: t08 found `env enroll`
 *                                             broken in the real binary while its unit
 *                                             tests passed — memory `reference_cli_handlers_get_rest_args`)
 *   F05 a TTY on stdin                       (`ask` mode refuses to start without one)
 *   F06 TZ=UTC in this shell                 (sessions revoke instantly against a non-UTC
 *                                             app/pg pair — memory `reference_running_web_app_locally`)
 *   F07 DEPLOYMENT_MODE is set               (onprem for a local run; `cloud` pulls in
 *                                             integrations this gate does not need)
 *   F08 an S3 endpoint is configured         (page/drive creation 500s on
 *                                             CredentialsProviderError without one, and
 *                                             step 3 needs a drive with a pane in it)
 *   F09 the machine policy file is loadable  (`pagespace env policy` agrees with what the
 *                                             operator thinks is in force)
 *
 * F06–F08 are read from the ENVIRONMENT OF THE APP, which this script cannot
 * see, so they are checked against the operator-supplied `PAGESPACE_GATE_*`
 * mirrors: the point is to make the operator state them, not to prove them.
 *
 * Usage:  bun scripts/env-bridge-exit-gate/preflight.ts
 */
import { execFileSync } from 'node:child_process';
import { expect, failed, optional, required, summarize } from './report.ts';

const host = required('PAGESPACE_GATE_HOST'); // e.g. http://127.0.0.1:3000
const cliBin = required('PAGESPACE_GATE_CLI'); // e.g. ./packages/cli/dist/bin.js

async function status(url: string, init?: RequestInit): Promise<{ code: number; body: string }> {
  const response = await fetch(url, init);
  return { code: response.status, body: (await response.text()).slice(0, 400) };
}

function run(args: readonly string[]): string {
  const prefix = optional('PAGESPACE_GATE_CLI_EXEC');
  const [command, ...lead] = prefix === null ? [process.execPath] : prefix.split(/\s+/);
  const machineBin = optional('PAGESPACE_GATE_MACHINE_CLI') ?? cliBin;
  const argv = prefix === null ? [cliBin, ...args] : [...lead, machineBin, ...args];
  return execFileSync(command as string, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Same, but a non-zero exit is DATA: `env policy` exits 1 when the policy is deny-all. */
function runAllowFail(args: readonly string[]): string {
  try {
    return run(args);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

async function main(): Promise<number> {
  // F01 — the app is up. Anything that answers is enough; the point is to fail
  // here rather than inside a WebSocket handshake ten minutes later.
  try {
    const health = await status(`${host}/api/env-bridge/token`);
    expect('F01', true, health.code > 0, `app answered at ${host}`);
    // F02 — no enrollmentId: 400 means the handler ran (flag ON); 404 means the
    // route refused before parsing (flag OFF). Pins
    // apps/web/src/app/api/env-bridge/token/route.ts GET, lines 71-75.
    expect('F02', 400, health.code, 'LOCAL_ENVS_ENABLED=true (404 here = the flag is off)');
    // F03 — the app refuses to boot with the flag on and no signing key
    // (apps/web env validation, t06 review round 1), so a live 400 above is
    // the only proof available from outside the process.
    expect('F03', 400, health.code, 'ENV_BRIDGE_SIGNING_KEY loaded — implied by a booted app with the flag on');
  } catch (error) {
    failed('F01', 'app reachable', error, `is the web app running at ${host}?`);
    return summarize('preflight');
  }

  // F04 — the BUILT CLI, not the sources. A gate run against `bun src/bin.ts`
  // proves nothing about what a user installs.
  try {
    const version = run(['--version']).trim();
    expect('F04', true, version.length > 0 && cliBin.includes('dist'), `built CLI at ${cliBin} reports ${version}`);
  } catch (error) {
    failed('F04', 'built CLI runs', error, 'run `bun run --filter @pagespace/cli build` first');
  }

  // F05 — where `ask` will ask. This USED to assert a TTY, because `env connect`
  // refused to start in `ask` mode without one. GA wave 2 removed that refusal:
  // with no terminal (or with PAGESPACE_ENV_ASK=chat) the daemon freezes each
  // request under a challenge id, answers `ask_pending:<id>`, and the owner
  // answers with a click in the PageSpace chat. Headless is the GA path, so a
  // TTY is no longer a precondition — but the operator must know which
  // prompter the run is exercising, because they are different code.
  const askMode = optional('PAGESPACE_GATE_ASK_MODE');
  expect('F05', true, askMode === 'chat' || askMode === 'terminal', 'set PAGESPACE_GATE_ASK_MODE=chat (headless, the GA path) or =terminal (a TTY prompter)');
  if (askMode === 'terminal') expect('F05b', true, process.stdin.isTTY === true, 'a terminal run needs a TTY on stdin');

  // F06 — this shell. The app's own TZ and Postgres' TZ are the operator's to confirm.
  expect('F06', 'UTC', process.env.TZ ?? '(unset)', 'TZ=UTC in this shell; confirm the same for the app process AND Postgres');
  expect('F06b', 'UTC', optional('PAGESPACE_GATE_APP_TZ') ?? '(unset)', 'operator-asserted TZ of the app + pg processes');

  // F07 / F08 — asserted, not probed: this script is outside the app process.
  // F07 — which deployment mode the run is in, stated. It used to demand
  // `onprem`, which keeps external integrations out of the way; but the
  // release target for this feature is CLOUD, and cloud is the mode whose
  // billing, tier and credit gates sit in front of every step the gate drives.
  // A gate that can only run in the mode we are not shipping proves less, so
  // both are accepted and the operator has to say which.
  const mode = optional('PAGESPACE_GATE_DEPLOYMENT_MODE') ?? '(unset)';
  expect('F07', true, mode === 'cloud' || mode === 'onprem' || mode === 'tenant', `operator-asserted DEPLOYMENT_MODE of the app: ${mode}`);
  expect('F08', true, optional('PAGESPACE_GATE_S3_ENDPOINT') !== null, 'operator-asserted S3 endpoint; without one, drive/page creation 500s');

  // F09 — the policy the daemon will actually enforce, printed by the CLI
  // itself. `PAGESPACE_GATE_CLI_EXEC` runs it ON THE MACHINE: if the daemon is
  // not on the operator's own computer, a policy read here describes a
  // different machine and F09 is worse than no check at all.
  try {
    const policy = runAllowFail(['env', 'policy', '--json']);
    const parsed: unknown = JSON.parse(policy);
    const inForce = typeof parsed === 'object' && parsed !== null && 'policy' in parsed && (parsed as { policy: unknown }).policy !== null;
    expect('F09', true, inForce, 'a policy file is in force (deny-all otherwise; see README "The policy file")');
    process.stdout.write(`POLICY ${policy.replace(/\s+/g, ' ').trim()}\n`);
  } catch (error) {
    failed('F09', 'policy loads', error, 'run `pagespace env policy` and fix what it reports');
  }

  return summarize('preflight');
}

main().then((code) => process.exit(code));
