/**
 * Public entry point for the AI tool registry (issue #1055).
 *
 * Only the registry/count surface is exported here — this is the discoverable home
 * the issue asked for. The tool *set* itself (`pageSpaceTools`, `buildPageSpaceTools`,
 * etc.) is NOT re-exported: it already has an established home at `../core/ai-tools`,
 * and every runtime consumer imports it from there. Re-exporting it would just create
 * a second import path for the same symbols.
 *
 * (The registry is defined in `../core/ai-tools` rather than here because that module
 * imports every tool module in this directory; defining it here would be circular.)
 */
export {
  TOOL_REGISTRY,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_COUNT,
} from '../core/ai-tools';
