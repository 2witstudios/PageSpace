import 'server-only';

import { audit } from '@pagespace/lib/audit/audit-log';
import { gateAvatarUpload, type AvatarGateDeps, type AvatarGateResult } from '@pagespace/lib/content-safety/avatar-gate';
import { errorLabel } from '@pagespace/lib/content-safety/publish-gate';
import { resolveScanConfigFromEnv, type ScanGateConfig } from '@pagespace/lib/content-safety/scan-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createPublishGateDeps, runHashMatchTakedown, stageBytesForTakedown } from './publish-gate-service';

/**
 * The avatar gate with its real dependencies, run for the processor by
 * `POST /api/internal/content-safety/avatar-gate`. Everything is the publish
 * gate's (blocklist, verdicts, Hive, review queue, alerts, audit), except:
 *
 * - **A hash match** first writes the bytes to `files/<hash>/original`, so the
 *   global takedown has something to preserve to evidence (the upload is
 *   refused, so they would otherwise exist nowhere), then runs the takedown.
 *   If the staging write fails, the takedown still runs: the block matters more
 *   than the copy, and the failure is logged.
 * - **A refusal** is audited as `content.avatar.rejected`.
 */
export function createAvatarGateDeps(bytes: Uint8Array, config: ScanGateConfig = resolveScanConfigFromEnv()): AvatarGateDeps {
  // The gate reads the bytes in hand, so the private-bucket reader is replaced by avatar-gate.ts.
  const base = createPublishGateDeps(config, {
    async takedownHashMatch({ contentHash, lists }) {
      await stageBytesForTakedown(contentHash, bytes).catch((error: unknown) =>
        loggers.security.error('Avatar gate: could not stage a hash-matched avatar for preservation', undefined, { error: errorLabel(error) }),
      );
      return runHashMatchTakedown({ contentHash, lists, source: 'an avatar upload scan' });
    },
  });
  return {
    ...base,
    auditRejected(event) {
      audit({
        eventType: 'content.avatar.rejected',
        userId: event.userId,
        resourceType: 'avatar',
        resourceId: event.contentHash,
        details: { reason: event.reason, finding: event.finding, mode: event.mode },
        riskScore: event.reason === 'not_an_image' ? 0.2 : event.finding === 'hash_match' || event.reason === 'blocked' ? 1 : 0.6,
      });
    },
  };
}

/** Gate one avatar. A gate that fails unexpectedly refuses: "couldn't check" is never "allowed". */
export async function gateAvatarBytes(bytes: Uint8Array, userId: string, deps: AvatarGateDeps = createAvatarGateDeps(bytes)): Promise<AvatarGateResult | { accept: false; reason: 'error' }> {
  try {
    return await gateAvatarUpload({ bytes, userId }, deps);
  } catch (error) {
    loggers.security.error('Avatar gate failed; the upload is refused', undefined, { error: errorLabel(error) });
    return { accept: false, reason: 'error' };
  }
}
