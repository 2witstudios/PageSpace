import { it } from 'vitest';
import fs from 'node:fs';
import { listSourceFiles } from '../walk';
import { scanFile } from '../access-gate-scan';
it('dump', () => {
  const files = listSourceFiles(['apps', 'packages']).filter((f) => !f.startsWith('packages/db/') && !f.startsWith('apps/e2e/') && !f.startsWith('packages/lib/src/permissions/'));
  const out: string[] = [];
  const groups = new Map<string, string[]>();
  for (const f of files) for (const s of scanFile(f)) {
    const k = `${s.file} › ${s.anchor}`;
    groups.set(k, [...(groups.get(k) ?? []), `  ${s.line} [${s.kind === 'drive_members read' ? 'R' : 'O'}] ${s.text.slice(0, 150)}`]);
  }
  for (const [k, v] of [...groups].sort()) out.push(k, ...v);
  fs.writeFileSync(process.env.DUMP_OUT as string, out.join('\n'));
});
