import { createPageServiceToken } from '@pagespace/lib/services/validated-service-token';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import type { ToolExecutionContext } from '../core/types';
import { canActorViewPage, toolActor } from './actor-permissions';
import { createProcessorCacheFetcher, type FetchPresetBytes } from './processor-file-fetch';

/**
 * A processor-backed byte fetcher for one FILE page, or null when the bytes
 * cannot be read for this tool call.
 *
 * The same pattern as apps/web/src/app/api/files/[id]/convert-to-document: the
 * centralized permission checks first, then a short-lived page-scoped
 * `files:read` service token the processor re-validates against the file.
 *
 * Two checks, because two principals are involved:
 * - canActorViewPage: the principal the tool runs as. For a page agent that is
 *   the agent, which can reach a page through its own drive membership.
 * - getUserAccessLevel for the person (or automation) driving the turn: the
 *   service token is minted for them and the processor checks them again
 *   (createValidatedServiceToken, apps/processor authorizeFileAccess). Service
 *   tokens carry no agent principal, so when only the agent can view the page
 *   the processor would refuse, and nothing is minted.
 */
export async function fileBytesFetcherFor(
  context: ToolExecutionContext,
  pageId: string,
): Promise<FetchPresetBytes | null> {
  if (!(await canActorViewPage(context, pageId))) return null;
  const driverAccess = await getUserAccessLevel(toolActor(context), pageId);
  if (!driverAccess?.canView) return null;

  return createProcessorCacheFetcher({
    // Both checks above just passed for this call.
    canView: async () => true,
    mintToken: async () => {
      const { token } = await createPageServiceToken(toolActor(context), pageId, ['files:read'], '5m');
      return token;
    },
  });
}
