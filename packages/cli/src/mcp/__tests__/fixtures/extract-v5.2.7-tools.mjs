// Regenerates v5.2.7-tools.json — see README.md in this directory for the
// full derivation story. Run from anywhere with:
//
//   bun run packages/cli/src/mcp/__tests__/fixtures/extract-v5.2.7-tools.mjs \
//     /path/to/pagespace-mcp/src/tools.js > v5.2.7-tools.json
//
// The input file must be `src/tools.js` checked out AT commit
// `494204446bd1b87cdcfe0323795ee220e3566ecf` of
// https://github.com/2witstudios/pagespace-mcp — that repo's final,
// deprecated 5.2.7 release ("chore: final deprecated release (5.2.7) —
// point at @pagespace/cli"), which has no git tag (the repo's only tags are
// v4.0.1 and v5.2.2), so the commit SHA itself is the immutable pin (or any
// working tree pinned there via
// `git show 494204446bd1b87cdcfe0323795ee220e3566ecf:src/tools.js > tools.js`).
//
// This does NOT import the old repo at runtime for the parity test itself;
// it is a one-time (or re-run-on-demand) generator whose output is the
// committed, auditable fixture the test actually reads.
const toolsPath = process.argv[2];
if (!toolsPath) {
  console.error('Usage: bun run extract-v5.2.7-tools.mjs <path-to-v5.2.7-tools.js>');
  process.exit(1);
}
const { tools } = await import(toolsPath);

const extracted = tools.map((tool) => ({
  name: tool.name,
  required: tool.inputSchema.required ?? [],
}));

console.log(JSON.stringify(extracted, null, 2));
