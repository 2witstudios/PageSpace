import { readFile, writeFile } from 'node:fs/promises';
const classic = new URL('../../web/src/lib/ai/tools/', import.meta.url);
const coreSource = await readFile(new URL('sandbox-tools.ts', classic), 'utf8');
const core = coreSource.match(/export const SANDBOX_CORE_TOOL_NAMES: readonly string\[\] = (\[[^;]+\]);/);
if (!core) throw new Error('Classic tool-name declaration changed');
const coreNames: string[] = JSON.parse(core[1].replaceAll("'", '"'));
const registry = await readFile(new URL('sandbox-git/tools/registry.ts', classic), 'utf8');
const groups = [...registry.matchAll(/import \{ \w+_TOOL_ROWS \} from '\.\/([^']+)';/g)].map(match => match[1]);
if (groups.length === 0) throw new Error('Classic tool registry changed');
const gitNames: string[] = [];
for (const group of groups) {
  const source = await readFile(new URL(`sandbox-git/tools/${group}.ts`, classic), 'utf8');
  const names = [...source.matchAll(/key:\s*'([^']+)'/g)].map(match => match[1]);
  if (names.length === 0) throw new Error(`Non-literal tool group: ${group}`);
  gitNames.push(...names);
}
// UI filtering needs names, never executors or their server dependencies.
await writeFile(new URL('../src/retained-adapters/tool-metadata.ts', import.meta.url),
  `/** Generated from classic tool registries by build-tool-metadata.ts. */\nexport const SANDBOX_CORE_TOOL_NAMES: readonly string[] = ${JSON.stringify(coreNames)};\nexport const SANDBOX_GIT_TOOL_NAMES: readonly string[] = ${JSON.stringify(gitNames)};\n`);
