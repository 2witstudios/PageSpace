/**
 * One guard for every tool whose results carry images or files, applied where a
 * turn assembles its tools. A result saved on an earlier turn is re-converted for
 * this turn's model by its tool's toModelOutput; when this model can't take the
 * media (no vision, or a provider whose SDK would send tool-result media as
 * base64 text), the bytes are stripped before they go anywhere.
 *
 * Pass getToolMediaCapabilities for the turn's model and provider: the same
 * source as the tool context, so tools and guard never disagree.
 */
import type { Tool } from 'ai';
import { canReceiveToolResultImages, type ToolMediaCapabilities } from '../core/vision-models';
import { guardReadPageToolForVision } from './read-page-vision-output';
import { degradeBrowserScreenshot, toModelOutputForBrowserScreenshot } from './browser-tools';

type ToolModelOutputFn = NonNullable<Tool['toModelOutput']>;

function guardBrowserScreenshotTool<T extends { toModelOutput?: ToolModelOutputFn }>(tool: T, capabilities: ToolMediaCapabilities): T {
  if (canReceiveToolResultImages(capabilities)) return tool;
  const toModelOutput: ToolModelOutputFn = ({ output }) => toModelOutputForBrowserScreenshot(degradeBrowserScreenshot(output));
  return { ...tool, toModelOutput } as T;
}

export function guardToolResultMedia<T extends Record<string, unknown>>(tools: T, capabilities: ToolMediaCapabilities): T {
  const guarded: Record<string, unknown> = { ...tools };
  if (tools.read_page) guarded.read_page = guardReadPageToolForVision(tools.read_page as Tool, capabilities);
  if (tools.browser_screenshot) guarded.browser_screenshot = guardBrowserScreenshotTool(tools.browser_screenshot as Tool, capabilities);
  return guarded as T;
}
