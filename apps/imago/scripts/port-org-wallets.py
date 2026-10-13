"""Extend retained provenance for org/wallet surfaces without overwriting or pruning existing files."""
from pathlib import Path
import json
import hashlib
import re
import subprocess

source = Path('apps/web/src')
target = Path('apps/imago/src/retained')
roots = ['components/orgs/AccountOrganizationsSection.tsx', 'app/settings/usage/wallets/page.tsx', 'app/dashboard/[driveId]/settings/wallet/page.tsx']
roots += ['components/wallets/AutomationSpendState.tsx', 'components/members/InviteJoinChoice.tsx', 'lib/drives/drive-owner-choice.ts', 'components/members/PageLinkGuestsSection.tsx', 'components/drives/OrgDriveCard.tsx', 'components/wallets/ComposerSpendStrip.tsx', 'components/wallets/SpendSurface.tsx', 'components/wallets/SpendSourcePopover.tsx', 'components/wallets/SpendRefusalCard.tsx', 'components/messages/SpendFallbackNotice.tsx', 'components/orgs/OrgSurfaceBanner.tsx']
roots += [str(p.relative_to(source)) for p in (source / 'app/orgs').rglob('page.tsx') if '__tests__' not in str(p)]
existing = {str(p.relative_to(target)) for p in target.rglob('*') if p.is_file()}
def resolve(path):
    for candidate in [path, *[Path(str(path) + ext) for ext in ['.ts', '.tsx', '.js', '.jsx', '.css', '.json']], path / 'index.ts', path / 'index.tsx']:
        if candidate.is_file():
            return candidate
    raise RuntimeError(f'Unresolved source import: {path}')

pending = [source / name for name in roots]
seen = set()
while pending:
    path = pending.pop().resolve()
    if path in seen or not path.is_relative_to(source.resolve()):
        continue
    seen.add(path)
    relative = path.relative_to(source.resolve())
    destination = target / relative
    content = destination.read_text() if destination.exists() else path.read_text()
    # Static imports, re-exports, dynamic imports and require calls.
    imports = re.findall(r'(?:from\s*|import\s*\(|require\s*\(|import\s*)[\'\"]([^\'\"]+)[\'\"]', content)
    for name in imports:
        if name.startswith('@/retained-adapters/') or name.startswith('@/ui/') or name.startswith('@/api/') or name.startswith('@/lib/theme/'):
            continue
        if name.startswith('@/retained/'):
            pending.append(resolve(source / name[len('@/retained/'):]))
        elif name.startswith('@/') and not destination.exists():
            pending.append(resolve(source / name[2:]))
        elif name.startswith('.'):
            pending.append(resolve(path.parent / name))
    relative = path.relative_to(source.resolve())
    destination = target / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        content = content.replace('@/','@/retained/')
        for old, new in [('next/navigation', '@/retained-adapters/navigation'), ('next/link', '@/retained-adapters/link'), ('next-themes', '@/retained-adapters/theme')]:
            content = content.replace(f"from '{old}'", f"from '{new}'").replace(f'from "{old}"', f'from "{new}"')
        destination.write_text(content)


manifest_path = Path('docs/imago/reuse-source-manifest.json')
manifest = json.loads(manifest_path.read_text())
manifest['roots'] = sorted(set(manifest['roots']) | set(roots))
manifest['files'] = sorted(set(manifest['files']) | {str(p.relative_to(source.resolve())) for p in seen})
new_files = sorted(str(p.relative_to(source.resolve())) for p in seen if str(p.relative_to(source.resolve())) not in existing)
if new_files:
    manifest.setdefault('extensions', []).append({'sourceHashes': {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in new_files}, 'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'roots': roots, 'files': new_files})
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Added {len(new_files)} retained org/wallet files')
