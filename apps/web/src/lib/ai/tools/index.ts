/**
 * Barrel for the AI tool registry.
 *
 * The actual assembly lives in `../core/ai-tools.ts` (it imports every module in
 * this directory, so keeping the assembly there avoids a circular import). This
 * file is the discoverable entry point for the typed registry and canonical
 * workspace-tool count.
 */
export {
  TOOL_REGISTRY,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_COUNT,
  pageSpaceTools,
  corePageSpaceTools,
  buildPageSpaceTools,
  type PageSpaceTools,
} from '../core/ai-tools';
