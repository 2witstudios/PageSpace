import { createPageServiceToken } from '@pagespace/lib/services/validated-service-token';
import type { ToolExecutionContext } from '../core/types';
import { canActorViewPage, toolActor } from './actor-permissions';
import { createProcessorCacheFetcher, type FetchPresetBytes } from './processor-file-fetch';

/**
 * A processor-backed byte fetcher for one FILE page, as the tool's actor.
 * The same pattern as apps/web/src/app/api/files/[id]/convert-to-document:
 * the centralized view check first, then a short-lived page-scoped
 * `files:read` service token the processor re-validates against the file.
 */
export function processorCacheFetcherForPage(context: ToolExecutionContext, pageId: string): FetchPresetBytes {
  return createProcessorCacheFetcher({
    canView: () => canActorViewPage(context, pageId),
    mintToken: async () => {
      const { token } = await createPageServiceToken(toolActor(context), pageId, ['files:read'], '5m');
      return token;
    },
  });
}
