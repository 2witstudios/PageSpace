// Measures what importing the CLI route table costs, and whether the
// env-bridge core is in that graph at all.
const t0 = performance.now();
await import('./dist/router/routes.js');
const t1 = performance.now();
const loaded = [...new Set(Object.keys(await import('node:module').then(m => m.builtinModules)))]; // placeholder
console.log(`routes.js import: ${(t1 - t0).toFixed(1)} ms`);
