/**
 * Guards the ADMIN-ONLY rollout gate for image generation at the tool-set level.
 *
 * `generate_image` must only ever reach a model through the chat/global routes'
 * explicit admin + toggle path. Every other model-callable surface that consumes the
 * `pageSpaceTools` registry (the OpenAI-compatible API, agent-to-agent consult, and
 * scheduled workflows) must strip it. This test pins the filter contract those
 * surfaces rely on, so a future edit can't silently re-expose the tool.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { filterToolsForImageGen, isImageGenTool } from '../tool-filtering';
import { shouldExposeImageGen } from '../image-gen-access';

const REPO_ROOT = resolve(__dirname, '../../../../../../..');

/** Model-callable surfaces that must NOT expose generate_image during the rollout. */
const GATED_SURFACES = [
  'apps/web/src/app/api/v1/chat/completions/route.ts',
  'apps/web/src/app/api/ai/page-agents/consult/route.ts',
  'apps/web/src/lib/workflows/workflow-executor.ts',
];

describe('image-generation exposure gate', () => {
  it('filterToolsForImageGen(tools, false) strips generate_image and nothing else', () => {
    const tools = { read_page: 'r', generate_image: 'g', web_search: 'w' };
    expect(Object.keys(filterToolsForImageGen(tools, false)).sort()).toEqual(['read_page', 'web_search']);
    expect(isImageGenTool('generate_image')).toBe(true);
  });

  it('never exposes the tool without BOTH the toggle and an app admin', () => {
    const cases = [
      { imageGenEnabled: true, isAdmin: true, hasToolDef: true },
      { imageGenEnabled: true, isAdmin: false, hasToolDef: true },
      { imageGenEnabled: false, isAdmin: true, hasToolDef: true },
      { imageGenEnabled: false, isAdmin: false, hasToolDef: true },
    ];
    expect(cases.map(shouldExposeImageGen)).toEqual([true, false, false, false]);
  });

  it.each(GATED_SURFACES)('%s strips generate_image from the registry', (file) => {
    const path = resolve(REPO_ROOT, file);
    if (!existsSync(path)) return; // isolated checkout
    const src = readFileSync(path, 'utf8');
    expect(
      src.includes('filterToolsForImageGen'),
      `${file} consumes pageSpaceTools but does not call filterToolsForImageGen — ` +
        `image generation is admin-only during rollout and must not be exposed here.`,
    ).toBe(true);
  });
});
