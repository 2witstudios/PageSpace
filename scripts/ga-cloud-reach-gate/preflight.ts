/**
 * Fixture preflight for the cloud-reach exit gate.
 *
 * Asserts that `seed-gate.ts` produces the AUTHORIZATION answers every row
 * depends on, by asking `canRunCode` directly — the authority the cloud arm is
 * keyed on. It is NOT the gate: it proves the fixture, so a contended
 * production build slot is never spent discovering that drive V was seeded as
 * an editor and row 3 was passing for the wrong reason.
 *
 * The M1 gate's standing lesson is that a check which passes because nothing
 * was there is worse than no check. This is the cheap guard against that.
 *
 *   DATABASE_URL=… TZ=UTC CODE_EXECUTION_ENABLED=true \
 *     bun scripts/ga-cloud-reach-gate/preflight.ts <seed-output.json>
 */
import { readFileSync } from 'node:fs';
import { canRunCode } from '../../packages/lib/src/services/sandbox/can-run-code';
import { expect as gateExpect, summarize } from '../env-bridge-exit-gate/report';

interface SeedDrive { driveId: string; envId: string; envName: string }
interface Seed { u: { userId: string; tier: string }; p: SeedDrive; v: SeedDrive; x: SeedDrive }

/**
 * The EXACT verdict each drive must produce — never a category. The harness's
 * rule (`report.ts`) is that `expected` is the precise denial reason, because
 * "refused" would pass on the wrong refusal and hide a fixture that is failing
 * earlier than the row intends: `drive_access_denied` from an unaccepted
 * invite looks like a pass to a category assertion while proving nothing about
 * the permission under test.
 */
const EXPECTATIONS = [
  ['p', 'ok', 'U edits a PAID drive on a free tier — the founder case, and the one production broke'],
  ['v', 'insufficient_role', 'U is bounded view-only by a custom role — NOT no_drive_access, which would mean the membership row is wrong'],
  ['x', 'no_drive_access', 'U is not a member at all — NOT insufficient_role, which would mean a stray membership row exists'],
] as const;

async function main() {
  const seed = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Seed;

  // The tier itself is load-bearing: a pro-tier U would pass every row while
  // proving nothing about the case the ruling exists for.
  gateExpect('FX00', 'free', seed.u.tier, "U's OWN tier must be sandbox-ineligible, or the gate proves nothing");

  for (const [key, expected, note] of EXPECTATIONS) {
    const drive = seed[key];
    const verdict = await canRunCode({ userId: seed.u.userId, driveId: drive.driveId, requestOrigin: 'user' });
    gateExpect(`FX-${drive.envName}`, expected, verdict.ok ? 'ok' : verdict.reason, note);
  }

  process.exit(summarize('cloud-reach fixture'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
