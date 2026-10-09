"""Copy the retained UI's transitive source closure, with an isolated alias.

Run from the repository root. The manifest records provenance; adapters in
src/retained are maintained separately and are never overwritten on rerun.
"""
from pathlib import Path
import json
import re

source = Path('apps/web/src')
target = Path('apps/imago/src/retained')
roots = [
    'components/agents/AgentsSurface.tsx',
    'components/layout/left-sidebar/AgentsSidebar.tsx',
    'components/agents/chat/AssistantSessionChat.tsx',
    'components/layout/middle-content/page-views/document/DocumentView.tsx',
    'components/layout/middle-content/page-views/code/CodePageView.tsx',
    'components/layout/middle-content/page-views/sheet/SheetView.tsx',
    'components/layout/middle-content/page-views/canvas/CanvasPageView.tsx',
    'components/layout/middle-content/page-views/file/FileViewer.tsx',
    'components/layout/middle-content/page-views/channel/ChannelView.tsx',
    'components/layout/middle-content/page-views/task-list/TaskListView.tsx',
    'components/layout/middle-content/content-header/index.tsx',
    'components/layout/left-sidebar/page-tree/PageTree.tsx',
    'components/create/QuickCreatePalette.tsx',
    'components/ai/page-agents/PageAgentSettingsTab.tsx',
    'lib/ai/shared/hooks/useAgentConfig.ts',
    'components/ai/chat/input/ChatInput.tsx',
    'components/ai/shared/chat/MessageRenderer.tsx',
    'components/ai/shared/chat/ask-user/AskUserAnswerContext.tsx',
    'lib/ai/shared/hooks/useImageAttachments.ts',
    'app/dashboard/dms/[conversationId]/page.tsx',
    'app/dashboard/dms/new/page.tsx',
    'components/layout/left-sidebar/CreateDriveDialog.tsx',
    'components/agents/chat/SessionChat.tsx',
    'components/ai/shared/DerivedStreamingRegistrations.tsx',
    'components/ui/sonner.tsx',
    'components/layout/right-sidebar/ai-assistant/SidebarActivityTab.tsx',
    'app/dashboard/drives/page.tsx',
    'app/dashboard/[driveId]/members/[userId]/page.tsx',
]
roots += [str(p.relative_to(source)) for p in (source / 'types').glob('*.d.ts')]
roots += [str(p.relative_to(target)) for p in target.rglob('*.test.tsx')]
roots += [str(p.relative_to(target)) for p in target.rglob('*.test.ts')]
roots += ['components/agents/chat/__tests__/useAgentSessionChat.test.ts', 'lib/ai/shared/hooks/__tests__/useAnswerAskUser.test.ts']
roots += ['test/setup.ts']
roots += [str(p.relative_to(source)) for p in (source / 'app/settings').rglob('page.tsx') if '__tests__' not in str(p)]
roots += [str(p.relative_to(source)) for p in (source / 'app/dashboard/[driveId]/settings').rglob('page.tsx') if '__tests__' not in str(p)]
roots += [f'app/dashboard/[driveId]/{name}/page.tsx' for name in ['calendar', 'workflows', 'activity', 'trash', 'members', 'members/invite']]
roots += [f'app/dashboard/{name}/page.tsx' for name in ['channels', 'tasks', 'calendar', 'activity', 'trash']]
roots += ['app/dashboard/connections/page.tsx', 'app/dashboard/drives/page.tsx']

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

# Remove only redundant copied modules from this isolated port.
active = {p.relative_to(source.resolve()) for p in seen} | {Path('styles/tiptap.css')}
for copied in target.rglob('*'):
    if copied.is_file() and copied.relative_to(target) not in active:
        copied.unlink()
manifest = {'sourceCommit': '0b508a34550e03a16104d50cef0e68789239e6fb', 'roots': roots, 'files': sorted(str(p.relative_to(source.resolve())) for p in seen)}
Path('docs/imago/reuse-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Inventoried {len(seen)} retained source files')
