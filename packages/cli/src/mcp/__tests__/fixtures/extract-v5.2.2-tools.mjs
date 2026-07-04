// Regenerates v5.2.2-tools.json — see README.md in this directory for the
// full derivation story. Run from anywhere with:
//
//   bun run packages/cli/src/mcp/__tests__/fixtures/extract-v5.2.2-tools.mjs \
//     /path/to/pagespace-mcp/src/tools.js > v5.2.2-tools.json
//
// The input file must be `src/tools.js` checked out AT the `v5.2.2` git tag
// of https://github.com/2witstudios/pagespace-mcp (or any working tree
// pinned there via `git show v5.2.2:src/tools.js > tools.js`) — never the
// tool's current HEAD, which has moved on since (see README.md).
//
// This does NOT import the old repo at runtime for the parity test itself;
// it is a one-time (or re-run-on-demand) generator whose output is the
// committed, auditable fixture the test actually reads.
const toolsPath = process.argv[2];
if (!toolsPath) {
  console.error('Usage: bun run extract-v5.2.2-tools.mjs <path-to-v5.2.2-tools.js>');
  process.exit(1);
}
const { tools } = await import(toolsPath);

const extracted = tools.map((tool) => ({
  name: tool.name,
  required: tool.inputSchema.required ?? [],
}));

console.log(JSON.stringify(extracted, null, 2));
