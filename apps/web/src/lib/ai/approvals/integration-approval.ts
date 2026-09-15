/**
 * Which INTEGRATION tools the approval gate covers.
 *
 * `WRITE_TOOLS` names PageSpace's own tools; integration tools (GitHub, Slack,
 * Notion, webhooks) are minted per grant as `int__<provider>__<toolId>[__<conn>]`
 * and their effect class lives on the provider definition
 * (`category: 'read' | 'write' | 'admin' | 'dangerous'`). The policy gets the
 * answer as a set of NAMES so it stays free of the integrations registry; this
 * module is the one place that reads the registry for it.
 *
 * Unknown is gated: a name the registry cannot resolve (a provider this build
 * does not ship, an id that has changed) is treated as mutating. Prompting once
 * too often is recoverable; running an unknown external write is not.
 *
 * Pure over its inputs; the registry is static configuration.
 */

import { isIntegrationTool, parseIntegrationToolName } from '@pagespace/lib/integrations/converter/ai-sdk';
import { getBuiltinProvider } from '@pagespace/lib/integrations/providers/builtin-providers';

const isReadTool = (providerSlug: string, toolId: string): boolean | undefined => {
  const provider = getBuiltinProvider(providerSlug);
  if (!provider) return undefined;
  // A multi-connection name carries a trailing `__<8-char connection id>`;
  // try the exact id first, then without that suffix.
  const candidates = [toolId];
  const cut = toolId.lastIndexOf('__');
  if (cut > 0) candidates.push(toolId.slice(0, cut));
  for (const id of candidates) {
    const tool = provider.tools.find((candidate) => candidate.id === id);
    if (tool) return tool.category === 'read';
  }
  return undefined;
};

/** The integration tools among `toolNames` whose category is not `read` (or cannot be resolved). */
export function gatedIntegrationToolNames(toolNames: Iterable<string>): ReadonlySet<string> {
  const gated = new Set<string>();
  for (const name of toolNames) {
    if (!isIntegrationTool(name)) continue;
    const parsed = parseIntegrationToolName(name);
    if (!parsed) {
      gated.add(name);
      continue;
    }
    if (isReadTool(parsed.providerSlug, parsed.toolId) !== true) gated.add(name);
  }
  return gated;
}
